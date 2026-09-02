import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import type { GoogleGenAI } from '@google/genai'
import { getScan, saveScan, addLog, scanMediaDir, apiKeyHash, getModelUsage, incrementModelUsage, setModelExhausted } from './store'
import { ensureLocalMedia, localMediaPath } from './media'
import { preparePrescanMovieCopy } from './ffmpeg'
import { CHUNK_MODEL_POOL, MODEL_MIN_INTERVAL_MS, RATE_COOLDOWN_MS, type ModelSpec } from './models'
import { getClient, uploadVideo, runMinuteFinderWindow, parseMinuteFinderOutput, classifyError, GeminiError } from './gemini'
import { applyApprovedMinutes } from './minute-ranges'
import { scheduler } from './scheduler'
import { deductTokens, refundTokens, SCAN_TOKEN_COST } from './tokens'
import type { Scan, GeminiPrescanState, GeminiPrescanWindow, GeminiPrescanUpload, MinuteSuggestion } from './types'

// ---------------------------------------------------------------------------
// GEMINI MINUTE FINDER — TwelveLabs/Pegasus alternative (fire-and-forget).
//
//   [1] preparing  — ffmpeg upload-copy of the TRIMMED movie (≤ 1.9 GB)
//   [2] uploading  — short + movie copy → Gemini Files API, ONCE PER API KEY
//   [3] scanning   — fixed 20-minute windows; lanes = every key × the two
//                    chunk models (gemini-3.6-flash / gemini-3.7-flash);
//                    1 request / minute / lane (TPM 250K); shared window queue
//   [4] starting_scan — minute list → per-short-minute movie ranges (shared
//                    helper, same as the Pegasus approve route) → scheduler.start
//   [5] done       — the 24 fps chunk-time scan runs EXACTLY as before
//
// Retry/Resume-safe: done windows never re-run, uploads reused for 47 h,
// the movie copy reused while the trim range is unchanged.
// The chunk-time scan (lib/scheduler.ts) is NOT touched by this module.
// ---------------------------------------------------------------------------

/** Fixed window length: 20 minutes. */
export const MINUTE_FINDER_WINDOW_SEC = 1200
/** Short video hard limit for the minute finder (3 minutes). */
export const MINUTE_FINDER_MAX_SHORT_SEC = 180
/** Gemini files live 48 h — reuse uploads for 47 h. */
const UPLOAD_TTL_MS = 47 * 60 * 60 * 1000
/** NO per-window attempt cap (user decision): any error → the SAME request is
 *  re-queued and sent again after the lane's 1-minute pacing. A window only ends
 *  up `failed` when every lane is dead (RPD exhausted) — Retry revives it. */
const MAX_WINDOW_ATTEMPTS = Number.POSITIVE_INFINITY
/** How long to wait for movie chunking to finish before the chunk scan can start. */
const CHUNKING_WAIT_MS = 45 * 60_000

/** Default clock assumption for a window request with startOffset: Gemini
 *  reports Video 2 timestamps RELATIVE to the clipped window (00:00 = window
 *  start). The parser still auto-detects the "CLOCK: absolute" note and
 *  out-of-range values, so a wrong default only affects ambiguous outputs. */
export const WINDOW_TIMESTAMPS_RELATIVE = true

export interface FinderUser {
  username: string
  role: 'admin' | 'user'
}

interface Lane {
  keyIdx: number
  apiKey: string
  keyId: string
  ai: GoogleGenAI
  model: ModelSpec
  label: string
  dead: boolean
}

interface Ctrl {
  stopping: boolean
  state: GeminiPrescanState
  queue: number[]
  inFlight: Set<number>
  nextFreeAt: Record<string, number>
  cooldownUntil: Record<string, number>
  /** in-flight re-uploads per key (after a file-expired error) */
  reuploads: Map<string, Promise<GeminiPrescanUpload>>
}

const ctrls = new Map<string, Ctrl>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function isMinuteFinderRunning(id: string): boolean {
  return ctrls.has(id)
}

/** Same gate as the TwelveLabs pipeline: both videos in + trim confirmed. */
export function minuteFinderReady(scan: Scan): boolean {
  return Boolean(scan.shortDuration && scan.movieDuration && scan.awaitingTrim === false)
}

function emptyState(): GeminiPrescanState {
  return { status: 'idle', windowLen: MINUTE_FINDER_WINDOW_SEC, uploads: {}, windows: [] }
}

