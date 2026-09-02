/**
 * Steady browser → Vercel Blob multipart uploader.
 *
 * THE PROBLEM this fixes ("15 Mbps burst → 10 s freeze → burst again"):
 *
 *  Browsers buffer a whole request body into the HTTP/2 send window the
 *  moment a request starts. `onUploadProgress` therefore hits 100 % for every
 *  part almost instantly — long before the bytes are actually on the wire —
 *  and then NOTHING happens until Blob acknowledges the part. With many
 *  parts in flight the bar sprints, freezes for 10-20 s, and sprints again.
 *
 *  Worse, the old stall watchdog looked at those same progress events: a
 *  healthy part that had been fully buffered (no more events) but was still
 *  draining onto a 15 Mbps link got ABORTED after 10 s and re-sent — wasting
 *  bandwidth and producing the real stop/start pattern the user sees.
 *
 * WHAT WE DO INSTEAD:
 *
 *  1. Speed is measured from ACKNOWLEDGED bytes only (parts confirmed by
 *     Blob), smoothed over a rolling window + EMA. That is the true wire
 *     rate, and it is what we show.
 *
 *  2. The progress bar is a rate-limited ramp: it advances at the measured
 *     speed and is clamped to what has really been handed to the network.
 *     It never jumps and never goes backwards — one flat, honest number.
 *
 *  3. Stall detection is deadline based. A part gets at least
 *     `size × inFlight ÷ rate × 4` (min 20 s) to be acknowledged before it is
 *     considered stuck, so a slow-but-healthy link is never killed.
 *
 *  4. Modest, adaptive parallelism (3 → max 6 parts). All parts share ONE
 *     TCP connection, so more parts don't add bandwidth — they only add
 *     buffering and make the freeze longer. We add a part only when the
 *     acked rate clearly improved, and back off on a real stall/error.
 */
import { createMultipartUpload, uploadPart, completeMultipartUpload } from '@vercel/blob/client'

/** Blob requires >= 5 MB per part except the last. Smallest legal size →
 *  most frequent acks → smoothest measured rate. */
const PART_BYTES = 5 * 1024 * 1024
const INITIAL_CONCURRENCY = 3
const MIN_CONCURRENCY = 2
const MAX_CONCURRENCY = 6
/** How often the controller re-evaluates parallelism. */
const TICK_MS = 5000
/** Progress/speed is pushed to the UI on this cadence (rate-limited ramp). */
const REPORT_MS = 200
/** Rolling window for the acked-bytes speed measurement. */
const SPEED_WINDOW_MS = 15_000
/** Absolute minimum before a part can be called stuck. */
const STALL_MIN_MS = 20_000
/** Before we know the link speed, wait this long for the first acks. */
const STALL_UNKNOWN_MS = 90_000
const STALL_MAX_MS = 180_000
const MAX_PART_ATTEMPTS = 8
/** Gap between launching consecutive parts so they finish out of phase. */
const STAGGER_MS = 400

