'use client'

import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Film, Clapperboard, Loader2, CheckCircle2, X, RefreshCw, WifiOff } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime, fmtBytes } from '@/lib/format'
import { uploadVideoStream, fmtMbps, fmtEta, UploadError, type UploadProgress, type UploadKind } from '@/lib/upload-client'

interface Props {
  scan: Scan | null
  /** The dashboard's selected scan id — null means "new scan", so a fresh scan must be created on upload. */
  selectedScanId: string | null
  onScanCreated: (id: string) => void
  refresh: () => void
}

type Kind = UploadKind

/** Info shown the INSTANT a file is picked — read locally in the browser, no
 *  server round-trip. Replaced by the server's data once the upload lands. */
interface LocalPick {
  name: string
  size: number
  /** Duration read from the browser's video decoder; null while loading /
   *  when the container can't be parsed client-side (e.g. some MKVs). */
  duration: number | null
}

interface Job {
  kind: Kind
  progress: UploadProgress
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

// ---- The ONLY upload path: browser → app server (EC2) → EBS disk, as ONE
// continuous stream (see lib/upload-client.ts). No chunk slicing: the whole
// file goes out in a single request body at whatever speed the connection
// gives. If the connection drops or stalls, the browser asks the server how
// many bytes already landed and continues from exactly there. ffprobe starts
// the instant the last byte lands; the S3 backup happens in the background.

export function UploadPanel({ scan, selectedScanId, onScanCreated, refresh }: Props) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<Partial<Record<Kind, LocalPick>>>({})
  /** Per card: the last pick was linked from an earlier scan (no upload). */
  const [reused, setReused] = useState<Partial<Record<Kind, boolean>>>({})
  const abortRef = useRef<AbortController | null>(null)
  const scanIdRef = useRef<string | null>(selectedScanId)