function fmtDur(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s` : `${m}m ${ss}s`
}

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

/** Persist the in-memory state (authoritative) onto a FRESH copy of the scan so
 *  concurrent writers (chunking progress etc.) are never clobbered. */
function persist(id: string, ctrl: Ctrl, patch?: Partial<GeminiPrescanState>) {
  if (patch) Object.assign(ctrl.state, patch)
  // A stopped controller that has already been replaced by a newer run must
  // never overwrite the newer run's state (late in-flight window result).
  const current = ctrls.get(id)
  if (current && current !== ctrl) return
  const s = getScan(id)
  if (!s) return
  s.geminiPrescan = ctrl.state
  saveScan(s)
}

function log(id: string, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  const s = getScan(id)
  if (!s) return
  addLog(s, level, msg)
  saveScan(s)
}

function trimRange(scan: Scan): { trimStart: number; trimEnd: number } {
  return { trimStart: scan.movieTrimStart ?? 0, trimEnd: scan.movieTrimEnd ?? scan.movieDuration ?? 0 }
}

/**
 * Kick off / retry / re-run the Gemini Minute Finder.
 *  - 'start'  : auto-trigger (upload/trim). Skips when already complete for the
 *               SAME trim; a changed trim invalidates copy + windows automatically.
 *  - 'retry'  : re-queue failed/pending windows only (uploads + done windows reused).
 *  - 'rerun'  : reset ALL windows and scan again (uploads + movie copy reused).
 */
export function startGeminiMinuteFinder(
  scanId: string,
  userApiKeys: string[],
  user: FinderUser,
  mode: 'start' | 'retry' | 'rerun' = 'start',
): { ok: boolean; error?: string } {
  const scan = getScan(scanId)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (!minuteFinderReady(scan)) {
    return { ok: false, error: 'Short + movie upload aur trim confirm hone ke baad hi minute finder chalta hai.' }
  }
  if (ctrls.has(scanId)) return { ok: false, error: 'Minute finder already running' }
  if (scheduler.isRunning(scanId)) return { ok: false, error: 'Chunk scan already running' }
  if (userApiKeys.length === 0) {
    return { ok: false, error: 'Gemini API key nahi hai — Settings me apni key add karo.' }
  }

  const prev: GeminiPrescanState = scan.geminiPrescan ? { ...emptyState(), ...scan.geminiPrescan } : emptyState()
  const { trimStart, trimEnd } = trimRange(scan)
  const trimChanged =
    Boolean(prev.movieCopy) && (Math.abs(prev.movieCopy!.trimStart - trimStart) > 0.01 || Math.abs(prev.movieCopy!.trimEnd - trimEnd) > 0.01)

  if (mode === 'start' && !trimChanged && (prev.status === 'done' || prev.status === 'starting_scan')) {
    return { ok: false, error: 'Minute finder already complete for this trim — Re-run use karo.' }
  }

  const state: GeminiPrescanState = {
    ...prev,
    status: 'preparing',
    progress: 'Starting...',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    appliedMinutes: undefined,
  }
  if (trimChanged) {
    // Movie copy + movie uploads are trim-specific; the short uploads stay valid.
    state.movieCopy = undefined
    state.windows = []
    state.minuteSuggestions = undefined
    for (const k of Object.keys(state.uploads)) {
      const u = state.uploads[k]
      state.uploads[k] = { ...u, movieUri: '', movieName: '' }
    }
  }
  if (mode === 'rerun') {
    state.windows = []
    state.minuteSuggestions = undefined
  }
  if (mode === 'retry') {
    for (const w of state.windows) {
      if (w.status === 'failed' || w.status === 'running') {
        w.status = 'pending'
        w.error = undefined
      }
    }
  }

  const ctrl: Ctrl = {
    stopping: false,
    state,
    queue: [],
    inFlight: new Set(),
    nextFreeAt: {},
    cooldownUntil: {},
    reuploads: new Map(),
  }
  ctrls.set(scanId, ctrl)
  persist(scanId, ctrl)
  log(
    scanId,
    'info',
    `Gemini Minute Finder ${mode === 'start' ? 'start' : mode}: movie copy → upload (per key) → 20-min windows @ 5fps/1fps (${CHUNK_MODEL_POOL.map((m) => m.id).join(' + ')} × ${userApiKeys.length} key(s)) → minute list → chunk scan`,
  )

  void run(scanId, ctrl, userApiKeys, user)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      persist(scanId, ctrl, { status: 'error', error: msg, finishedAt: Date.now(), progress: undefined })
      log(scanId, 'error', `Minute finder error: ${msg} — manual Full scan (Start) available hai`)
    })
    .finally(() => {
      ctrls.delete(scanId)
    })
  return { ok: true }
}

export function stopGeminiMinuteFinder(scanId: string): { ok: boolean; error?: string } {
  const ctrl = ctrls.get(scanId)
  if (!ctrl) return { ok: false, error: 'Minute finder is not running' }
  ctrl.stopping = true
  for (const w of ctrl.state.windows) if (w.status === 'running') w.status = 'pending'
  persist(scanId, ctrl, { status: 'error', error: 'Stopped by user', progress: undefined, finishedAt: Date.now() })
  log(scanId, 'warn', 'Minute finder stop requested — Retry se pending windows wahi se continue honge; manual Full scan bhi available hai')
  return { ok: true }
}

/**
 * Stop a running minute finder (if any) and wait until its controller is gone,
 * so a follow-up action (manual Start, new trim, scan delete) never races the
 * finder's own `scheduler.start` / state writes. Resolves `true` when idle.
 */
export async function stopAndWaitMinuteFinder(scanId: string, reason: string, timeoutMs = 15_000): Promise<boolean> {
  const ctrl = ctrls.get(scanId)
  if (!ctrl) return true
  if (!ctrl.stopping) {
    ctrl.stopping = true
    for (const w of ctrl.state.windows) if (w.status === 'running') w.status = 'pending'
    persist(scanId, ctrl, { status: 'error', error: `Stopped: ${reason}`, progress: undefined, finishedAt: Date.now() })
    log(scanId, 'warn', `Minute finder stopped — ${reason}`)
  }
  const deadline = Date.now() + timeoutMs
  while (ctrls.has(scanId) && Date.now() < deadline) await sleep(250)
  return !ctrls.has(scanId)
}

// ---------------------------------------------------------------------------

async function run(id: string, ctrl: Ctrl, apiKeys: string[], user: FinderUser): Promise<void> {
  const scan0 = getScan(id)
  if (!scan0 || !scan0.shortDuration || !scan0.movieDuration) throw new Error('Scan/media state missing')
  const shortDuration = scan0.shortDuration
  const movieDuration = scan0.movieDuration
  const { trimStart, trimEnd } = trimRange(scan0)

  // ---- Pre-checks ----
  if (shortDuration > MINUTE_FINDER_MAX_SHORT_SEC) {
    throw new Error(
      `Short video 3 minute se lamba hai (${fmtDur(shortDuration)}) — Gemini Minute Finder sirf ≤3 min short par chalta hai. Manual Full scan use karo.`,
    )
  }

  const mediaDir = scanMediaDir(id)
  persist(id, ctrl, { status: 'preparing', progress: 'Checking video files...' })
  const shortFile = (await ensureLocalMedia(id, 'short')) || localMediaPath(id, 'short')
  const movieFile = (await ensureLocalMedia(id, 'movie')) || localMediaPath(id, 'movie')
  if (!fs.existsSync(shortFile) || !fs.existsSync(movieFile)) {
    throw new Error('Short/movie file server par nahi mili — dobara upload karke retry karo.')
  }
  if (ctrl.stopping) return

  // ---- [1] Movie upload copy (cached while the trim is unchanged) ----
  const copyPath = path.join(mediaDir, 'prescan-movie.mp4')
  const cachedCopy = ctrl.state.movieCopy
  const copyValid =
    cachedCopy &&
    fs.existsSync(copyPath) &&
    fs.statSync(copyPath).size === cachedCopy.sizeBytes &&
    Math.abs(cachedCopy.trimStart - trimStart) < 0.01 &&
    Math.abs(cachedCopy.trimEnd - trimEnd) < 0.01
  if (copyValid) {
    log(id, 'info', `Movie copy cached (${fmtDur(cachedCopy.durationSec)}, ${fmtMB(cachedCopy.sizeBytes)}) — skip`)
  } else {
    // Any stale copy (different trim) also invalidates the per-key MOVIE uploads.
    for (const k of Object.keys(ctrl.state.uploads)) ctrl.state.uploads[k] = { ...ctrl.state.uploads[k], movieUri: '', movieName: '' }
    ctrl.state.windows = []
    ctrl.state.movieCopy = undefined
    try {
      if (fs.existsSync(copyPath)) fs.unlinkSync(copyPath)
    } catch {
      /* ignore */
    }
    persist(id, ctrl, { status: 'preparing', progress: 'Preparing movie copy...' })
    log(
      id,
      'info',
      `Preparing movie upload copy: ${fmtDur(trimStart)} → ${fmtDur(trimEnd)} (${fmtDur(trimEnd - trimStart)}) — stream copy agar ≤1.9 GB, warna 480p re-encode`,
    )
    let lastPct = -1
    const info = await preparePrescanMovieCopy(movieFile, copyPath, movieDuration, trimStart, trimEnd, (pct, note) => {
      if (pct !== lastPct) {
        lastPct = pct
        persist(id, ctrl, { progress: `Movie copy: ${note} ${pct}%` })
      }
    })
    ctrl.state.movieCopy = { path: copyPath, ...info, trimStart, trimEnd }
    persist(id, ctrl)
    log(
      id,
      'success',
      `Movie copy ready: ${fmtDur(info.durationSec)}, ${fmtMB(info.sizeBytes)} (${info.reencoded ? 're-encoded 480p' : 'stream copy, original quality'})`,
    )
  }
  if (ctrl.stopping) return
  const copyDuration = ctrl.state.movieCopy!.durationSec

  // ---- [2] Uploads: short + movie copy, ONCE PER API KEY (parallel) ----
  // A key whose upload fails (bad key, storage quota, network) is DROPPED from
  // the lane set instead of killing the whole run — the other keys carry on.
  const allKeys = apiKeys.map((k, i) => ({ keyIdx: i + 1, apiKey: k, keyId: apiKeyHash(k), ai: getClient(k) }))
  persist(id, ctrl, { status: 'uploading', progress: `Uploading to Gemini (0/${allKeys.length} keys)...` })
  let uploadedKeys = 0
  const uploadResults = await Promise.all(
    allKeys.map(async (k) => {
      try {
        await ensureUploads(id, ctrl, k.keyId, k.keyIdx, k.ai, shortFile, copyPath)
        uploadedKeys += 1
        persist(id, ctrl, { progress: `Uploading to Gemini (${uploadedKeys}/${allKeys.length} keys)...` })
        return true
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(id, 'error', `Key ${k.keyIdx}: upload failed — is key ko skip kar rahe hain: ${msg.slice(0, 160)}`)
        return false
      }
    }),
  )
  if (ctrl.stopping) return
  const lanesByKey = allKeys.filter((_, i) => uploadResults[i])
  if (lanesByKey.length === 0) {
    throw new Error('Kisi bhi API key par upload nahi hua (short + movie copy) — key/quota check karke Retry karo.')
  }
  log(
    id,
    'success',
    `Uploads ready on ${lanesByKey.length}/${allKeys.length} key(s) (short + movie copy, Files API)${
      lanesByKey.length < allKeys.length ? ` — ${allKeys.length - lanesByKey.length} key(s) skipped` : ''
    }`,
  )

  // ---- Windows: fixed 20-minute slices of the movie copy ----
  if (ctrl.state.windows.length === 0) {
    const windows: GeminiPrescanWindow[] = []
    for (let t = 0, i = 0; t < copyDuration - 0.5; t += MINUTE_FINDER_WINDOW_SEC, i++) {
      windows.push({ index: i, startOffset: t, endOffset: Math.min(t + MINUTE_FINDER_WINDOW_SEC, copyDuration), status: 'pending' })
    }
    ctrl.state.windows = windows
  }
  ctrl.queue = ctrl.state.windows.filter((w) => w.status === 'pending').map((w) => w.index)
  const total = ctrl.state.windows.length
  const pending = ctrl.queue.length
  persist(id, ctrl, { status: 'scanning', progress: `Scanning windows (${total - pending}/${total})` })
  log(
    id,
    'info',
    `${total} window(s) × 20 min${pending < total ? ` — ${total - pending} already done, ${pending} queued` : ''}; lanes: ${lanesByKey.length} key(s) × ${CHUNK_MODEL_POOL.length} models, 1 request/min/lane`,
  )

  // ---- [3] Lanes: every key × both chunk models pull from the shared queue ----
  // Same daily counter as the chunk scan (data/counters.json) — a lane whose
  // model is already at its RPD cap for today is not created at all, exactly
  // like the scheduler skips exhausted models.
  const lanes: Lane[] = []
  const skipped: string[] = []
  for (const k of lanesByKey) {
    for (const m of CHUNK_MODEL_POOL) {
      const label = `key ${k.keyIdx} · ${m.id}`
      if (getModelUsage(m.id, k.apiKey) >= m.rpd) {
        skipped.push(label)
        continue
      }
      lanes.push({ ...k, model: m, label, dead: false })
    }
  }
  if (skipped.length > 0) log(id, 'warn', `${skipped.length} lane(s) already at daily cap (RPD) — skipped: ${skipped.join(', ')}`)
  if (lanes.length === 0) {
    throw new Error('Saari lanes ki daily quota (RPD) khatam hai — kal Retry karo ya manual Full scan use karo.')
  }
  await Promise.all(lanes.map((lane) => laneWorker(id, ctrl, lane, shortFile, copyPath, trimStart, trimEnd)))
  if (ctrl.stopping) return

  // Windows still pending with every lane dead => failed (all keys exhausted).
  for (const w of ctrl.state.windows) {
    if (w.status === 'pending' || w.status === 'running') {
      w.status = 'failed'
      w.error = w.error || 'Saari lanes exhausted (RPD) — Retry failed windows baad me chalao'
    }
  }
  const failed = ctrl.state.windows.filter((w) => w.status === 'failed')
  if (failed.length > 0) {
    log(id, 'warn', `${failed.length} window(s) failed: ${failed.map((w) => `#${w.index} (${fmtDur(w.startOffset)}–${fmtDur(w.endOffset)})`).join(', ')} — minute list baaki windows se ban rahi hai`)
  }

  // ---- Aggregate minute list ----
  const suggestions = buildSuggestions(ctrl.state.windows, trimStart, trimEnd, shortDuration)
  ctrl.state.minuteSuggestions = suggestions
  if (suggestions.length === 0) {
    persist(id, ctrl)
    throw new Error('Gemini Minute Finder ko koi match nahi mila — manual Full scan use karo.')
  }
  const minuteList = suggestions.map((s) => s.minute + 1).join(', ')
  const windowsWithHits = ctrl.state.windows.filter((w) => (w.matches || 0) > 0).length
  persist(id, ctrl, { status: 'starting_scan', progress: `Minutes found: ${minuteList} — starting chunk scan...` })
  log(
    id,
    'success',
    `Minutes found (movie minute, ±1 buffer): ${minuteList} — ${windowsWithHits}/${total} window(s) me match. Chunk scan auto-start...`,
  )

  // ---- [4] Apply minutes (shared helper) + auto-start the chunk scan ----
  {
    const scan = getScan(id)
    if (!scan) throw new Error('Scan missing before chunk scan start')
    const approved = suggestions.map((s) => s.minute)
    const applied = applyApprovedMinutes(scan, approved, suggestions)
    if (!applied.ok) throw new Error(applied.error)
    ctrl.state.appliedMinutes = approved
    scan.geminiPrescan = ctrl.state
    addLog(scan, 'success', `Minute list applied: movie minute(s) ${minuteList} — Gemini chunk scan start ho raha hai`)
    if (applied.rangeNotes.length > 0) addLog(scan, 'info', `Per-minute movie ranges (Gemini Minute Finder se): ${applied.rangeNotes.join('; ')}`)
    saveScan(scan, { immediate: true })
  }

  // The chunk scan needs the 1-minute movie chunks — wait for chunking to finish.
  await waitForChunking(id, ctrl)
  if (ctrl.stopping) return

  // Tokens: same as the approve route (admin never charged).
  let charged = false
  if (user.role !== 'admin') {
    const bal = await deductTokens(user.username, SCAN_TOKEN_COST)
    if (bal === null) {
      throw new Error(`Minutes ready, lekin tokens khatm hain! 1 scan = ${SCAN_TOKEN_COST} tokens. Admin se tokens lo, phir Start dabao.`)
    }
    charged = true
  }
  // tlApiKey = null: chunk set already chosen by the minute finder — no TL pre-filter.
  const result = await scheduler.start(id, false, apiKeys, null)
  if (!result.ok) {
    if (charged) await refundTokens(user.username, SCAN_TOKEN_COST)
    throw new Error(result.error || 'Chunk scan start failed')
  }
  persist(id, ctrl, { status: 'done', progress: undefined, finishedAt: Date.now(), error: null })
  log(id, 'success', 'Chunk scan started on the Gemini Minute Finder minute set (24 fps chunk-time scan — unchanged)')
}

// ---------------------------------------------------------------------------

/** Make sure THIS key has ACTIVE uploads of the short + movie copy (cached ≤ 47 h). */
async function ensureUploads(
  id: string,
  ctrl: Ctrl,
  keyId: string,
  keyIdx: number,
  ai: GoogleGenAI,
  shortFile: string,
  copyPath: string,
): Promise<GeminiPrescanUpload> {
  const cached = ctrl.state.uploads[keyId]
  const fresh = cached && Date.now() - cached.uploadedAt < UPLOAD_TTL_MS
  let shortOk = false
  let movieOk = false
  if (fresh) {
    ;[shortOk, movieOk] = await Promise.all([fileActive(ai, cached.shortName), fileActive(ai, cached.movieName)])
  }
  if (shortOk && movieOk) {
    log(id, 'info', `Key ${keyIdx}: uploads cached (short + movie copy) — skip`)
    return cached!
  }
  const [s, m] = await Promise.all([
    shortOk ? Promise.resolve({ uri: cached!.shortUri, name: cached!.shortName }) : uploadVideo(ai, shortFile),
    movieOk ? Promise.resolve({ uri: cached!.movieUri, name: cached!.movieName }) : uploadVideo(ai, copyPath),
  ])
  const up: GeminiPrescanUpload = {
    shortUri: s.uri,
    shortName: s.name,
    movieUri: m.uri,
    movieName: m.name,
    uploadedAt: Date.now(),
  }
  ctrl.state.uploads[keyId] = up
  persist(id, ctrl)
  log(id, 'info', `Key ${keyIdx}: ${!shortOk && !movieOk ? 'short + movie copy' : !shortOk ? 'short' : 'movie copy'} uploaded (ACTIVE)`)
  return up
}

async function fileActive(ai: GoogleGenAI, name: string | undefined): Promise<boolean> {
  if (!name) return false
  try {
    const f = await ai.files.get({ name })
    return f.state === 'ACTIVE'
  } catch {
    return false
  }
}

/** Force re-upload for a key after Gemini says the file is gone (shared lock per key). */
function reupload(id: string, ctrl: Ctrl, lane: Lane, shortFile: string, copyPath: string): Promise<GeminiPrescanUpload> {
  const existing = ctrl.reuploads.get(lane.keyId)
  if (existing) return existing
  ctrl.state.uploads[lane.keyId] = { ...(ctrl.state.uploads[lane.keyId] || ({} as GeminiPrescanUpload)), uploadedAt: 0 }
  const p = ensureUploads(id, ctrl, lane.keyId, lane.keyIdx, lane.ai, shortFile, copyPath).finally(() => ctrl.reuploads.delete(lane.keyId))
  ctrl.reuploads.set(lane.keyId, p)
  return p
}

function isFileGoneError(msg: string): boolean {
  const l = msg.toLowerCase()
  return (
    (l.includes('403') || l.includes('404') || l.includes('permission') || l.includes('not found') || l.includes('expired')) &&
    (l.includes('file') || l.includes('files/'))
  )
}

// ---------------------------------------------------------------------------

async function laneWorker(
  id: string,
  ctrl: Ctrl,
  lane: Lane,
  shortFile: string,
  copyPath: string,
  trimStart: number,
  trimEnd: number,
): Promise<void> {
  const rk = lane.label
  while (true) {
    if (ctrl.stopping || lane.dead) return

    const cool = ctrl.cooldownUntil[rk] || 0
    if (cool > Date.now()) {
      await sleep(Math.min(2000, cool - Date.now()))
      continue
    }

    const idx = ctrl.queue.shift()
    if (idx === undefined) {
      if (ctrl.inFlight.size === 0) return
      await sleep(1000)
      continue
    }
    const w = ctrl.state.windows[idx]
    if (!w || w.status !== 'pending') continue

    ctrl.inFlight.add(idx)
    w.status = 'running'
    w.lane = lane.label
    w.error = undefined
    persist(id, ctrl)

    try {
      // Pacing: 1 request per minute per lane (TPM 250K). Uploads are already
      // done, so the wait is pure spacing.
      const wait = (ctrl.nextFreeAt[rk] || 0) - Date.now()
      if (wait > 0) await sleep(wait)
      if (ctrl.stopping) {
        w.status = 'pending'
        persist(id, ctrl)
        return
      }
      const up = ctrl.state.uploads[lane.keyId]
      if (!up?.shortUri || !up?.movieUri) throw new Error('files/ missing upload for this key')

      // Daily cap reached during the run (shared counter with the chunk scan) —
      // retire this lane, hand the window back to the queue for another lane.
      if (getModelUsage(lane.model.id, lane.apiKey) >= lane.model.rpd) {
        lane.dead = true
        w.status = 'pending'
        ctrl.queue.unshift(idx)
        persist(id, ctrl)
        log(id, 'warn', `${lane.label}: daily cap (${lane.model.rpd} RPD) reached — lane retired, window #${w.index} re-queued`)
        return
      }

      ctrl.nextFreeAt[rk] = Date.now() + MODEL_MIN_INTERVAL_MS
      incrementModelUsage(lane.model.id, lane.apiKey)
      w.attempts = (w.attempts || 0) + 1
      log(id, 'info', `Window #${w.index} (${fmtDur(w.startOffset)}–${fmtDur(w.endOffset)}): short @5fps + window @1fps on ${lane.label}`)

      const { text, tokens } = await runMinuteFinderWindow(lane.ai, lane.model.id, up.shortUri, up.movieUri, w.startOffset, w.endOffset)
      const parsed = parseMinuteFinderOutput(text, w.startOffset, w.endOffset, WINDOW_TIMESTAMPS_RELATIVE)

      // Parse sanity: no hits AND no recognizable HISSA 3 / NOT FOUND => retry.
      const recognizable =
        parsed.hits.length > 0 ||
        parsed.matchMinutes.length > 0 ||
        parsed.possibleMinutes.length > 0 ||
        /NOT\s*(IN\s*THIS\s*WINDOW|FOUND)|MINUTES\s*:\s*NONE|WINDOW\s*VERDICT/i.test(text)
      if (!recognizable) throw new GeminiError('other', 'Output me HISSA 2/3 format nahi mila (parse fail)')

      const minutes = minutesFromWindow(parsed, w, trimStart, trimEnd)
      w.raw = text
      w.tokens = tokens ?? undefined
      w.matches = parsed.hits.length
      w.minutes = minutes
      w.status = 'done'
      const done = ctrl.state.windows.filter((x) => x.status === 'done').length
      persist(id, ctrl, { progress: `Scanning windows (${done}/${ctrl.state.windows.length})` })
      log(
        id,
        parsed.hits.length > 0 ? 'success' : 'info',
        `Window #${w.index}: ${parsed.hits.length} hit(s)${minutes.length ? ` → movie minute(s) ${minutes.map((m) => m + 1).join(', ')}` : ' — NOT IN THIS WINDOW'}${
          tokens ? ` · ${tokens.toLocaleString()} tokens` : ''
        }${parsed.clockAbsolute ? ' · CLOCK: absolute' : ''} (${lane.label})`,
      )
    } catch (err) {
      const e = err instanceof GeminiError ? err : classifyError(err)
      if (e.kind === 'rpd' || e.kind === 'unavailable') {
        setModelExhausted(lane.model.id, lane.apiKey, lane.model.rpd)
        lane.dead = true
        w.status = 'pending'
        ctrl.queue.push(idx)
        log(id, 'warn', `${lane.label}: ${e.kind === 'rpd' ? 'daily quota exhausted' : 'model unavailable'} — lane removed, window #${w.index} re-queued`)
      } else if (e.kind === 'rate') {
        // 429 RPM/TPM: cooldown, then send the SAME request again (unlimited).
        ctrl.cooldownUntil[rk] = Date.now() + RATE_COOLDOWN_MS
        w.status = 'pending'
        ctrl.queue.push(idx)
        log(id, 'warn', `Window #${w.index}: 429 on ${lane.label} — 60s cooldown, re-queued: ${e.message.slice(0, 100)}`)
      } else if (isFileGoneError(e.message)) {
        w.status = 'pending'
        ctrl.queue.push(idx)
        log(id, 'warn', `${lane.label}: uploaded file missing/expired — re-uploading for this key, window #${w.index} re-queued`)
        try {
          await reupload(id, ctrl, lane, shortFile, copyPath)
        } catch (upErr) {
          log(id, 'error', `Key ${lane.keyIdx}: re-upload failed: ${upErr instanceof Error ? upErr.message : String(upErr)}`)
          lane.dead = true
        }
      } else if ((w.attempts || 0) >= MAX_WINDOW_ATTEMPTS) {
        w.status = 'failed'
        w.error = e.message.slice(0, 200)
        log(id, 'error', `Window #${w.index} failed after ${w.attempts} attempt(s): ${e.message.slice(0, 140)}`)
      } else {
        w.status = 'pending'
        w.error = e.message.slice(0, 200)
        // Put it at the FRONT so a different lane picks it up next.
        ctrl.queue.unshift(idx)
        log(id, 'warn', `Window #${w.index} attempt ${w.attempts} failed on ${lane.label} — re-queued: ${e.message.slice(0, 120)}`)
      }
      persist(id, ctrl)
    } finally {
      ctrl.inFlight.delete(idx)
    }
  }
}

