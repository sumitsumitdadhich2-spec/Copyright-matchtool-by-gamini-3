'use client'

import { useRef, useState, type DragEvent } from 'react'
import { upload as blobUpload } from '@vercel/blob/client'
import { fastBlobUpload } from '@/lib/fast-blob-upload'
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

/** Rolling-window speed meter (bytes/s over the last ~6 s). A cumulative
 *  average hides stalls and a per-event delta is far too noisy — this is the
 *  middle ground that reads steady on screen. */
function createSpeedMeter(windowMs = 6000) {
  const samples: { t: number; loaded: number }[] = []
  return (loaded: number): number | null => {
    const now = performance.now()
    samples.push({ t: now, loaded })
    while (samples.length > 2 && now - samples[0].t > windowMs) samples.shift()
    if (samples.length < 2) return null
    const dt = (now - samples[0].t) / 1000
    if (dt < 1) return null
    return Math.max(0, (loaded - samples[0].loaded) / dt)
  }
}

// ---- FALLBACK path only (browser → app server → disk). The primary path is a
// DIRECT browser → Vercel Blob multipart upload that bypasses the server hop.
const CHUNK_BYTES = 4 * 1024 * 1024
/** How many chunks fly at once. Keeps the pipe full on high-latency links. */
const PARALLEL = 6

export function UploadPanel({ scan, selectedScanId, onScanCreated, refresh }: Props) {
  const [uploading, setUploading] = useState<Kind | null>(null)
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState<number | null>(null)
  /** Parts currently on the wire (adaptive uploader) — 0 when not applicable. */
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
   * Direct browser → Vercel Blob upload, then a small /complete call so the
   * server pulls the file down and runs ffmpeg.
   *
   * Returns true when everything succeeded. Returns false ONLY when the Blob
   * upload itself could not even start / transfer (token endpoint unreachable,
   * network blocked, etc.) — the caller then falls back to the chunked route.
   * Errors from the finalize step are real errors and are thrown.
   */
  async function uploadDirectToBlob(id: string, kind: Kind, file: File): Promise<boolean> {
    const contentType = file.type || 'application/octet-stream'
    let transferred = false

    // 1) FASTEST: our own multipart uploader with 12 parts in flight and a
    //    rolling speed readout. Needs a scoped client token from the server.
    try {
      const tokRes = await fetch(`/api/scans/${id}/upload/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'direct', kind, contentType }),
      })
      if (!tokRes.ok) throw new Error(`token ${tokRes.status}`)
      const { token, pathname } = (await tokRes.json()) as { token: string; pathname: string }
      await fastBlobUpload(file, {
        token,
        pathname,
        contentType,
        onProgress: ({ percentage, speed: bps, inFlight }) => {
          if (bps !== null) setSpeed(bps)
          setInFlight(inFlight)
          // Cap at 99 — the server-side ffmpeg finalize is the real 100%.
          setProgress(Math.min(99, Math.round(percentage)))
        },
      })
      transferred = true
    } catch (err) {
      console.warn('[upload] fast multipart upload failed, trying stock Blob upload:', err instanceof Error ? err.message : err)
    }

    // 2) Stock @vercel/blob upload() (6 parallel parts) as a safety net.
    if (!transferred) {
      setProgress(0)
      setSpeed(null)
      setInFlight(0)
      const meter = createSpeedMeter()
      try {
        await blobUpload(`media/${id}/${kind}.mp4`, file, {
          access: 'private',
          handleUploadUrl: `/api/scans/${id}/upload/token`,
          contentType,
          multipart: true,
          onUploadProgress: ({ loaded, percentage }) => {
            const bps = meter(loaded)
            if (bps !== null) setSpeed(bps)
            setProgress(Math.min(99, Math.round(percentage)))
          },
        })
      } catch (err) {
        console.warn('[upload] direct Blob upload failed, falling back to chunked upload:', err instanceof Error ? err.message : err)
        return false
      }
    }

    // Finalize: server downloads from Blob (datacenter speed) + ffmpeg probe.
    setSpeed(null)
    setInFlight(0)
    const res = await fetch(`/api/scans/${id}/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, name: file.name }),
    })
    if (!res.ok) {
      let msg = 'Upload finished but processing failed. Please try again.'
      try {
        msg = ((await res.json()) as { error?: string }).error || msg
      } catch {
        // keep default
      }
      throw new Error(msg)
    }
    return true
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

        // FAST PATH: direct browser → Vercel Blob multipart upload. The bytes
        // never touch the app server, so the user's full uplink is used
        // (Blob uploads parts in parallel with automatic retries).
        const direct = await uploadDirectToBlob(id, kind, file)
        if (direct) {
          setProgress(100)
          setUploading(null)
          setSpeed(null)
          setError(null)
          refresh()
          return
        }

        // FALLBACK: parallel chunked upload through the app server.
        setProgress(0)
        setSpeed(null)
        const session = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
        const base = `/api/scans/${id}/upload?kind=${kind}&name=${encodeURIComponent(file.name)}&total=${file.size}&session=${session}`

        const offsets: number[] = []
        for (let o = 0; o < file.size; o += CHUNK_BYTES) offsets.push(o)

        let sentBytes = 0
        let done = false
        let failed: Error | null = null
        const meter = createSpeedMeter()
        let next = 0

        async function sendChunk(offset: number) {
          const piece = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size))
          let lastErr: Error | null = null
          for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt))
            try {
              const res = await fetch(`${base}&offset=${offset}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: piece,
              })
              if (res.ok) {
                const j = (await res.json().catch(() => ({}))) as { done?: boolean }
                if (j.done) done = true
                sentBytes += piece.size
                const bps = meter(sentBytes)
                if (bps !== null) setSpeed(bps)
                // Cap at 99 — server-side ffmpeg probe finishing is the real 100%.
                setProgress(Math.min(99, Math.round((sentBytes / file.size) * 100)))
                return
              }
              let msg = 'Upload failed. Please try again.'
              try {
                msg = ((await res.json()) as { error?: string }).error || msg
              } catch {
                // keep default
              }
              // Bad-request errors won't fix themselves — stop retrying.
              if (res.status >= 400 && res.status < 500) throw new Error(msg)
              lastErr = new Error(msg)
            } catch (err) {
              if (err instanceof TypeError) {
                // fetch network error — retry
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
          while (!failed) {
            const i = next++
            if (i >= offsets.length) return
            try {
              await sendChunk(offsets[i])
            } catch (err) {
              failed = err instanceof Error ? err : new Error('Upload failed. Please try again.')
              return
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(PARALLEL, offsets.length) }, worker))
        if (failed) throw failed
        if (!done) throw new Error('Upload finished but the server did not confirm it. Please try again.')

        setProgress(100)
        setUploading(null)
        setSpeed(null)
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