  // Closing / reloading the tab mid-upload kills the stream. The upload would
  // resume from the server's last byte if the same file is picked again, but
  // warn first so it does not happen by accident.
  const uploading = job !== null
  useEffect(() => {
    if (!uploading) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])
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
      if (Object.keys(reused).length) setReused({})
    }
  }

  async function ensureScan(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current
    const res = await fetch('/api/scans', { method: 'POST' })
    if (res.status === 401) throw new UploadError('Session expired — please log in again', true)
    let j: { id?: unknown; error?: string } = {}
    try {
      j = (await res.json()) as { id?: unknown; error?: string }
    } catch {
      // handled below
    }
    if (!res.ok || typeof j.id !== 'string' || j.id.length === 0) {
      throw new UploadError(j.error || `Could not create a scan (HTTP ${res.status}). Please try again.`, true)
    }
    scanIdRef.current = j.id
    onScanCreated(j.id)
    return j.id
  }

  function uploadFile(kind: Kind, file: File) {
    if (!isAllowedVideo(file)) {
      setError('Only MP4, MOV, MKV or WebM video files are supported')
      return
    }
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    setJob({
      kind,
      progress: {
        phase: 'probing',
        sent: 0,
        total: file.size,
        bytesPerSec: null,
        peakBytesPerSec: 0,
        avgBytesPerSec: null,
        etaSec: null,
        reconnects: 0,
        resumedFrom: 0,
        offline: false,
      },
    })

    // 1) INSTANT: show the file in the card right away from local metadata.
    setReused((prev) => ({ ...prev, [kind]: false }))
    setLocal((prev) => ({ ...prev, [kind]: { name: file.name, size: file.size, duration: null } }))
    void readLocalDuration(file).then((d) => {
      setLocal((prev) => (prev[kind]?.name === file.name ? { ...prev, [kind]: { ...prev[kind]!, duration: d } } : prev))
    })

    // 2) BACKGROUND upload — one stream, auto-resume.
    void (async () => {
      try {
        const id = await ensureScan()
        const result = await uploadVideoStream({
          scanId: id,
          kind,
          file,
          signal: controller.signal,
          onProgress: (progress) => setJob((j) => (j && j.kind === kind ? { kind, progress } : j)),
        })
        setJob(null)
        setError(null)
        setReused((prev) => ({ ...prev, [kind]: result.reused }))
        refresh()
      } catch (err) {
        setJob(null)
        setLocal((prev) => {
          const copy = { ...prev }
          delete copy[kind]
          return copy
        })
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
        }
        refresh()
      } finally {
        if (abortRef.current === controller) abortRef.current = null
      }
    })()
  }

  function cancelUpload() {
    abortRef.current?.abort()
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
          progress={job?.kind === 'short' ? job.progress : null}
          disabled={job !== null}
          onFile={(f) => uploadFile('short', f)}
          onCancel={cancelUpload}
          extraInfo={[
            reused.short ? 'Already on server — linked instantly, nothing uploaded' : null,
            scan?.shortSegments && scan.shortSegments.length > 1 ? `${scan.shortSegments.length} minutes — scanned minute-by-minute` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined}
        />
        <Dropzone
          kind="movie"
          icon={<Clapperboard className="size-5" aria-hidden />}
          title="Movie"
          subtitle="Any length — chunked into 1-min pieces"
          name={movieServer ? scan?.movieName : movieLocal?.name}
          duration={movieServer ? scan?.movieDuration : movieLocal?.duration}
          size={movieServer ? scan?.movieSize : movieLocal?.size}
          progress={job?.kind === 'movie' ? job.progress : null}
          disabled={job !== null}
          onFile={(f) => uploadFile('movie', f)}
          onCancel={cancelUpload}
          extraInfo={reused.movie ? 'Already on server — linked instantly, nothing uploaded' : undefined}
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
  /** Live upload stats while THIS card is uploading, null otherwise. */
  progress: UploadProgress | null
  disabled: boolean
  onFile: (f: File) => void
  onCancel: () => void
  extraInfo?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const uploading = props.progress !== null
  // A file is "picked" as soon as we know its name — locally or from the server.
  const picked = Boolean(props.name)
  const done = picked && !uploading

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f && !props.disabled) props.onFile(f)
  }

  return (
    <div className="relative">
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
        className={`btn-press flex w-full flex-col items-start gap-1.5 rounded-lg border border-dashed p-4 text-left ${
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
          {props.progress && (
            <span className="ml-auto mr-7 flex items-center gap-1 font-mono text-xs text-primary">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {Math.floor((props.progress.sent / props.progress.total) * 100)}%
            </span>
          )}
        </div>
        {picked ? (
          <>
            <div className="w-full truncate font-mono text-xs text-muted-foreground">
              {props.name} · {props.duration ? fmtTime(props.duration) : '—:—'} · {props.size ? fmtBytes(props.size) : ''}
            </div>
            {props.progress ? (
              <UploadMeter p={props.progress} />
            ) : (
              props.extraInfo && <span className="text-[11px] text-primary">{props.extraInfo}</span>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{props.subtitle} — click or drop a file</span>
        )}
      </button>
      {uploading && (
        <button
          type="button"
          onClick={props.onCancel}
          aria-label={`Cancel ${props.title.toLowerCase()} upload`}
          title="Cancel upload"
          className="absolute right-3 top-3 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}

/** Live speed / progress readout under the file name while uploading. */
function UploadMeter({ p }: { p: UploadProgress }) {
  const pct = Math.min(100, (p.sent / p.total) * 100)
  const live = p.phase === 'uploading' && p.bytesPerSec !== null

  let status: string
  switch (p.phase) {
    case 'probing':
      status = p.reconnects > 0 ? 'Checking what already reached the server…' : 'Connecting…'
      break
    case 'reconnecting':
      status = p.offline
        ? `No internet — waiting for the connection to come back (will resume from ${fmtBytes(p.sent)})`
        : `Connection dropped — resuming from ${fmtBytes(p.sent)} (retry ${p.reconnects})`
      break
    case 'finalizing':
      status = 'All bytes sent — server is verifying the file…'
      break
    case 'linking':
      status = 'Same video already on the server from an earlier scan — linking it, no upload needed…'
      break
    default:
      status =
        p.resumedFrom > 0
          ? `Resumed from ${fmtBytes(p.resumedFrom)} — one continuous stream, you can keep working`
          : 'One continuous stream — you can keep working'
  }

  const trouble = p.phase === 'reconnecting'

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(pct)}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs tabular-nums">
        {/* Live line speed — the number to compare with your internet plan. */}
        <span
          className={`text-base font-semibold leading-none ${live ? 'text-primary' : 'text-muted-foreground'}`}
          aria-live="polite"
          aria-label="Current upload speed"
        >
          {live ? fmtMbps(p.bytesPerSec!) : p.phase === 'uploading' ? 'measuring…' : p.phase === 'linking' ? 'instant' : '— Mbps'}
        </span>
        {live && <span className="text-muted-foreground">{fmtBytes(p.bytesPerSec!)}/s</span>}
        <span className="text-muted-foreground">
          {fmtBytes(p.sent)} / {fmtBytes(p.total)}
        </span>
        {p.etaSec !== null && <span className="ml-auto text-muted-foreground">{fmtEta(p.etaSec)}</span>}
        {(p.phase === 'finalizing' || p.phase === 'linking') && (
          <span className="ml-auto flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" aria-hidden /> {p.phase === 'linking' ? 'linking' : 'verifying'}
          </span>
        )}
      </div>
      <span className={`flex items-center gap-1 text-[11px] ${trouble ? 'text-destructive' : 'text-primary'}`}>
        {trouble && (p.offline ? <WifiOff className="size-3" aria-hidden /> : <RefreshCw className="size-3 animate-spin" aria-hidden />)}
        <span className="truncate">{status}</span>
        {p.phase === 'uploading' && (p.avgBytesPerSec !== null || p.peakBytesPerSec > 0) && (
          <span className="ml-auto shrink-0 font-mono text-muted-foreground">
            {p.avgBytesPerSec !== null && <>avg {fmtMbps(p.avgBytesPerSec)}</>}
            {p.avgBytesPerSec !== null && p.peakBytesPerSec > 0 && ' · '}
            {p.peakBytesPerSec > 0 && <>peak {fmtMbps(p.peakBytesPerSec)}</>}
          </span>
        )}
      </span>
    </div>
  )
}