// ---------------------------------------------------------------------------

/** Movie-copy hits → ABSOLUTE original-movie minutes (±1 buffer, clamped to trim). */
function minutesFromWindow(
  parsed: ReturnType<typeof parseMinuteFinderOutput>,
  w: GeminiPrescanWindow,
  trimStart: number,
  trimEnd: number,
): number[] {
  const minMinute = Math.floor(trimStart / 60)
  const maxMinute = Math.floor(Math.max(trimStart, trimEnd - 0.001) / 60)
  const out = new Set<number>()
  const add = (absStart: number, absEnd: number) => {
    const a = Math.floor(absStart / 60) - 1
    const b = Math.floor(Math.max(absStart, absEnd - 0.001) / 60) + 1
    for (let m = a; m <= b; m++) if (m >= minMinute && m <= maxMinute) out.add(m)
  }
  if (parsed.hits.length > 0) {
    for (const h of parsed.hits) add(trimStart + h.fileStart, trimStart + h.fileEnd)
  } else {
    // HISSA 3 fallback: minute numbers on the movie-copy clock.
    for (const n of [...parsed.matchMinutes, ...parsed.possibleMinutes]) {
      const fileT = n * 60
      if (fileT < w.startOffset - 120 || fileT > w.endOffset + 120) continue
      add(trimStart + fileT, trimStart + fileT + 60)
    }
  }
  return [...out].sort((a, b) => a - b)
}

