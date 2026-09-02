/**
 * Adaptive browser → Vercel Blob multipart uploader.
 *
 * Why not `upload()` from @vercel/blob/client? It is hardcoded to 6 parallel
 * parts of 8 MB with no stall handling, so on a high-latency / slightly lossy
 * link the throughput saw-tooths: fast for a burst, then a long dip while a
 * stuck part times out.
 *
 * What this uploader does differently to keep the speed STEADY:
 *
 *  1. Adaptive concurrency (AIMD, like TCP itself). We start with a few parts
 *     in flight and add one more every tick while throughput keeps climbing.
 *     The moment a part stalls or errors we cut the in-flight count, because
 *     the browser multiplexes every part over ONE HTTP/2 connection — cramming
 *     100 MB into a single TCP pipe just makes every packet loss stall all of
 *     them at once. Finding the sweet spot for THIS connection is what makes
 *     the rate flat instead of "10 Mbps → kbps → 10 Mbps".
 *
 *  2. Stall watchdog per part. If a part reports no progress for a few
 *     seconds it is aborted and re-sent immediately instead of hanging until
 *     the browser's own (very long) socket timeout gives up.
 *
 *  3. Staggered part starts so parts finish out of phase and there is always
 *     something on the wire (no "all finish together → empty pipe" gap).
 *
 *  4. Smooth, monotonic progress + rolling speed (retries never move the bar
 *     backwards and the readout is averaged over several seconds).
 */
import { createMultipartUpload, uploadPart, completeMultipartUpload } from '@vercel/blob/client'

/** Blob requires >= 5 MB per part except the last. Smaller parts finish more
 *  often, which keeps the in-flight byte count (and the progress bar) smooth. */
const PART_BYTES = 6 * 1024 * 1024
/** Parts in flight when we start — ramps up from here. */
const INITIAL_CONCURRENCY = 4
const MIN_CONCURRENCY = 2
const MAX_CONCURRENCY = 16
/** How often the controller re-evaluates the in-flight count. */
const TICK_MS = 2500
/** A part with no progress event for this long is considered stuck. */
const STALL_MS = 10_000
/** Delay before re-sending a stalled part (fast — the link is likely fine). */
const STALL_RETRY_DELAY_MS = 250
const MAX_PART_ATTEMPTS = 8
/** Rolling window for the speed readout. */
const SPEED_WINDOW_MS = 6000
/** Gap between launching consecutive parts so they finish out of phase. */
const STAGGER_MS = 120

export interface FastUploadProgress {
  loaded: number
  total: number
  /** 0-100 */
  percentage: number
  /** bytes / second over the last few seconds; null until enough samples. */
  speed: number | null
  /** Parts currently in flight — handy for debugging the adaptive controller. */
  inFlight: number
}

export interface FastUploadOptions {
  token: string
  pathname: string
  contentType?: string
  /** Optional hard cap on parts in flight. The controller never exceeds it. */
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (p: FastUploadProgress) => void
}

