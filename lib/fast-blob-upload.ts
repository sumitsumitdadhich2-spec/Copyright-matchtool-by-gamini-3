/**
 * High-concurrency browser → Vercel Blob multipart uploader.
 *
 * Why not `upload()` from @vercel/blob/client? It is hardcoded to 6 parallel
 * parts of 8 MB and streams the file with memory back-pressure. On a
 * high-latency link (e.g. India → Blob region) each connection is stuck in
 * TCP slow-start / window limits, so 6 in flight cannot fill a fast uplink and
 * throughput sags after the OS send buffers drain (the classic "fast for the
 * first 10-15 %, then slow" symptom).
 *
 * This uploader drives the manual multipart API directly with many more parts
 * in flight, per-part retries, and a rolling (not cumulative) speed estimate.
 */
import { createMultipartUpload, uploadPart, completeMultipartUpload } from '@vercel/blob/client'

/** Blob requires >= 5 MB per part except the last. 8 MB balances part count vs
 *  per-request overhead for GB-scale movies. */
const PART_BYTES = 8 * 1024 * 1024
/** Parts in flight at once. Blob is HTTP/2 so this is not bound by the 6-per-
 *  host limit of HTTP/1.1. 12 saturates ~100 Mbps+ uplinks at 200 ms RTT. */
const DEFAULT_CONCURRENCY = 12
const MAX_PART_RETRIES = 4
/** Rolling window used for the speed readout. */
const SPEED_WINDOW_MS = 4000

export interface FastUploadProgress {
  loaded: number
  total: number
  /** 0-100 */
  percentage: number
  /** bytes / second over the last few seconds; null until enough samples. */
  speed: number | null
}

export interface FastUploadOptions {
  token: string
  pathname: string
  contentType?: string
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (p: FastUploadProgress) => void
}

interface PartResult {
  partNumber: number
  etag: string
}

export async function fastBlobUpload(file: File, opts: FastUploadOptions): Promise<void> {
  const { token, pathname, signal } = opts
  const contentType = opts.contentType || file.type || 'application/octet-stream'
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  const total = file.size

  const { key, uploadId } = await createMultipartUpload(pathname, {
    access: 'private',
    token,
    contentType,
    abortSignal: signal,
  })

  const partCount = Math.max(1, Math.ceil(total / PART_BYTES))
  // Per-part loaded bytes so retries don't double-count progress.
  const loadedByPart = new Float64Array(partCount)
  const samples: { t: number; loaded: number }[] = []

  const report = () => {
    let loaded = 0
    for (let i = 0; i < partCount; i++) loaded += loadedByPart[i]
    const now = performance.now()
    samples.push({ t: now, loaded })
    while (samples.length > 2 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift()
    let speed: number | null = null
    if (samples.length >= 2) {
      const first = samples[0]
      const dt = (now - first.t) / 1000
      if (dt >= 1) speed = Math.max(0, (loaded - first.loaded) / dt)
    }
    opts.onProgress?.({
      loaded,
      total,
      percentage: total > 0 ? (loaded / total) * 100 : 100,
      speed,
    })
  }

  const results: PartResult[] = new Array(partCount)
  let next = 0
  let failed: unknown = null

  async function uploadOne(index: number) {
    const partNumber = index + 1
    const start = index * PART_BYTES
    const end = Math.min(total, start + PART_BYTES)
    const blob = file.slice(start, end)

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
      try {
        const res = await uploadPart(pathname, blob, {
          access: 'private',
          token,
          key,
          uploadId,
          partNumber,
          contentType,
          abortSignal: signal,
          onUploadProgress: ({ loaded }) => {
            loadedByPart[index] = Math.min(loaded, end - start)
            report()
          },
        })
        loadedByPart[index] = end - start
        report()
        results[index] = { partNumber, etag: res.etag }
        return
      } catch (err) {
        loadedByPart[index] = 0
        if (signal?.aborted || attempt >= MAX_PART_RETRIES) throw err
        // Exponential backoff with jitter: 0.5s, 1s, 2s, 4s (+ up to 250 ms).
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250))
      }
    }
  }

  async function worker() {
    while (failed === null) {
      const index = next++
      if (index >= partCount) return
      try {
        await uploadOne(index)
      } catch (err) {
        failed = err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, () => worker()))
  if (failed !== null) throw failed

  await completeMultipartUpload(pathname, results, {
    access: 'private',
    token,
    key,
    uploadId,
    contentType,
    abortSignal: signal,
  })
}
