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
  key: string
  scanId: string | null
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
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<Record<string, LocalPick>>({})
  const [reused, setReused] = useState<Record<string, boolean>>({})
  const controllers = useRef(new Map<string, AbortController>())
  const scanIdRef = useRef<string | null>(selectedScanId)
  const creatingScanRef = useRef<Promise<string> | null>(null)

  useEffect(() => {
    scanIdRef.current = selectedScanId
  }, [selectedScanId])

  const uploading = jobs.length > 0
  useEffect(() => {
    if (!uploading) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])

  async function ensureScan(): Promise<string> {
    if (scanIdRef.current) return scanIdRef.current
    if (creatingScanRef.current) return creatingScanRef.current
    creatingScanRef.current = (async () => {
      const res = await fetch('/api/scans', { method: 'POST' })
      if (res.status === 401) throw new UploadError('Session expired — please log in again', true)
      const j = (await res.json().catch(() => ({}))) as { id?: unknown; error?: string }
      if (!res.ok || typeof j.id !== 'string' || j.id.length === 0) throw new UploadError(j.error || `Could not create a scan (HTTP ${res.status}). Please try again.`, true)
      scanIdRef.current = j.id
      onScanCreated(j.id)
      return j.id
    })().finally(() => {
      creatingScanRef.current = null
    })
    return creatingScanRef.current
  }

  function uploadFile(kind: Kind, file: File) {
    if (!isAllowedVideo(file)) {
      setError('Only MP4, MOV, MKV or WebM video files are supported')
      return
    }
    const initialScanId = scanIdRef.current
    const tempKey = `${initialScanId ?? 'new'}/${kind}`
    const controller = new AbortController()
    controllers.current.set(tempKey, controller)
    setError(null)
    const initialProgress: UploadProgress = { phase: 'probing', sent: 0, total: file.size, bytesPerSec: null, peakBytesPerSec: 0, avgBytesPerSec: null, etaSec: null, reconnects: 0, resumedFrom: 0, offline: false }
    setJobs((previous) => [...previous.filter((item) => item.key !== tempKey), { key: tempKey, scanId: initialScanId, kind, progress: initialProgress }])
    setReused((previous) => ({ ...previous, [tempKey]: false }))
    setLocal((previous) => ({ ...previous, [tempKey]: { name: file.name, size: file.size, duration: null } }))
    void readLocalDuration(file).then((duration) => setLocal((previous) => previous[tempKey]?.name === file.name ? { ...previous, [tempKey]: { ...previous[tempKey], duration } } : previous))

    void (async () => {
      let key = tempKey
      try {
        const id = await ensureScan()
        key = `${id}/${kind}`
        if (key !== tempKey) {
          controllers.current.delete(tempKey)
          controllers.current.set(key, controller)
          setJobs((previous) => previous.map((item) => item.key === tempKey ? { ...item, key, scanId: id } : item))
          setLocal((previous) => ({ ...previous, [key]: previous[tempKey] }))
          setReused((previous) => ({ ...previous, [key]: previous[tempKey] || false }))
        }
        const result = await uploadVideoStream({
          scanId: id,
          kind,
          file,
          signal: controller.signal,
          onProgress: (progress) => setJobs((previous) => previous.map((item) => item.key === key ? { ...item, progress } : item)),
        })
        setJobs((previous) => previous.filter((item) => item.key !== key))
        setReused((previous) => ({ ...previous, [key]: result.reused }))
        refresh()
      } catch (err) {
        setJobs((previous) => previous.filter((item) => item.key !== key && item.key !== tempKey))
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Upload failed. Please try again.')
        refresh()
      } finally {
        controllers.current.delete(key)
        controllers.current.delete(tempKey)
      }
    })()
  }

  function cancelUpload(kind: Kind) {
    const visible = jobs.find((item) => item.scanId === selectedScanId && item.kind === kind)
    if (visible) controllers.current.get(visible.key)?.abort()
  }

  const chunking = scan?.status === 'chunking'

  // Every card reads only its selected scan + media-kind job. Uploads for other
  // history entries keep running in the same component without leaking progress.
  const scope = selectedScanId ?? 'new'
  const shortKey = `${scope}/short`
  const movieKey = `${scope}/movie`
  const shortLocal = local[shortKey]
  const movieLocal = local[movieKey]
  const shortJob = jobs.find((item) => item.key === shortKey) ?? null
  const movieJob = jobs.find((item) => item.key === movieKey) ?? null
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
          progress={shortJob?.progress ?? null}
          disabled={shortJob !== null || shortServer}
          onFile={(f) => uploadFile('short', f)}
          onCancel={() => cancelUpload('short')}
          extraInfo={[
            reused[shortKey] ? 'Already on server — linked instantly, nothing uploaded' : null,
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
          progress={movieJob?.progress ?? null}
          disabled={movieJob !== null || movieServer}
          onFile={(f) => uploadFile('movie', f)}
          onCancel={() => cancelUpload('movie')}
          extraInfo={reused[movieKey] ? 'Already on server — linked instantly, nothing uploaded' : undefined}
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
