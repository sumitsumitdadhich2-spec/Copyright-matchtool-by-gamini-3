import 'server-only'

import path from 'node:path'
import { openAsBlob } from 'node:fs'
import type { MinuteSuggestion, PegasusSegment } from './types'

// ---------------------------------------------------------------------------
// TWELVELABS ASSET + PEGASUS 1.5 SEGMENTATION client.
//
// Flow (one upload + one index — fizul kuch nahi):
// 1. POST /v1.3/assets (multipart, method=direct) → assetId, poll until ready
// 2. POST /v1.3/indexes/{indexId}/indexed-assets { asset_id } → Marengo index
//    (existing 'cmt-prefilter' Marengo-only index reused) → poll → video_id
// 3. POST /v1.3/analyze/tasks (model pegasus1.5, time_based_metadata,
//    max_tokens 96000, segment_definitions) → poll → segment results
//
// Segment definitions = user's EXACT screenshot text; only timings dynamic.
// HARD LIMIT: Pegasus segmentation max video duration = 2 hours (caller gates).
// ---------------------------------------------------------------------------

const TL_BASE = 'https://api.twelvelabs.io/v1.3'

export const PEGASUS_MODEL = 'pegasus1.5'
export const PEGASUS_MAX_TOKENS = 96000
export const PEGASUS_MAX_DURATION_SEC = 2 * 60 * 60

export class PegasusError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PegasusError'
  }
}