interface PartResult {
  partNumber: number
  etag: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function fastBlobUpload(file: File, opts: FastUploadOptions): Promise<void> {
  const { token, pathname, signal } = opts
  const contentType = opts.contentType || file.type || 'application/octet-stream'
  const maxConcurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, opts.concurrency ?? MAX_CONCURRENCY))
  const total = file.size

  const { key, uploadId } = await createMultipartUpload(pathname, {
    access: 'private',
    token,
    contentType,
    abortSignal: signal,
  })

  const partCount = Math.max(1, Math.ceil(total / PART_BYTES))
  const results: PartResult[] = new Array(partCount)

  // ---- Progress bookkeeping -------------------------------------------------
  // Bytes of parts fully acknowledged by Blob.
  let committed = 0
  // In-flight bytes per part (reset on retry, so never over-counts).
  const inflightLoaded = new Float64Array(partCount)
  // The bar never goes backwards even when a part has to be re-sent.
  let displayedLoaded = 0
  const samples: { t: number; loaded: number }[] = []
  let lastReportAt = 0

  function currentLoaded() {
    let n = committed
    for (let i = 0; i < partCount; i++) n += inflightLoaded[i]
    return n
  }

  const report = (force = false) => {
    const now = performance.now()
    // Throttle to ~10 fps — 16 parts each firing progress events would
    // otherwise flood React with state updates.
    if (!force && now - lastReportAt < 100) return
    lastReportAt = now
    const loaded = currentLoaded()
    displayedLoaded = Math.max(displayedLoaded, loaded)
    samples.push({ t: now, loaded })
    while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift()
    let speed: number | null = null
    if (samples.length >= 2) {
      const first = samples[0]
      const dt = (now - first.t) / 1000
      if (dt >= 1) speed = Math.max(0, (loaded - first.loaded) / dt)
    }
    opts.onProgress?.({
      loaded: displayedLoaded,
      total,
      percentage: total > 0 ? (displayedLoaded / total) * 100 : 100,
      speed,
      inFlight: active,
    })
  }

  // ---- Adaptive controller state -------------------------------------------
  let target = Math.min(INITIAL_CONCURRENCY, maxConcurrency, partCount)
  let active = 0
  let next = 0
  let failed: unknown = null
  // Incidents (stall or transient error) since the last controller tick.
  let incidents = 0
  let tickLoaded = 0
  let tickAt = performance.now()
  let bestRate = 0

  function controllerTick() {
    const now = performance.now()
    const loaded = currentLoaded()
    const dt = (now - tickAt) / 1000
    const rate = dt > 0 ? (loaded - tickLoaded) / dt : 0
    tickLoaded = loaded
    tickAt = now

    if (incidents > 0) {
      // Multiplicative decrease: the pipe is oversubscribed for this link.
      target = Math.max(MIN_CONCURRENCY, Math.floor(target * 0.6))
      bestRate = rate
    } else if (rate >= bestRate * 0.8) {
      // Additive increase while more parallelism still helps (or is neutral).
      // A 2.5 s window is noisy, so only a CLEAR drop stops the ramp — and a
      // drop without any stall/error never shrinks the pool (that used to
      // oscillate the rate up and down every tick).
      bestRate = Math.max(bestRate, rate)
      target = Math.min(maxConcurrency, target + 1)
    } else {
      bestRate = Math.max(rate, bestRate * 0.9)
    }
    incidents = 0
    void fill()
  }

  // ---- Part upload with stall watchdog --------------------------------------
  async function uploadOne(index: number) {
    const partNumber = index + 1
    const start = index * PART_BYTES
    const end = Math.min(total, start + PART_BYTES)
    const size = end - start
    const blob = file.slice(start, end)

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')

      const ctrl = new AbortController()
      const onOuterAbort = () => ctrl.abort()
      signal?.addEventListener('abort', onOuterAbort, { once: true })

      let lastProgressAt = performance.now()
      let stalled = false
      const watchdog = setInterval(() => {
        if (performance.now() - lastProgressAt > STALL_MS) {
          stalled = true
          ctrl.abort()
        }
      }, 1000)

      try {
        const res = await uploadPart(pathname, blob, {
          access: 'private',
          token,
          key,
          uploadId,
          partNumber,
          contentType,
          abortSignal: ctrl.signal,
          onUploadProgress: ({ loaded }) => {
            const clamped = Math.min(loaded, size)
            if (clamped > inflightLoaded[index]) lastProgressAt = performance.now()
            inflightLoaded[index] = clamped
            report()
          },
        })
        inflightLoaded[index] = 0
        committed += size
        results[index] = { partNumber, etag: res.etag }
        report(true)
        return
      } catch (err) {
        inflightLoaded[index] = 0
        if (signal?.aborted) throw err
        incidents++
        if (attempt + 1 >= MAX_PART_ATTEMPTS) throw err
        if (stalled) {
          // The socket simply stopped moving — re-send right away.
          await sleep(STALL_RETRY_DELAY_MS)
        } else {
          // Real error: exponential backoff with jitter (0.5s, 1s, 2s, 4s, 4s…).
          await sleep(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250)
        }
      } finally {
        clearInterval(watchdog)
        signal?.removeEventListener('abort', onOuterAbort)
      }
    }
  }

  // ---- Worker pool that grows/shrinks to `target` ----------------------------
  let resolveDone: (() => void) | null = null
  const allDone = new Promise<void>((r) => {
    resolveDone = r
  })

  function maybeFinish() {
    if (active === 0 && (next >= partCount || failed !== null)) resolveDone?.()
  }

  async function worker() {
    active++
    try {
      while (failed === null && active <= target) {
        const index = next++
        if (index >= partCount) return
        try {
          await uploadOne(index)
        } catch (err) {
          failed = err
          return
        }
      }
    } finally {
      active--
      maybeFinish()
      // Someone else may need to take over if target grew while we were busy.
      void fill()
    }
  }

  let filling = false
  async function fill() {
    if (filling) return
    filling = true
    try {
      while (failed === null && active < target && next < partCount) {
        void worker()
        // Stagger launches so parts finish out of phase.
        if (active < target && next < partCount) await sleep(STAGGER_MS)
      }
    } finally {
      filling = false
      maybeFinish()
    }
  }

  const ticker = setInterval(controllerTick, TICK_MS)
  try {
    void fill()
    await allDone
  } finally {
    clearInterval(ticker)
  }
  if (failed !== null) throw failed

  await completeMultipartUpload(pathname, results, {
    access: 'private',
    token,
    key,
    uploadId,
    contentType,
    abortSignal: signal,
  })
  report(true)
}
