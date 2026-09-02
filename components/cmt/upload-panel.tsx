'use client'

import { useRef, useState, type DragEvent } from 'react'
import { upload } from '@vercel/blob/client'
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


export function UploadPanel({ scan, selectedScanId, onScanCreated, refresh }: Props) {
  const [uploading, setUploading] = useState<Kind | null>(null)
  const [progress, setProgress] = useState(0)
  const [speed, setSpeed] = useState<number | null>(null)
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

  function uploadFile(kind: Kind, file: File) {
    if (!isAllowedVideo(file)) {
      setError('Only MP4, MOV, MKV or WebM video files are supported')
      return
    }
    setError(null)
    setUploading(kind)
    setProgress(0)
    setSpeed(null)

    // 1) INSTANT: show the file in the card right away from local metadata.
    setLocal((prev) => ({ ...prev, [kind]: { name: file.name, size: file.size, duration: null } }))
    void readLocalDuration(file).then((d) => {
      setLocal((prev) => (prev[kind]?.name === file.name ? { ...prev, [kind]: { ...prev[kind]!, duration: d } } : prev))
    })

    // 2) BACKGROUND: direct browser → Blob multipart upload. The bytes never
    //    touch our serverless function (which capped us at ~1 MB/s); the SDK
    //    splits the file into parts, uploads them in parallel straight to Blob
    //    storage and retries failed parts on its own.
    void (async () => {
      try {
        const id = await ensureScan()
        const startedAt = performance.now()

        await upload(`media/${id}/${kind}.mp4`, file, {
          access: 'private',
          handleUploadUrl: `/api/scans/${id}/upload`,
          contentType: file.type || 'application/octet-stream',
          multipart: true,
          onUploadProgress: ({ loaded, percentage }) => {
            const elapsed = (performance.now() - startedAt) / 1000
            if (elapsed > 0.5) setSpeed(loaded / elapsed)
            // Cap at 99 — server-side ffmpeg probe finishing is the real 100%.
            setProgress(Math.min(99, Math.round(percentage)))
          },
        })

        // Finalize: server pulls the video from Blob to its disk (server-to-
        // server, fast), probes it with ffmpeg and sets up segments / trim state.
        setSpeed(null)
        const res = await fetch(`/api/scans/${id}/upload?action=complete`, {
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