async function tlFetch(apiKey: string, pathname: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${TL_BASE}${pathname}`, {
    ...init,
    headers: {
      'x-api-key': apiKey,
      ...(init?.headers || {}),
    },
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // non-JSON response body
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'message' in (json as Record<string, unknown>)
        ? String((json as Record<string, unknown>).message)
        : text.slice(0, 300)
    throw new PegasusError(`Twelve Labs ${init?.method || 'GET'} ${pathname} failed (${res.status}): ${msg}`)
  }
  return json
}

function pickId(res: unknown): string | null {
  const r = res as Record<string, unknown> | null
  const id = r?._id || r?.id || (r?.data && ((r.data as Record<string, unknown>)._id || (r.data as Record<string, unknown>).id))
  return id ? String(id) : null
}

// ---------- Assets ----------

/** Upload one local video file as a TwelveLabs ASSET (direct multipart). */
export async function createAsset(apiKey: string, filePath: string): Promise<string> {
  const form = new FormData()
  form.append('method', 'direct')
  const blob = await openAsBlob(filePath)
  form.append('file', blob, path.basename(filePath))
  const res = await tlFetch(apiKey, '/assets', { method: 'POST', body: form })
  const id = pickId(res)
  if (!id) throw new PegasusError('Asset create returned no id')
  return id
}

/** Poll the asset until ready (or failed). */
export async function pollAssetReady(
  apiKey: string,
  assetId: string,
  opts?: { intervalMs?: number; timeoutMs?: number; onTick?: (status: string) => void },
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 8_000
  const timeoutMs = opts?.timeoutMs ?? 2 * 60 * 60_000
  const startedAt = Date.now()
  while (true) {
    const res = (await tlFetch(apiKey, `/assets/${assetId}`)) as Record<string, unknown>
    const status = String(res?.status || (res?.data as Record<string, unknown>)?.status || 'unknown')
    opts?.onTick?.(status)
    if (status === 'ready') return
    if (status === 'failed' || status === 'error') {
      throw new PegasusError(`Asset ${assetId} upload failed (status: ${status})`)
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new PegasusError(`Asset ${assetId} timed out (last status: ${status})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ---------- Index from asset (Marengo embeddings via indexed-assets) ----------

/** Index an existing asset into the Marengo index. Returns the video_id. */
export async function indexAsset(
  apiKey: string,
  indexId: string,
  assetId: string,
  opts?: { intervalMs?: number; timeoutMs?: number; onTick?: (status: string) => void },
): Promise<string> {
  const created = (await tlFetch(apiKey, `/indexes/${indexId}/indexed-assets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asset_id: assetId }),
  })) as Record<string, unknown>
  const indexedAssetId = pickId(created)
  if (!indexedAssetId) throw new PegasusError('indexed-assets create returned no id')

  const intervalMs = opts?.intervalMs ?? 10_000
  const timeoutMs = opts?.timeoutMs ?? 4 * 60 * 60_000
  const startedAt = Date.now()
  while (true) {
    const res = (await tlFetch(apiKey, `/indexes/${indexId}/indexed-assets/${indexedAssetId}`)) as Record<
      string,
      unknown
    >
    const data = (res?.data as Record<string, unknown>) || res
    const status = String(data?.status || 'unknown')
    opts?.onTick?.(status)
    if (status === 'ready') {
      const videoId = data?.video_id || data?.videoId || res?.video_id
      if (videoId) return String(videoId)
      // Defensive fallback: resolve the newest video in the index.
      const listed = (await tlFetch(apiKey, `/indexes/${indexId}/videos?page_limit=1&sort_by=created_at&sort_option=desc`)) as {
        data?: Record<string, unknown>[]
      }
      const vid = listed?.data?.[0]?._id || listed?.data?.[0]?.id
      if (vid) return String(vid)
      throw new PegasusError('indexed-asset ready but no video_id resolvable')
    }
    if (status === 'failed' || status === 'error') {
      throw new PegasusError(`Indexed-asset ${indexedAssetId} failed (status: ${status})`)
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new PegasusError(`Indexed-asset ${indexedAssetId} timed out (last status: ${status})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ---------- Segment definitions (EXACT screenshot text, dynamic timings) ----------

function hms(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export interface SegmentDefinition {
  id: string
  description: string
  fields: { name: string; type: string; description: string }[]
}

/**
 * ACCURACY-FIRST two-task design (playground test analysis se sudhara):
 *
 * TASK A (short video ONLY — tiny input, time-bound violations impossible):
 *   segment_1 shot cuts, segment_2 person tracking, segment_3 text overlays.
 *
 * TASK B (merged video — FULL token budget sirf matching ke liye):
 *   segment_4 PART A → PART B frame matching. Playground me example
 *   timestamp "(e.g. 00:05:52)" ne model ko anchor kar diya tha (pehle ~47
 *   matches sab wahi value the) — is liye example REMOVED, strict format
 *   rules + anti-anchoring instructions added, faltu fields (type_part,
 *   confidence) hataye taaki tokens matching par kharch hon.
 */

/** Segments 1–3 — run on the SHORT (PART A) video alone. */
export function buildPartADefinitions(shortEndSec: number): SegmentDefinition[] {
  const shortEnd = hms(shortEndSec)
  return [
    {
      id: 'segment_1',
      description: `Detect every shot cut in this video (00:00:00 to ${shortEnd}). Find real editorial cuts where the image changes to a new shot. Output each shot with its start/end time. Segments must have IRREGULAR durations matching the real cuts - do not output uniform fixed-length segments.`,
      fields: [
        { name: 'type_angle_type', type: 'string', description: 'Camera angle: wide, medium, close_up, overhead, aerial' },
        { name: 'type_description', type: 'string', description: 'Who is in frame, action, background' },
      ],
    },
    {
      id: 'segment_2',
      description: `Track every person visible in this video (00:00:00 to ${shortEnd}). For each new person appearing on screen create a new segment.`,
      fields: [
        { name: 'person', type: 'string', description: 'Physical description of person - clothing, hair, distinguishing features' },
        { name: 'activity', type: 'string', description: 'What the person is doing in this segment' },
        { name: 'speaking', type: 'boolean', description: 'Is this person speaking dialogue' },
      ],
    },
    {
      id: 'segment_3',
      description: `Detect all burned-in text overlays visible in this video (00:00:00 to ${shortEnd}). These are text captions added on top of movie frames by the uploader. Ignore original movie subtitles.`,
      fields: [
        { name: 'text_content', type: 'string', description: 'Exact text visible on screen as overlay' },
        { name: 'is_overlay', type: 'boolean', description: 'Is this text burned on top of video by uploader (not original movie text)' },
        { name: 'position', type: 'string', description: 'Where on screen is the text' },
      ],
    },
  ]
}

/** segment_4 ALONE — run on the MERGED video with the full token budget. */
export function buildMatchDefinitions(shortEndSec: number, mergedEndSec: number): SegmentDefinition[] {
  const shortEnd = hms(shortEndSec)
  const partBStart = hms(shortEndSec + 1)
  const mergedEnd = hms(mergedEndSec)
  return [
    {
      id: 'segment_4',
      description:
        `This video has TWO parts. PART A (00:00:00 to ${shortEnd}) is a short edited reel made from clips of a movie. PART B (${partBStart} to ${mergedEnd}) is the full original movie. ` +
        `Create segments ONLY inside PART A (every segment start_time and end_time must be between 00:00:00 and ${shortEnd}). Each segment is one editorial cut / continuous shot of PART A. Segments must have IRREGULAR durations matching the real cuts. ` +
        `For each PART A segment, visually search PART B and report the timestamp in PART B where the SAME frames appear (same actors, same action, same background). Ignore any burned-in text overlays when matching - compare the underlying movie frames only. ` +
        `part_b_timestamp rules: format strictly hh:mm:ss with leading zeros; the value MUST be between ${partBStart} and ${mergedEnd}; each segment's timestamp must come from actually locating that scene in PART B - different PART A scenes normally map to DIFFERENT PART B timestamps, so never repeat one timestamp as a filler. If you cannot find the scene in PART B, output NO_MATCH instead of guessing.`,
      fields: [
        { name: 'part_b_timestamp', type: 'string', description: 'Timestamp in PART B (hh:mm:ss) where the same frames appear, or NO_MATCH if not found' },
        { name: 'match_type', type: 'string', description: 'exact / near-duplicate / NO_MATCH' },
        { name: 'proof', type: 'string', description: '5 words describing what makes these frames identical - actor, action, background' },
      ],
    },
  ]
}

// ---------- Segmentation task (analyze/tasks) ----------

/** Create a Pegasus 1.5 time_based_metadata segmentation task on an asset. */
export async function createSegmentationTask(
  apiKey: string,
  assetId: string,
  defs: SegmentDefinition[],
): Promise<string> {
  const res = await tlFetch(apiKey, '/analyze/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_name: PEGASUS_MODEL,
      analysis_mode: 'time_based_metadata',
      video: { type: 'asset_id', asset_id: assetId },
      max_tokens: PEGASUS_MAX_TOKENS,
      response_format: {
        type: 'segment_definitions',
        segment_definitions: defs,
      },
    }),
  })
  const id = pickId(res)
  if (!id) throw new PegasusError('Segmentation task create returned no id')
  return id
}

export type SegmentationResult = Record<string, PegasusSegment[]>

function toSeconds(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    // "hh:mm:ss" / "mm:ss" / plain number string
    const m = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/)
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    const m2 = v.match(/^(\d+):(\d+(?:\.\d+)?)$/)
    if (m2) return Number(m2[1]) * 60 + Number(m2[2])
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

/** Defensive parse of analyze/tasks result.data (JSON string OR object). */
export function parseSegmentationResult(raw: unknown): SegmentationResult {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      throw new PegasusError('Segmentation result was not valid JSON')
    }
  }
  const out: SegmentationResult = {}
  if (!data || typeof data !== 'object') return out
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const segs: PegasusSegment[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      const start = toSeconds(rec.start_time ?? rec.start ?? rec.start_sec)
      const end = toSeconds(rec.end_time ?? rec.end ?? rec.end_sec)
      const metadata =
        rec.metadata && typeof rec.metadata === 'object'
          ? (rec.metadata as Record<string, unknown>)
          : // some responses flatten fields onto the item itself
            (Object.fromEntries(
              Object.entries(rec).filter(([k]) => !['start_time', 'end_time', 'start', 'end', 'start_sec', 'end_sec'].includes(k)),
            ) as Record<string, unknown>)
      segs.push({ start, end, metadata })
    }
    out[key] = segs
  }
  return out
}