/** Aggregate every done window into the MinuteSuggestion list (existing type). */
function buildSuggestions(windows: GeminiPrescanWindow[], trimStart: number, trimEnd: number, shortDuration: number): MinuteSuggestion[] {
  const byMinute = new Map<number, MinuteSuggestion>()
  const touch = (minute: number, kind: string, sw: { start: number; end: number }) => {
    let s = byMinute.get(minute)
    if (!s) {
      s = { minute, sceneCount: 0, confidences: [], shortWindows: [] }
      byMinute.set(minute, s)
    }
    s.sceneCount += 1
    s.confidences.push(kind)
    if (!s.shortWindows.some((x) => Math.abs(x.start - sw.start) < 0.01 && Math.abs(x.end - sw.end) < 0.01)) s.shortWindows.push(sw)
  }
  const fullShort = { start: 0, end: shortDuration }
  for (const w of windows) {
    if (w.status !== 'done' || !w.raw) continue
    const parsed = parseMinuteFinderOutput(w.raw, w.startOffset, w.endOffset, WINDOW_TIMESTAMPS_RELATIVE)
    if (parsed.hits.length > 0) {
      for (const h of parsed.hits) {
        const mins = minutesFromWindow({ ...parsed, hits: [h], matchMinutes: [], possibleMinutes: [] }, w, trimStart, trimEnd)
        const sw = h.shortStart !== null && h.shortEnd !== null ? { start: h.shortStart, end: h.shortEnd } : fullShort
        for (const m of mins) touch(m, h.kind, sw)
      }
    } else if (w.minutes && w.minutes.length > 0) {
      for (const m of w.minutes) touch(m, 'possible', fullShort)
    }
  }
  return [...byMinute.values()].sort((a, b) => a.minute - b.minute)
}

/** The chunk scan needs movie chunks — wait for the trim route's background chunking. */
async function waitForChunking(id: string, ctrl: Ctrl): Promise<void> {
  const deadline = Date.now() + CHUNKING_WAIT_MS
  let noted = false
  while (Date.now() < deadline) {
    if (ctrl.stopping) return
    const s = getScan(id)
    if (!s) throw new Error('Scan missing')
    if (s.status === 'error') throw new Error(s.error || 'Chunking failed')
    if (s.chunkCount > 0 && s.status !== 'chunking' && (s.chunkingProgress ?? 100) >= 100) return
    if (!noted) {
      noted = true
      persist(id, ctrl, { progress: `Minutes ready — waiting for movie chunking (${s.chunkingProgress ?? 0}%)...` })
      log(id, 'info', 'Minute list ready — movie chunking abhi chal rahi hai, complete hote hi chunk scan start hoga')
    } else {
      persist(id, ctrl, { progress: `Minutes ready — waiting for movie chunking (${s.chunkingProgress ?? 0}%)...` })
    }
    await sleep(2000)
  }
  throw new Error('Movie chunking complete nahi hui — chunking finish hone par Start dabao (minute ranges already apply ho chuke hain, scan sirf unhi par chalega)')
}
