import fs from 'node:fs'
import path from 'node:path'
import { getScan, saveScan, addLog, scanMediaDir } from './store'
import type { Scan } from './types'
import { probeDuration, chunkShort, cleanupSegments } from './ffmpeg'
import { CHUNK_SECONDS } from './models'
import { deleteEmbeddings } from './twelvelabs'
import { getFile, putFile, storageEnabled } from './storage'
import { MEDIA_DIR, DISK_LIMIT_BYTES } from './paths'

export type MediaKind = 'short' | 'movie'

// Originals live on the EBS disk (DATA_DIR/media/<id>/<kind>.mp4) — that is
// what ffmpeg reads. Each file is copied to S3 (media/<id>/<kind>.mp4) in the
// background for durability; if the local file ever goes missing (fresh
// instance / disk replaced) it is pulled back down from S3 on demand.

export function mediaStorageKey(id: string, kind: MediaKind): string {
  return `media/${id}/${kind}.mp4`
}

export function localMediaPath(id: string, kind: MediaKind): string {
  return path.join(scanMediaDir(id), `${kind}.mp4`)
}

// Only one download per (id, kind) at a time — parallel requests share it.
const inflight = new Map<string, Promise<string | null>>()

/**
 * Make sure the video exists locally for ffmpeg/preview. Only hits S3 when
 * the local file is missing. Pass force=true to replace a stale local copy.
 */
export async function ensureLocalMedia(id: string, kind: MediaKind, force = false): Promise<string | null> {
  const local = localMediaPath(id, kind)
  if (!force && fs.existsSync(/*turbopackIgnore: true*/ local) && fs.statSync(local).size > 0) return local
  if (!storageEnabled()) return null

  const key = `${id}/${kind}`
  const existing = inflight.get(key)
  if (existing) return existing

  const job = (async (): Promise<string | null> => {
    try {
      const startedAt = Date.now()
      const ok = await getFile(mediaStorageKey(id, kind), local)
      if (!ok) return null
      console.log(`[media] restored ${kind} of ${id} from S3 in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
      return local
    } catch (err) {
      console.error('[media] download from S3 failed:', err instanceof Error ? err.message : err)
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, job)
  return job
}

// ---------- Local → S3 mirror ----------
// Runs in the background right after an upload finishes — never blocks the
// user, ffmpeg starts on the local file immediately. De-duplicated per
// (id, kind).

const mirroring = new Map<string, Promise<boolean>>()

export function mirrorMediaToStorage(id: string, kind: MediaKind, contentType = 'video/mp4'): Promise<boolean> {
  const key = `${id}/${kind}`
  const existing = mirroring.get(key)
  if (existing) return existing

  const job = (async (): Promise<boolean> => {
    const local = localMediaPath(id, kind)
    try {
      if (!storageEnabled()) return false
      if (!fs.existsSync(/*turbopackIgnore: true*/ local)) return false
      const size = fs.statSync(local).size
      if (size === 0) return false
      const startedAt = Date.now()
      await putFile(mediaStorageKey(id, kind), local, contentType)
      console.log(`[media] backed up ${kind} of ${id} to S3 (${(size / 1048576).toFixed(1)} MB in ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
      return true
    } catch (err) {
      console.error('[media] S3 backup failed:', err instanceof Error ? err.message : err)
      return false
    } finally {
      mirroring.delete(key)
    }
  })()
  mirroring.set(key, job)
  return job
}

// ---------- Storage usage (local EBS disk) ----------

export const STORAGE_LIMIT_BYTES = DISK_LIMIT_BYTES

let usageCache: { used: number; at: number } | null = null

function dirSize(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSize(p)
      else if (e.isFile()) total += fs.statSync(p).size
    } catch {
      // file vanished mid-walk
    }
  }
  return total
}

/** Bytes used by all scan media on the local disk. Cached for 30s. */
export async function getStorageUsage(): Promise<number> {
  if (usageCache && Date.now() - usageCache.at < 30_000) return usageCache.used
  const used = dirSize(MEDIA_DIR)
  usageCache = { used, at: Date.now() }
  return used
}

export function invalidateUsageCache() {
  usageCache = null
}

/** Free bytes on the volume that holds DATA_DIR (for /api/health). */
export function diskFree(): { free: number; total: number } {
  try {
    const st = fs.statfsSync(MEDIA_DIR)
    return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) }
  } catch {
    return { free: 0, total: 0 }
  }
}

// ---------- Post-upload finalize ----------
// Runs after the browser uploaded the video straight to the server (local
// disk): probe duration, set up segments/chunk state, cut scan copies.
// No Blob round-trip — ffmpeg works on the local file immediately.