/** Poll a segmentation task until ready. Returns the parsed per-definition segments. */
export async function pollSegmentationTask(
  apiKey: string,
  taskId: string,
  opts?: { intervalMs?: number; timeoutMs?: number; onTick?: (status: string) => void },
): Promise<SegmentationResult> {
  const intervalMs = opts?.intervalMs ?? 10_000
  const timeoutMs = opts?.timeoutMs ?? 2 * 60 * 60_000
  const startedAt = Date.now()
  while (true) {
    const res = (await tlFetch(apiKey, `/analyze/tasks/${taskId}`)) as Record<string, unknown>
    const status = String(res?.status || 'unknown')
    opts?.onTick?.(status)
    if (status === 'ready' || status === 'completed' || status === 'done') {
      const result = (res?.result as Record<string, unknown>) || res
      const data = result?.data ?? res?.data
      if (data === undefined || data === null) {
        throw new PegasusError('Segmentation task ready but returned no result data')
      }
      return parseSegmentationResult(data)
    }
    if (status === 'failed' || status === 'error') {
      const errMsg = res?.error ? ` — ${String(res.error).slice(0, 200)}` : ''
      throw new PegasusError(`Segmentation task ${taskId} failed (status: ${status})${errMsg}`)
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new PegasusError(`Segmentation task ${taskId} timed out (last status: ${status})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ---------- segment_4 → minute suggestions ----------

/** A timestamp value repeated this many+ times = anchoring/filler spam. */
const REPEAT_SPAM_THRESHOLD = 5

/**
 * Build the "in movie minutes ko check karna hai" list from segment_4.
 * part_b_timestamp is MERGED-video time — original-movie seconds =
 * mergedSec − shortDuration.
 *
 * Validation (playground failure modes se seekha):
 * - NO_MATCH / empty → skip
 * - Segment jo PART A ke bahar start hota hai (model PART B me wander) → skip
 * - Timestamp PART A ke andar ya movie duration ke bahar → skip
 * - Ek hi exact timestamp REPEAT_SPAM_THRESHOLD+ baar (anchoring spam,
 *   e.g. playground me "00:05:52" ×47) → un sab entries ko suspicious
 *   maan kar drop karo
 */
export function buildMinuteSuggestions(
  segment4: PegasusSegment[],
  shortDuration: number,
  movieDuration?: number,
): { suggestions: MinuteSuggestion[]; skipped: number; suspicious: number } {
  // Pass 1: count exact timestamp values to detect anchoring/filler spam.
  const tsCounts = new Map<string, number>()
  for (const seg of segment4) {
    const ts = seg.metadata?.part_b_timestamp
    if (ts === undefined || ts === null) continue
    const key = String(ts).trim()
    if (key === '' || key.toUpperCase() === 'NO_MATCH') continue
    tsCounts.set(key, (tsCounts.get(key) || 0) + 1)
  }
  const spamValues = new Set<string>()
  for (const [key, count] of tsCounts) {
    if (count >= REPEAT_SPAM_THRESHOLD) spamValues.add(key)
  }

  const buckets = new Map<number, { count: number; confidences: string[]; windows: { start: number; end: number }[] }>()
  let skipped = 0
  let suspicious = 0
  for (const seg of segment4) {
    const tsRaw = seg.metadata?.part_b_timestamp
    const ts = tsRaw === undefined || tsRaw === null ? '' : String(tsRaw).trim()
    if (ts === '' || ts.toUpperCase() === 'NO_MATCH') {
      skipped++
      continue
    }
    if (spamValues.has(ts)) {
      // Same value spammed across many segments — anchored/filler, not a real match.
      suspicious++
      continue
    }
    if (seg.start >= shortDuration) {
      // Segment PART A ke bahar hai — model ne bound ignore kiya, trust nahi.
      skipped++
      continue
    }
    const mergedSec = toSeconds(ts)
    const movieSec = mergedSec - shortDuration
    if (movieSec < 0) {
      // timestamp PART A ke andar hai — trust nahi kar sakte, skip.
      skipped++
      continue
    }
    if (movieDuration !== undefined && movieSec > movieDuration + 60) {
      // Movie ke end se aage ka timestamp — hallucination, skip.
      skipped++
      continue
    }
    const minute = Math.floor(movieSec / 60)
    const bucket = buckets.get(minute) || { count: 0, confidences: [], windows: [] }
    bucket.count++
    const conf = seg.metadata?.confidence ?? seg.metadata?.match_type
    if (conf !== undefined && conf !== null && String(conf).trim() !== '') bucket.confidences.push(String(conf))
    // PART A window this scene came from (short seconds, clamped to PART A).
    const wStart = Math.max(0, Math.min(seg.start, shortDuration))
    const wEnd = Math.max(wStart, Math.min(seg.end, shortDuration))
    if (wEnd > wStart) bucket.windows.push({ start: wStart, end: wEnd })
    buckets.set(minute, bucket)
  }
  const suggestions: MinuteSuggestion[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([minute, b]) => ({
      minute,
      sceneCount: b.count,
      confidences: b.confidences,
      shortWindows: b.windows,
    }))
  return { suggestions, skipped, suspicious }
}
