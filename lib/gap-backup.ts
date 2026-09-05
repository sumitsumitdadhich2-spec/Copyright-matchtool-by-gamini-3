import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import type { GoogleGenAI } from '@google/genai'
import { getScan, saveScan, addLog, apiKeyHash, scanMediaDir } from './store'
import { ensureLocalMedia, localMediaPath } from './media'
import { buildBackupClip, preparePrescanMovieCopy } from './ffmpeg'
import { CHUNK_MODEL_POOL } from './models'
import { getClient, uploadVideo, runBackupMinuteFinderWindow, parseBackupMinuteFinderOutput, backupClipFps, type BackupPartSpec } from './gemini'
import { computeShortCoverage, missingRanges } from './short-coverage'
import { scheduler } from './scheduler'
import type { GapBackupCandidate, GapBackupPart, GapBackupState, GeminiPrescanWindow, Scan } from './types'

const WINDOW_SEC = 1200
const PAD_SEC = 2
const MIN_GAP_SEC = 4
const TTL_MS = 47 * 60 * 60 * 1000
const active = new Set<string>()

function emptyState(): GapBackupState {
  return { status: 'idle', parts: [], uploads: {}, movieUploads: {}, windows: [], candidates: [], addedMatches: [] }
}

function persist(scan: Scan, state: GapBackupState) {
  scan.gapBackup = state
  saveScan(scan, { immediate: true })
}

function log(scan: Scan, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  addLog(scan, level, msg)
  saveScan(scan)
}

function activeFile(ai: GoogleGenAI, name?: string) {
  return name ? ai.files.get({ name }).then((f) => f.state === 'ACTIVE').catch(() => false) : Promise.resolve(false)
}

async function uploadCached(ai: GoogleGenAI, file: string, cached?: { uri: string; name: string; uploadedAt: number }) {
  if (cached && Date.now() - cached.uploadedAt < TTL_MS && await activeFile(ai, cached.name)) return cached
  const uploaded = await uploadVideo(ai, file)
  return { uri: uploaded.uri, name: uploaded.name, uploadedAt: Date.now() }
}

function windowList(duration: number): GeminiPrescanWindow[] {
  const out: GeminiPrescanWindow[] = []
  for (let start = 0, index = 0; start < duration - 0.5; start += WINDOW_SEC, index++) {
    out.push({ index, startOffset: start, endOffset: Math.min(duration, start + WINDOW_SEC), status: 'pending' })
  }
  return out
}

function addCandidate(scan: Scan, candidate: GapBackupCandidate) {
  const exists = scan.matches.some((m) => Math.abs(m.shortStart - candidate.shortStart) < 0.5 && Math.abs(m.movieStart - candidate.movieStart) < 0.5)
  if (exists) return
  const trimStart = scan.movieTrimStart ?? 0
  const chunkIndex = Math.max(0, Math.floor((candidate.movieStart - trimStart) / 60))
  scan.matches.push({ shortStart: candidate.shortStart, shortEnd: candidate.shortEnd, movieStart: candidate.movieStart, movieEnd: candidate.movieEnd, chunkIndex, model: 'gap-backup', origin: 'gap-backup', originWindow: candidate.windowIndex })
}

export function gapBackupRunning(id: string) { return active.has(id) }

export function gapBackupPreview(scan: Scan) {
  const coverage = computeShortCoverage(scan)
  return { coverage, gaps: missingRanges((scan.matches || []).map((m) => ({ start: m.shortStart, end: m.shortEnd })), coverage.totalSec, { padSec: PAD_SEC, minGapSec: MIN_GAP_SEC }), state: scan.gapBackup ?? emptyState() }
}

export function startGapBackup(id: string, apiKeys: string[]) {
  if (active.has(id)) return { ok: false, error: 'Gap backup already running' }
  const scan = getScan(id)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (scheduler.isRunning(id)) return { ok: false, error: 'Scan is still running — wait for verification to finish' }
  if (!scan.shortDuration || !scan.movieDuration || scan.awaitingTrim) return { ok: false, error: 'Upload both videos and confirm the movie trim first' }
  if (!apiKeys.length) return { ok: false, error: 'Add a Gemini API key in Settings first' }
  const preview = gapBackupPreview(scan)
  if (!preview.gaps.length) return { ok: false, error: 'No true uncovered gaps remain' }
  active.add(id)
  void runGapBackup(scan, apiKeys, preview.gaps).finally(() => active.delete(id))
  return { ok: true }
}