export async function finalizeUploadedMedia(
  scan: Scan,
  kind: MediaKind,
  name: string,
): Promise<{ ok: true; duration: number; size: number } | { ok: false; error: string }> {
  const id = scan.id
  const dest = localMediaPath(id, kind)
  if (!fs.existsSync(/*turbopackIgnore: true*/ dest) || fs.statSync(dest).size === 0) {
    return { ok: false, error: 'Video not found on the server — upload may have failed. Please try again.' }
  }
  const size = fs.statSync(/*turbopackIgnore: true*/ dest).size
  const mediaDir = scanMediaDir(id)

  // A fresh short/movie upload invalidates any previous auto-merge pipeline
  // output — stale merged.mp4 / asset / embeddings / segmentation must never
  // be reused (dono kinds ki embeddings ek hi merged index se aati hain).
  try {
    const staleMerged = path.join(mediaDir, 'merged.mp4')
    if (fs.existsSync(/*turbopackIgnore: true*/ staleMerged)) fs.unlinkSync(staleMerged)
  } catch {
    // ignore cleanup failure
  }
  if (scan.mergePipeline && scan.mergePipeline.status !== 'idle') {
    scan.mergePipeline = { status: 'idle' }
  }
  await Promise.all([deleteEmbeddings(id, 'short'), deleteEmbeddings(id, 'movie')])
  if (scan.twelveLabs && scan.twelveLabs.status !== 'none') {
    scan.twelveLabs = { status: 'none' }
  }

  let duration: number
  try {
    duration = await probeDuration(dest)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[media] probeDuration failed:', msg)
    // Binary missing/setup failure is a SERVER problem, not a bad video.
    if (msg.includes('binary not found') || msg.includes('ENOENT')) {
      return { ok: false, error: 'Video processing setup failed on the server. Please try again in a moment.' }
    }
    // A missing moov atom means the file was cut off mid-transfer (or is still
    // downloading/syncing on the user's device) — the video itself may be fine.
    if (msg.includes('moov atom not found')) {
      return {
        ok: false,
        error: 'The file arrived incomplete (missing MP4 index). If it is syncing from cloud storage, wait for it to finish downloading, then upload again.',
      }
    }
    // Surface the real ffprobe reason so "invalid video" errors are debuggable.
    const detail = msg.replace(/^ffprobe exited \d+:\s*/i, '').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200)
    return {
      ok: false,
      error: `Could not read video file. Is it a valid video?${detail ? ` (${detail})` : ''}`,
    }
  }

  if (kind === 'short') {
    // The ORIGINAL short is NEVER overwritten: preview, verifier clips and the
    // render pipeline use it at full quality. Scanning uses separate re-encoded
    // 1-minute segment files cut in the background.
    scan.shortName = name
    scan.shortSize = size
    scan.shortDuration = duration
    const segCount = Math.max(1, Math.ceil(duration / CHUNK_SECONDS))
    scan.shortSegments = Array.from({ length: segCount }, (_, i) => ({
      index: i,
      start: i * CHUNK_SECONDS,
      end: Math.min((i + 1) * CHUNK_SECONDS, duration),
      status: 'pending' as const,
      chunks: [],
    }))
    scan.currentShortSegment = 0
    scan.shortSegmentingProgress = 0
    addLog(
      scan,
      'info',
      segCount > 1
        ? `Short video uploaded: ${name} (${fmtDur(duration)}) — scanned minute-by-minute (${segCount} segments), original preserved`
        : `Short video uploaded: ${name} (${fmtDur(duration)}) — original preserved, scan copy cut in background`,
    )
    saveScan(scan, { immediate: true })

    // Background: cut 24 fps / 640px scan segments — original untouched.
    const segDir = path.join(mediaDir, 'segments')
    void (async () => {
      try {
        cleanupSegments(segDir)
        const actual = await chunkShort(dest, segDir, duration, (pct) => {
          const s = getScan(id)
          if (s) {
            s.shortSegmentingProgress = pct
            saveScan(s)
          }
        })
        const s = getScan(id)
        if (s) {
          s.shortSegmentingProgress = 100
          if (actual !== s.shortSegments?.length) {
            s.shortSegments = Array.from({ length: actual }, (_, i) => ({
              index: i,
              start: i * CHUNK_SECONDS,
              end: Math.min((i + 1) * CHUNK_SECONDS, duration),
              status: 'pending' as const,
              chunks: [],
            }))
          }
          addLog(s, 'success', `Short scan segments ready: ${actual} × 1-minute file(s) at 24 fps`)
          saveScan(s)
        }
      } catch (err) {
        const s = getScan(id)
        if (s) {
          s.shortSegmentingProgress = 100
          addLog(s, 'warn', `Short segment cutting failed (segments will be re-cut on demand during the scan): ${err instanceof Error ? err.message : String(err)}`)
          saveScan(s)
        }
      }
    })()
  } else {
    scan.movieName = name
    scan.movieSize = size
    scan.movieDuration = duration
    // Chunking WAITS for the trim confirmation — the user can select just the
    // range that holds their scene (saves API quota) or confirm the full movie.
    scan.chunkCount = 0
    scan.chunks = []
    scan.awaitingTrim = true
    scan.movieTrimStart = undefined
    scan.movieTrimEnd = undefined
    scan.status = 'created'
    scan.chunkingProgress = 0
    addLog(
      scan,
      'info',
      `Movie uploaded: ${name} (${fmtDur(duration)}) — select a trim range (optional) and confirm to start chunking`,
    )
  }

  saveScan(scan, { immediate: true })
  invalidateUsageCache()
  return { ok: true, duration, size }
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`
}