export interface FastUploadProgress {
  loaded: number
  total: number
  /** 0-100 */
  percentage: number
  /** bytes / second actually acknowledged by storage; null until measured. */
  speed: number | null
  /** Parts currently in flight. */
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
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

export async function fastBlobUpload(file: File, opts: FastUploadOptions): Promise<void> {
  const { token, pathname, signal } = opts
  const contentType = opts.contentType || file.type || 'application/octet-stream'
  const maxConcurrency = clamp(opts.concurrency ?? MAX_CONCURRENCY, MIN_CONCURRENCY, MAX_CONCURRENCY)
  const total = file.size

  const { key, uploadId } = await createMultipartUpload(pathname, {
    access: 'private',
    token,
    contentType,
    abortSignal: signal,
  })

  const partCount = Math.max(1, Math.ceil(total / PART_BYTES))
  const results: PartResult[] = new Array(partCount)

  // ---- Byte accounting -------------------------------------------------------
  /** Bytes of parts acknowledged by Blob — the only number we trust. */
  let committed = 0
  /** Bytes the browser has handed to the network per in-flight part
   *  (buffered, NOT necessarily delivered). Reset on retry. */
  const buffered = new Float64Array(partCount)
  const bufferedTotal = () => {
    let n = committed
    for (let i = 0; i < partCount; i++) n += buffered[i]
    return n
  }

  // ---- Acked-rate measurement -----------------------------------------------
  const startedAt = performance.now()
  const ackSamples: { t: number; committed: number }[] = [{ t: startedAt, committed: 0 }]
  /** Smoothed acknowledged throughput (bytes/s). 0 until the first ack. */
  let ackRate = 0
  let lastAckAt = startedAt

  function recordAck(now: number) {
    lastAckAt = now
    ackSamples.push({ t: now, committed })
    while (ackSamples.length > 2 && now - ackSamples[0].t > SPEED_WINDOW_MS) ackSamples.shift()
    const first = ackSamples[0]
    const dt = (now - first.t) / 1000
    if (dt >= 0.5) {
      const windowRate = (committed - first.committed) / dt
      ackRate = ackRate > 0 ? ackRate * 0.7 + windowRate * 0.3 : windowRate
    }
  }

  /** Best current estimate of the wire speed for the progress ramp. Before the
   *  first ack we use half the buffered rate as a conservative guess so the
   *  bar moves but cannot run far ahead of reality. */
  function estimatedRate(now: number) {
    if (ackRate > 0) {
      // If acks have gone quiet for much longer than the window suggests,
      // taper the estimate so the ramp slows instead of over-shooting.
      const quiet = (now - lastAckAt) / 1000
      const expectedGap = ackRate > 0 ? (PART_BYTES / ackRate) * 1.5 : 0
      return quiet > expectedGap && expectedGap > 0 ? ackRate * clamp(expectedGap / quiet, 0.2, 1) : ackRate
    }
    const elapsed = (now - startedAt) / 1000
    return elapsed > 0.5 ? (bufferedTotal() / elapsed) * 0.5 : 0
  }

  // ---- Rate-limited progress ramp -------------------------------------------
  let displayed = 0
  let lastReportAt = startedAt

  function report(now = performance.now()) {
    const dt = Math.max(0, (now - lastReportAt) / 1000)
    lastReportAt = now
    const rate = estimatedRate(now)
    // Advance smoothly at the estimated speed, never beyond bytes actually
    // handed to the network, never below what storage has acknowledged.
    const ceiling = bufferedTotal()
    displayed = clamp(Math.max(displayed, committed), displayed + rate * dt, ceiling)
    displayed = Math.max(displayed, committed)
    displayed = Math.min(displayed, ceiling, total)
    opts.onProgress?.({
      loaded: displayed,
      total,
      percentage: total > 0 ? (displayed / total) * 100 : 100,
      speed: ackRate > 0 ? ackRate : null,
      inFlight: active,
    })
  }

  // ---- Adaptive controller state -------------------------------------------
  let target = Math.min(INITIAL_CONCURRENCY, maxConcurrency, partCount)
  let active = 0
  let next = 0
  let failed: unknown = null
  /** Real stalls / transient errors since the last controller tick. */
  let incidents = 0
  let lastTickRate = 0

  function controllerTick() {
    if (incidents > 0) {
      // The pipe is oversubscribed for this link — shed a part.
      target = Math.max(MIN_CONCURRENCY, target - 1)
    } else if (ackRate > 0 && ackRate > lastTickRate * 1.1 && target < maxConcurrency) {
      // Acked rate is still climbing → one more part may help.
      target = target + 1
    }
    lastTickRate = ackRate
    incidents = 0
    void fill()
  }

  // ---- Part upload with deadline-based stall watchdog -------------------------
  function stallLimitMs(size: number) {
    if (ackRate <= 0) return STALL_UNKNOWN_MS
    // Time this part *should* need given it shares the link with `active`
    // others, with a 4x safety margin.
    const expected = ((size * Math.max(1, active)) / ackRate) * 1000
    return clamp(expected * 4, STALL_MIN_MS, STALL_MAX_MS)
  }

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
        if (performance.now() - lastProgressAt > stallLimitMs(size)) {
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
            if (clamped > buffered[index]) lastProgressAt = performance.now()
            buffered[index] = clamped
          },
        })
        buffered[index] = 0
        committed += size
        results[index] = { partNumber, etag: res.etag }
        recordAck(performance.now())
        return
      } catch (err) {
        buffered[index] = 0
        if (signal?.aborted) throw err
        incidents++
        if (attempt + 1 >= MAX_PART_ATTEMPTS) throw err
        if (stalled) {
          await sleep(500)
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
        // Stagger launches so parts finish out of phase and there is always
        // an ack arriving somewhere instead of all of them at once.
        if (active < target && next < partCount) await sleep(STAGGER_MS)
      }
    } finally {
      filling = false
      maybeFinish()
    }
  }

  const ticker = setInterval(controllerTick, TICK_MS)
  const reporter = setInterval(() => report(), REPORT_MS)
  try {
    void fill()
    await allDone
  } finally {
    clearInterval(ticker)
    clearInterval(reporter)
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
  displayed = total
  report()
}
