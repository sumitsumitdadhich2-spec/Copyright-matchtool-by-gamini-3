// ---------------------------------------------------------------------------
// Browser-side video upload engine: ONE continuous stream, auto-resume.
//
//   browser ──(single HTTP body, full speed)──▶ Caddy ──▶ Node ──▶ EBS disk
//
// The file is NOT sliced into chunks. The browser opens a single request and
// streams the whole file (or the remainder after a resume) as one body, so
// the connection stays saturated and the server writes straight to disk.
//
// Stability comes from RESUME, not from chunking: the server persists how many
// contiguous bytes it has for this exact file (fingerprint = name + size +
// lastModified). If the connection drops, stalls, or the page is refreshed,
// the browser asks the server for that number and continues from there with a
// new single stream. Nothing already transferred is ever sent twice.
//
// Speed meter: XHR upload progress sampled every 250 ms, rate over a 3 s
// sliding window with light smoothing → one steady Mbps number + ETA.
// ---------------------------------------------------------------------------

export type UploadKind = 'short' | 'movie'

export type UploadPhase =
  /** Asking the server how many bytes it already has. */
  | 'probing'
  /** Bytes are flowing. */
  | 'uploading'
  /** Every byte was handed to the network — waiting for the server to write the
   *  tail, verify the size and run ffprobe. */
  | 'finalizing'
  /** Connection dropped or stalled — backing off before resuming. */
  | 'reconnecting'

export interface UploadProgress {
  phase: UploadPhase
  /** Bytes confirmed by the server + bytes of the current stream on the wire. */
  sent: number
  total: number
  /** Smoothed upload rate in bytes/second (null until ~1 s of samples). */
  bytesPerSec: number | null
  /** Highest smoothed rate seen during this upload. */
  peakBytesPerSec: number
  /** Estimated seconds left (null until the rate is known). */
  etaSec: number | null
  /** Number of reconnects so far (0 on a clean run). */
  reconnects: number
  /** Byte offset the current stream started from (0 unless resumed). */
  resumedFrom: number
}

export interface UploadResult {
  duration: number
  size: number
}

export class UploadError extends Error {
  /** true = no point retrying (bad file, auth, cancelled). */
  readonly fatal: boolean
  constructor(message: string, fatal = false) {
    super(message)
    this.name = 'UploadError'
    this.fatal = fatal
  }
}

/** No new bytes accepted by the network for this long → abort and resume. */
const STALL_MS = 30_000
/** After the last byte left the browser, how long to wait for the server's
 *  verdict (draining proxies + ffprobe on a multi-GB file). */
const FINALIZE_TIMEOUT_MS = 5 * 60_000
/** Reconnect attempts before giving up. */
const MAX_RECONNECTS = 15
const SAMPLE_MS = 250
const WINDOW_MS = 3_000

/** Stable across page reloads for the same file on the same machine. */
export function fileFingerprint(file: File): string {
  let h = 0
  const s = `${file.name}|${file.size}|${file.lastModified}`
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `${(h >>> 0).toString(36)}${file.size.toString(36)}`
}

class SpeedMeter {
  private samples: { t: number; n: number }[] = []
  rate: number | null = null
  peak = 0

  sample(n: number) {
    const t = performance.now()
    this.samples.push({ t, n })
    while (this.samples.length > 2 && t - this.samples[0].t > WINDOW_MS) this.samples.shift()
    const first = this.samples[0]
    const dt = (t - first.t) / 1000
    if (dt < 0.75) return
    const raw = Math.max(0, (n - first.n) / dt)
    this.rate = this.rate === null ? raw : this.rate * 0.7 + raw * 0.3
    if (this.rate > this.peak) this.peak = this.rate
  }