async function runGapBackup(scan: Scan, apiKeys: string[], gaps: Array<{ start: number; end: number }>) {
  const mediaDir = scanMediaDir(scan.id)
  const state: GapBackupState = { ...emptyState(), ...(scan.gapBackup || {}), status: 'cutting', runs: (scan.gapBackup?.runs || 0) + 1, error: null, startedAt: Date.now(), finishedAt: null }
  persist(scan, state)
  log(scan, 'info', `Gap backup started manually: ${gaps.length} true uncovered gap(s)`)
  try {
    const shortFile = (await ensureLocalMedia(scan.id, 'short')) || localMediaPath(scan.id, 'short')
    const movieFile = (await ensureLocalMedia(scan.id, 'movie')) || localMediaPath(scan.id, 'movie')
    const clipPath = path.join(mediaDir, 'gap-backup-clip.mp4')
    const built = await buildBackupClip(shortFile, gaps, clipPath)
    const signature = JSON.stringify(gaps.map((g) => [Math.round(g.start * 10) / 10, Math.round(g.end * 10) / 10]))
    state.clip = { path: clipPath, durationSec: built.durationSec, sizeBytes: built.sizeBytes, fps: backupClipFps(built.durationSec), signature }
    state.parts = gaps.map((g, i): GapBackupPart => ({ index: i + 1, shortStart: g.start + PAD_SEC > scan.shortDuration! ? g.start : g.start, shortEnd: g.end, gapStart: g.start, gapEnd: g.end, clipStart: built.parts[i].clipStart, clipEnd: built.parts[i].clipEnd, result: 'pending' }))
    persist(scan, state)

    state.status = 'uploading'
    const trimStart = scan.movieTrimStart ?? 0
    const trimEnd = scan.movieTrimEnd ?? scan.movieDuration!
    const movieCopyPath = path.join(mediaDir, 'gap-backup-movie.mp4')
    if (!fs.existsSync(movieCopyPath)) await preparePrescanMovieCopy(movieFile, movieCopyPath, scan.movieDuration!, trimStart, trimEnd, () => {}, { scanId: scan.id })
    state.status = 'searching'
    state.windows = windowList(trimEnd - trimStart).map((w) => ({ ...w, startOffset: w.startOffset + trimStart, endOffset: w.endOffset + trimStart }))
    state.context = 'Search every ordered 20-minute movie window. Unresolved parts must remain unresolved.'
    const parts: BackupPartSpec[] = state.parts.map((p) => ({ index: p.index, clipStart: p.clipStart, clipEnd: p.clipEnd, shortStart: p.shortStart, shortEnd: p.shortEnd }))
    const lanes = apiKeys.flatMap((key, keyIndex) => CHUNK_MODEL_POOL.map((model) => ({ key, keyIndex, model, ai: getClient(key) })))
    const uploaded = new Map<string, { uri: string; name: string; uploadedAt: number }>()
    for (const lane of lanes) {
      const keyId = apiKeyHash(lane.key)
      if (!uploaded.has(keyId)) uploaded.set(keyId, await uploadCached(lane.ai, clipPath, state.uploads[keyId]))
      const movieUpload = await uploadCached(lane.ai, movieCopyPath, state.movieUploads[keyId])
      state.uploads[keyId] = uploaded.get(keyId)!
      state.movieUploads[keyId] = movieUpload
      persist(scan, state)
    }
    for (const w of state.windows) {
      if (w.status === 'done') continue
      let completed = false
      for (const lane of lanes) {
        const keyId = apiKeyHash(lane.key)
        try {
          const response = await runBackupMinuteFinderWindow(lane.ai, lane.model.id, state.uploads[keyId].uri, state.movieUploads[keyId].uri, w.startOffset, w.endOffset, state.clip.fps, parts, state.context)
          const parsed = parseBackupMinuteFinderOutput(response.text, w.startOffset, w.endOffset, true, parts)
          w.raw = response.text; w.tokens = response.tokens ?? undefined; w.matches = parsed.hits.length; w.status = 'done'; w.lane = `key ${lane.keyIndex + 1} · ${lane.model.id}`
          for (const hit of parsed.hits) {
            const candidate: GapBackupCandidate = { part: hit.part || 0, shortStart: hit.shortStart ?? 0, shortEnd: hit.shortEnd ?? 0, movieStart: hit.fileStart, movieEnd: hit.fileEnd, source: 'gap-backup', windowIndex: w.index, confidence: hit.kind === 'match' ? 1 : 0.5, reason: hit.evidence }
            if (candidate.part > 0 && candidate.shortEnd > candidate.shortStart) {
              state.candidates.push(candidate)
              const p = state.parts[candidate.part - 1]
              if (p && (!p.found || candidate.confidence > p.found.confidence)) p.found = { movieStart: candidate.movieStart, movieEnd: candidate.movieEnd, windowIndex: candidate.windowIndex, confidence: candidate.confidence, reason: candidate.reason }
              addCandidate(scan, candidate)
            }
          }
          completed = true; persist(scan, state); break
        } catch (err) { w.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }
      }
      if (!completed) { w.status = 'failed'; persist(scan, state) }
    }
    state.status = state.candidates.length ? 'verifying' : 'done'
    state.addedMatches = scan.matches.filter((m) => m.origin === 'gap-backup')
    state.recoveredSec = computeShortCoverage(scan).coveredSec
    persist(scan, state)
    if (state.candidates.length) {
      scan.status = 'stopped'
      const result = await scheduler.start(scan.id, false, apiKeys, null)
      if (!result.ok) log(scan, 'warn', `Gap candidates saved but verifier could not start: ${result.error}`)
      else log(scan, 'info', 'Gap-backup candidates added to the normal 24fps verifier')
    }
    state.status = 'done'; state.finishedAt = Date.now(); persist(scan, state)
    log(scan, 'success', `Gap backup finished: ${state.candidates.length} candidate(s) found`)
  } catch (err) {
    state.status = 'error'; state.error = err instanceof Error ? err.message : String(err); state.finishedAt = Date.now(); persist(scan, state); log(scan, 'error', `Gap backup failed: ${state.error}`)
  }
}
