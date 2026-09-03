'use client'

import { useRef, useState, type DragEvent } from 'react'
import { Film, Clapperboard, Loader2, CheckCircle2 } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'

interface Props {
  scan: Scan | null
  /** The dashboard's selected scan id — null means "new scan", so a fresh scan must be created on upload. */
  selectedScanId: string | null
  onScanCreated: (id: string) => void
  refresh: () => void
}

type Kind = 'short' | 'movie'

/** Info shown the INSTANT a file is picked — read locally in the browser, no
 *  server round-trip. Replaced by the server's data once the upload lands. */
interface LocalPick {
  name: string
  size: number
  /** Duration read from the browser's video decoder; null while loading /
   *  when the container can't be parsed client-side (e.g. some MKVs). */
  duration: number | null
}

const ALLOWED_EXT = ['.mp4', '.mov', '.mkv', '.webm']
function isAllowedVideo(f: File) {
  const name = f.name.toLowerCase()
  return ALLOWED_EXT.some((ext) => name.endsWith(ext))
}

/** Read the video's duration in the browser (usually < 100 ms — it only parses
 *  the header, never the whole file). Resolves null if the browser can't. */
function readLocalDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.preload = 'metadata'
    let settled = false
    const finish = (d: number | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      v.removeAttribute('src')
      v.load()
      resolve(d)
    }
    v.onloadedmetadata = () => finish(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null)
    v.onerror = () => finish(null)
    setTimeout(() => finish(null), 8000)
    v.src = url
  })
}

// ---- The ONLY upload path: browser → app server (EC2) → EBS disk.
// The video is sliced into CHUNK_BYTES pieces and PARALLEL of them are on the
// wire at once. Each chunk is written at its byte offset on the server, so
// order does not matter and a lost chunk is simply re-sent. ffprobe starts the
// instant the last byte lands; the S3 backup happens in the background.
//
// Resume: the upload session id is a fingerprint of the file (name + size +
// lastModified). Before sending, the browser asks the server which byte
// ranges it already has and only sends the rest — so a page refresh mid-way
// through a 4 GB movie picks up where it left off.
//
// Speed meter: sampled on a fixed clock over a 10 s window + EMA, and the bar
// glides at that rate — one steady number instead of bursts and freezes.
const DEFAULT_CHUNK_MB = 16
const CHUNK_BYTES = Math.max(1, Number.parseInt(process.env.NEXT_PUBLIC_UPLOAD_CHUNK_MB || '', 10) || DEFAULT_CHUNK_MB) * 1024 * 1024
/** Chunks in flight at all times. */
const PARALLEL = Math.max(1, Number.parseInt(process.env.NEXT_PUBLIC_UPLOAD_PARALLEL || '', 10) || 8)
/** A chunk that accepts NO new bytes for this long is aborted and re-sent.
 *  Measured on upload progress, so a slow-but-moving chunk is never killed. */
const CHUNK_TIMEOUT_MS = 45_000
const MAX_ATTEMPTS = 8