  /** Drop the window (a resume restarts byte accounting) but keep the peak. */
  resetWindow() {
    this.samples = []
    this.rate = null
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const id = setTimeout(done, ms)
    function done() {
      clearTimeout(id)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** GET → how many contiguous bytes of this exact file the server already has. */
async function probeReceived(base: string, signal?: AbortSignal): Promise<number> {
  const res = await fetch(base, { method: 'GET', cache: 'no-store', signal })
  if (res.status === 401) throw new UploadError('Session expired — please log in again', true)
  if (res.status === 404) throw new UploadError('Scan not found — please refresh the page', true)
  if (!res.ok) throw new UploadError(`Server error while checking upload state (HTTP ${res.status})`)
  const j = (await res.json()) as { received?: number }
  return Number.isFinite(j.received) && j.received! > 0 ? j.received! : 0
}

type StreamOutcome = { done: true; duration: number; size: number } | { done: false; received: number }

/** One single-body request from `offset` to the end of the file. */
function sendStream(
  base: string,
  file: File,
  offset: number,
  videoType: string,
  hooks: { onWire: (bytes: number) => void; onFinalizing: () => void; signal?: AbortSignal },
): Promise<StreamOutcome> {
  return new Promise((resolve, reject) => {
    const body = offset > 0 ? file.slice(offset) : file
    const xhr = new XMLHttpRequest()
    let loaded = 0
    let lastProgressAt = performance.now()
    let allSentAt: number | null = null

    const watchdog = setInterval(() => {
      const now = performance.now()
      if (allSentAt === null) {
        if (now - lastProgressAt > STALL_MS) xhr.abort()
      } else if (now - allSentAt > FINALIZE_TIMEOUT_MS) {
        xhr.abort()
      }
    }, 1000)

    const onAbort = () => xhr.abort()
    hooks.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearInterval(watchdog)
      hooks.signal?.removeEventListener('abort', onAbort)
    }

    xhr.open('POST', `${base}&offset=${offset}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('x-video-type', videoType)

    xhr.upload.onprogress = (e) => {
      if (e.loaded > loaded) {
        loaded = Math.min(e.loaded, body.size)
        lastProgressAt = performance.now()
        hooks.onWire(loaded)
      }
    }
    // Every byte left the browser — now it is the server's turn.
    xhr.upload.onload = () => {
      loaded = body.size
      hooks.onWire(loaded)
      allSentAt = performance.now()
      hooks.onFinalizing()
    }

    xhr.onload = () => {
      cleanup()
      let j: { done?: boolean; duration?: number; size?: number; received?: number; error?: string } = {}
      try {
        j = JSON.parse(xhr.responseText)
      } catch {
        // non-JSON body (proxy error page) — handled below
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (j.done) resolve({ done: true, duration: j.duration ?? 0, size: j.size ?? file.size })
        else resolve({ done: false, received: Number.isFinite(j.received) ? j.received! : offset })
        return
      }
      const msg = j.error || `Upload failed (HTTP ${xhr.status})`
      if (xhr.status === 401) reject(new UploadError('Session expired — please log in again', true))
      // 409 = the server's byte count differs from ours → re-probe and continue.
      // 408 = the request was cut by a timeout → resume.
      else if (xhr.status === 409 || xhr.status === 408) reject(new UploadError(msg, false))
      else if (xhr.status >= 400 && xhr.status < 500) reject(new UploadError(msg, true))
      else reject(new UploadError(msg, false))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new UploadError('Network error — connection lost', false))
    }
    xhr.onabort = () => {
      cleanup()
      if (hooks.signal?.aborted) reject(new UploadError('Upload cancelled', true))
      else if (allSentAt !== null) reject(new UploadError('Server did not confirm the file in time', false))
      else reject(new UploadError('Connection stalled', false))
    }
    xhr.send(body)
  })
}

export interface UploadOptions {
  scanId: string
  kind: UploadKind
  file: File
  onProgress: (p: UploadProgress) => void
  signal?: AbortSignal
}

/**
 * Upload a video as ONE continuous stream, resuming from the server's last
 * confirmed byte whenever the connection breaks. Resolves once the server has
 * the complete file on disk and ffprobe accepted it. Throws UploadError.
 */
export async function uploadVideoStream({ scanId, kind, file, onProgress, signal }: UploadOptions): Promise<UploadResult> {
  const session = fileFingerprint(file)
  const base = `/api/scans/${scanId}/upload?kind=${kind}&name=${encodeURIComponent(file.name)}&total=${file.size}&session=${session}`
  const videoType = file.type || 'video/mp4'
  const meter = new SpeedMeter()

  let phase: UploadPhase = 'probing'
  let confirmed = 0
  let wire = 0
  let reconnects = 0
  let resumedFrom = 0

  const emit = () => {
    const sent = Math.min(file.size, confirmed + wire)
    const rate = meter.rate
    onProgress({
      phase,
      sent,
      total: file.size,
      bytesPerSec: rate,
      peakBytesPerSec: meter.peak,
      etaSec: rate && rate > 0 && phase === 'uploading' ? Math.max(0, (file.size - sent) / rate) : null,
      reconnects,
      resumedFrom,
    })
  }

  const ticker = setInterval(() => {
    if (phase === 'uploading') meter.sample(confirmed + wire)
    emit()
  }, SAMPLE_MS)

  try {
    for (;;) {
      if (signal?.aborted) throw new UploadError('Upload cancelled', true)

      phase = 'probing'
      wire = 0
      emit()
      try {
        confirmed = await probeReceived(base, signal)
      } catch (err) {
        if (err instanceof UploadError && err.fatal) throw err
        if (signal?.aborted) throw new UploadError('Upload cancelled', true)
        confirmed = 0
      }
      confirmed = Math.min(confirmed, file.size)
      resumedFrom = confirmed
      if (confirmed > 0) console.log(`[upload] resuming ${kind} from byte ${confirmed} of ${file.size}`)

      phase = 'uploading'
      meter.resetWindow()
      emit()

      try {
        const out = await sendStream(base, file, confirmed, videoType, {
          onWire: (n) => {
            wire = n
          },
          onFinalizing: () => {
            phase = 'finalizing'
            emit()
          },
          signal,
        })
        if (out.done) {
          confirmed = file.size
          wire = 0
          emit()
          return { duration: out.duration, size: out.size }
        }
        // Server accepted bytes but the body ended before the declared size
        // (a proxy cut it short). Loop: re-probe and stream the remainder.
        confirmed = out.received
        console.warn(`[upload] server has ${out.received}/${file.size} bytes — streaming the rest`)
        continue
      } catch (err) {
        if (err instanceof UploadError && err.fatal) throw err
        if (signal?.aborted) throw new UploadError('Upload cancelled', true)
        reconnects++
        if (reconnects > MAX_RECONNECTS) {
          throw new UploadError(
            `Upload failed after ${MAX_RECONNECTS} reconnects (${err instanceof Error ? err.message : 'network error'}). Check your connection and try again — it will resume where it stopped.`,
            true,
          )
        }
        phase = 'reconnecting'
        wire = 0
        emit()
        // 0.5 s, 1 s, 2 s ... capped at 8 s, plus jitter.
        await sleep(Math.min(8_000, 500 * 2 ** (reconnects - 1)) + Math.random() * 300, signal)
      }
    }
  } finally {
    clearInterval(ticker)
  }
}

// ---- Formatting helpers for the UI ----

/** Megabits per second, the number people compare with their internet plan. */
export function fmtMbps(bytesPerSec: number): string {
  const mbps = (bytesPerSec * 8) / 1_000_000
  if (mbps >= 100) return `${Math.round(mbps)} Mbps`
  if (mbps >= 10) return `${mbps.toFixed(1)} Mbps`
  if (mbps >= 1) return `${mbps.toFixed(2)} Mbps`
  return `${Math.round(mbps * 1000)} Kbps`
}

export function fmtEta(sec: number): string {
  const s = Math.max(1, Math.round(sec))
  if (s < 60) return `${s}s left`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s left`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m left`
}