function fileFingerprint(file: File): string {
  // Stable across page reloads for the same file on the same machine.
  let h = 0
  const s = `${file.name}|${file.size}|${file.lastModified}`
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}${file.size.toString(36)}`
}

export function UploadPanel({ scan, selectedScanId, onScanCreated, refresh }: Props) {
  const [uploading, setUploading] = useState<Kind | null>(null)
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState<number | null>(null)
  /** Chunks currently on the wire. */
  const [inFlight, setInFlight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<Partial<Record<Kind, LocalPick>>>({})
  const scanIdRef = useRef<string | null>(selectedScanId)
  // Follow the dashboard's selection: when the user picks "New scan" (null) or
  // another history entry, drop any stale id so uploads never land in an old scan.
  const prevSelectedRef = useRef<string | null>(selectedScanId)
  if (prevSelectedRef.current !== selectedScanId) {
    prevSelectedRef.current = selectedScanId
    // When the dashboard switches to a scan OTHER than the one we are
    // uploading into (e.g. user clicked history / "New scan"), the local picks
    // belong to the old scan — clear them. A switch to our own freshly created
    // scan id (from ensureScan → onScanCreated) keeps them.
    if (selectedScanId !== scanIdRef.current) {
      scanIdRef.current = selectedScanId
      if (Object.keys(local).length) setLocal({})
    }
  }

  async function ensureScan(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current
    const res = await fetch('/api/scans', { method: 'POST' })
    const j = await res.json()
    scanIdRef.current = j.id
    onScanCreated(j.id)
    return j.id
  }

  /**
   * Parallel, resumable chunked upload to the app server. Resolves when the
   * server confirmed the assembled file + ffprobe finalize. Throws on failure.
   */
  async function uploadChunkedToServer(id: string, kind: Kind, file: File): Promise<void> {
    const session = fileFingerprint(file)
    const base = `/api/scans/${id}/upload?kind=${kind}&name=${encodeURIComponent(file.name)}&total=${file.size}&session=${session}`
    const videoType = file.type || 'video/mp4'

    // ---- Resume: ask the server which byte ranges already landed.
    let have: Array<[number, number]> = []
    try {
      const r = await fetch(base, { method: 'GET' })
      if (r.ok) {
        const j = (await r.json()) as { ranges?: Array<[number, number]> }
        if (Array.isArray(j.ranges)) have = j.ranges
      }
    } catch {
      // fresh upload
    }
    const isCovered = (s: number, e: number) => have.some(([rs, re]) => rs <= s && re >= e)

    const offsets: number[] = []
    let committed = 0
    for (let o = 0; o < file.size; o += CHUNK_BYTES) {
      const end = Math.min(o + CHUNK_BYTES, file.size)
      if (isCovered(o, end)) committed += end - o
      else offsets.push(o)
    }
    if (committed > 0) console.log(`[upload] resuming ${kind}: ${committed} of ${file.size} bytes already on the server`)

    // ---- Byte accounting.
    // `committed` = bytes the server has confirmed. `inflight[i]` = bytes the
    // browser has pushed onto the wire for chunk i (from XHR upload progress).
    const inflight = new Float64Array(offsets.length + 1)
    const wireBytes = () => {
      let n = committed
      for (let i = 0; i < inflight.length; i++) n += inflight[i]
      return n
    }

    let done = false
    let failed: Error | null = null
    let next = 0
    let active = 0

    // ---- ONE steady speed number (acked + wire bytes, 10 s window, EMA).
    const startedAt = performance.now()
    const startBytes = committed
    const samples: { t: number; n: number }[] = [{ t: startedAt, n: startBytes }]
    let smoothed: number | null = null
    let shown = committed
    let lastTick = startedAt
    const rate0 = (n: number, now: number) => (now - startedAt > 500 ? (n - startBytes) / ((now - startedAt) / 1000) : 0)
    const tick = () => {
      const now = performance.now()
      const n = wireBytes()
      samples.push({ t: now, n })
      while (samples.length > 2 && now - samples[0].t > 10_000) samples.shift()
      const dt = (now - samples[0].t) / 1000
      if (dt >= 1.5) {
        const rate = Math.max(0, (n - samples[0].n) / dt)
        smoothed = smoothed === null ? rate : smoothed * 0.8 + rate * 0.2
        setSpeed(smoothed)
      }
      const step = ((smoothed ?? rate0(n, now)) * 1.15 * (now - lastTick)) / 1000
      lastTick = now
      shown = Math.min(Math.max(shown, committed), Math.max(shown + step, committed), n, file.size)
      // Cap at 99 — server-side ffprobe finishing is the real 100%.
      setProgress(Math.min(99, Math.floor((shown / file.size) * 100)))
      setInFlight(active)
    }
    const reporter = setInterval(tick, 250)

    function postChunk(offset: number, index: number, piece: Blob): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        let lastProgressAt = performance.now()
        const watchdog = setInterval(() => {
          if (performance.now() - lastProgressAt > CHUNK_TIMEOUT_MS) xhr.abort()
        }, 1000)
        xhr.open('POST', `${base}&offset=${offset}`)
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.setRequestHeader('x-video-type', videoType)
        xhr.upload.onprogress = (e) => {
          const loaded = Math.min(e.loaded, piece.size)
          if (loaded > inflight[index]) lastProgressAt = performance.now()
          inflight[index] = loaded
        }
        const finish = () => clearInterval(watchdog)
        xhr.onload = () => {
          finish()
          resolve({ status: xhr.status, body: xhr.responseText })
        }
        xhr.onerror = () => {
          finish()
          reject(new TypeError('network error'))
        }
        xhr.onabort = () => {
          finish()
          reject(new DOMException('stalled', 'AbortError'))
        }
        xhr.send(piece)
      })
    }

    async function sendChunk(offset: number, index: number, countBytes = true) {
      const piece = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size))
      let lastErr: Error | null = null
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Exponential backoff with jitter: 0.6s, 1.2s, 2.4s ... capped at 10s.
        if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(10_000, 600 * 2 ** (attempt - 1)) + Math.random() * 300))
        inflight[index] = 0
        try {
          const res = await postChunk(offset, index, piece)
          if (res.status >= 200 && res.status < 300) {
            let j: { done?: boolean } = {}
            try {
              j = JSON.parse(res.body) as { done?: boolean }
            } catch {
              // keep default
            }
            if (j.done) done = true
            inflight[index] = 0
            if (countBytes) committed += piece.size
            return
          }
          let msg = 'Upload failed. Please try again.'
          try {
            msg = (JSON.parse(res.body) as { error?: string }).error || msg
          } catch {
            // keep default
          }
          // Bad-request errors won't fix themselves — stop retrying.
          if (res.status >= 400 && res.status < 500) throw new Error(msg)
          lastErr = new Error(msg)
        } catch (err) {
          inflight[index] = 0
          if (err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError')) {
            lastErr = new Error('Upload failed — network error. Please try again.')
          } else {
            throw err
          }
        }
      }
      throw lastErr ?? new Error('Upload failed. Please try again.')
    }

    // Worker pool: PARALLEL chunks in flight at all times.
    async function worker() {
      active++
      try {
        while (!failed) {
          const i = next++
          if (i >= offsets.length) return
          try {
            await sendChunk(offsets[i], i)
          } catch (err) {
            failed = err instanceof Error ? err : new Error('Upload failed. Please try again.')
            return
          }
        }
      } finally {
        active--
      }
    }
    try {
      const workers: Promise<void>[] = []
      for (let w = 0; w < Math.min(PARALLEL, offsets.length); w++) {
        workers.push(worker())
        // Stagger launches so chunks finish OUT OF PHASE.
        if (w < PARALLEL - 1) await new Promise((r) => setTimeout(r, 400))
      }
      await Promise.all(workers)

      const failure = failed as Error | null
      if (failure) throw failure
      if (!done) {
        // Every chunk accepted but no request saw full coverage (e.g. the
        // resume probe said everything was already there). Re-send the last
        // chunk so the server re-checks coverage and finalizes.
        const lastOffset = Math.floor((file.size - 1) / CHUNK_BYTES) * CHUNK_BYTES
        await sendChunk(lastOffset, offsets.length, false)
        if (!done) throw new Error('Upload finished but the server did not confirm the file. Please try again.')
      }
    } finally {
      clearInterval(reporter)
      setInFlight(0)
    }
  }

  function uploadFile(kind: Kind, file: File) {
    if (!isAllowedVideo(file)) {
      setError('Only MP4, MOV, MKV or WebM video files are supported')
      return
    }
    setError(null)
    setUploading(kind)
    setProgress(0)
    setSpeed(null)
    setInFlight(0)

    // 1) INSTANT: show the file in the card right away from local metadata.
    setLocal((prev) => ({ ...prev, [kind]: { name: file.name, size: file.size, duration: null } }))
    void readLocalDuration(file).then((d) => {
      setLocal((prev) => (prev[kind]?.name === file.name ? { ...prev, [kind]: { ...prev[kind]!, duration: d } } : prev))
    })

    // 2) BACKGROUND upload.
    void (async () => {
      try {
        const id = await ensureScan()
        await uploadChunkedToServer(id, kind, file)

        setProgress(100)
        setUploading(null)
        setSpeed(null)
        setInFlight(0)
        setError(null)
        refresh()
      } catch (err) {
        setUploading(null)
        setSpeed(null)
        setLocal((prev) => {
          const copy = { ...prev }
          delete copy[kind]
          return copy
        })
        setError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
        refresh()
      }
    })()
  }

  const chunking = scan?.status === 'chunking'

  // Prefer the server's confirmed data; fall back to the instant local pick.
  const shortLocal = local.short
  const movieLocal = local.movie
  const shortServer = Boolean(scan?.shortName && scan?.shortDuration)
  const movieServer = Boolean(scan?.movieName && scan?.movieDuration)

  return (
    <section aria-label="Upload videos" className="panel">
      <h2 className="text-sm font-semibold">Source Files</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Dropzone
          kind="short"
          icon={<Film className="size-5" aria-hidden />}
          title="Short video"
          subtitle="The clip to find — any length, scanned minute-by-minute (original quality preserved)"
          name={shortServer ? scan?.shortName : shortLocal?.name}
          duration={shortServer ? scan?.shortDuration : shortLocal?.duration}
          size={shortServer ? scan?.shortSize : shortLocal?.size}
          uploading={uploading === 'short'}
          progress={progress}
          speed={uploading === 'short' ? speed : null}
          inFlight={uploading === 'short' ? inFlight : 0}
          disabled={uploading !== null}
          onFile={(f) => uploadFile('short', f)}
          extraInfo={
            scan?.shortSegments && scan.shortSegments.length > 1
              ? `${scan.shortSegments.length} minutes — scanned minute-by-minute`
              : undefined
          }
        />
        <Dropzone
          kind="movie"
          icon={<Clapperboard className="size-5" aria-hidden />}
          title="Movie"
          subtitle="Any length — chunked into 1-min pieces"
          name={movieServer ? scan?.movieName : movieLocal?.name}
          duration={movieServer ? scan?.movieDuration : movieLocal?.duration}
          size={movieServer ? scan?.movieSize : movieLocal?.size}
          uploading={uploading === 'movie'}
          progress={progress}
          speed={uploading === 'movie' ? speed : null}
          inFlight={uploading === 'movie' ? inFlight : 0}
          disabled={uploading !== null}
          onFile={(f) => uploadFile('movie', f)}
        />
      </div>
      {chunking && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
              ffmpeg chunking movie into {scan?.chunkCount} one-minute chunks...
            </span>
            <span className="font-mono">{scan?.chunkingProgress}%</span>
          </div>
          <div className="progress-track mt-1.5" role="progressbar" aria-valuenow={scan?.chunkingProgress}>
            <div className="progress-fill" style={{ width: `${scan?.chunkingProgress || 0}%` }} />
          </div>
        </div>
      )}
      {scan?.shortSegmentingProgress !== undefined && scan.shortSegmentingProgress < 100 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />
              ffmpeg cutting short into {scan?.shortSegments?.length ?? 1} one-minute scan segment(s) — original untouched...
            </span>
            <span className="font-mono">{scan.shortSegmentingProgress}%</span>
          </div>
          <div className="progress-track mt-1.5" role="progressbar" aria-valuenow={scan.shortSegmentingProgress}>
            <div className="progress-fill" style={{ width: `${scan.shortSegmentingProgress}%` }} />
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

function Dropzone(props: {
  kind: Kind
  icon: React.ReactNode
  title: string
  subtitle: string
  name?: string | null
  duration?: number | null
  size?: number | null
  uploading: boolean
  progress: number
  speed: number | null
  inFlight: number
  disabled: boolean
  onFile: (f: File) => void
  extraInfo?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  // A file is "picked" as soon as we know its name — locally or from the server.
  const picked = Boolean(props.name)
  const done = picked && !props.uploading

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && !props.disabled) props.onFile(f)
  }

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      disabled={props.disabled}
      className={`btn-press relative flex flex-col items-start gap-1 overflow-hidden rounded-lg border border-dashed p-4 text-left ${
        dragOver
          ? 'scale-[1.01] border-primary bg-primary/10'
          : done
            ? 'border-success/40 bg-success/5'
            : picked
              ? 'border-primary/50 bg-primary/5'
              : 'border-input hover:border-primary/60 hover:bg-primary/5'
      } disabled:opacity-60`}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,.mkv,.webm,video/mp4,video/quicktime,video/x-matroska,video/webm"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) props.onFile(f)
          e.target.value = ''
        }}
      />
      <div className="flex w-full items-center gap-2">
        <span className={done ? 'text-success' : 'text-primary'}>{done ? <CheckCircle2 className="size-5" aria-hidden /> : props.icon}</span>
        <span className="text-sm font-medium">{props.title}</span>
        {props.uploading && (
          <span className="ml-auto flex items-center gap-1 font-mono text-xs text-primary">
            <Loader2 className="size-3 animate-spin" aria-hidden /> {props.progress}%
            {props.speed ? <span className="text-muted-foreground">· {fmtBytes(props.speed)}/s</span> : null}
            {props.inFlight > 0 ? (
              <span className="text-muted-foreground" title="Parts uploading in parallel (auto-tuned to your connection)">
                · {props.inFlight}×
              </span>
            ) : null}
          </span>
        )}
      </div>
      {picked ? (
        <>
          <div className="w-full truncate font-mono text-xs text-muted-foreground">
            {props.name} · {props.duration ? fmtTime(props.duration) : '—:—'} · {props.size ? fmtBytes(props.size) : ''}
          </div>
          {props.uploading ? (
            <span className="text-[11px] text-primary">Ready — uploading in background, you can keep working</span>
          ) : (
            props.extraInfo && <span className="text-[11px] text-primary">{props.extraInfo}</span>
          )}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{props.subtitle} — click or drop a file</span>
      )}
      {props.uploading && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-primary transition-[width] duration-300"
          style={{ width: `${props.progress}%` }}
        />
      )}
    </button>
  )
}
