import 'server-only'

import fs from 'node:fs'
import path from 'node:path'
import { getScan, saveScan, addLog, apiKeyHash, scanMediaDir, getModelUsage, incrementModelUsage } from './store'
import { ensureLocalMedia, localMediaPath } from './media'
import { buildBackupClip, chunkPath, extractClipPrecise } from './ffmpeg'
import { CHUNK_MODEL_POOL } from './models'
import { deleteFileQuiet, getClient, parseGapFinderOutput, runGapFinderChunk, uploadVideo, type GapFinderPartSpec } from './gemini'
import { coverageFromRanges, gapsOf, mergeRanges, shortTotalOf } from './short-coverage'
import { scheduler } from './scheduler'
import type { ChunkMatch, GapBackupCandidate, GapBackupMinute, GapBackupPart, GapBackupRequest, GapBackupState, Scan, ShortRange } from './types'

const BATCH_SIZE = 4
const active = new Map<string, { stopping: boolean }>()

function emptyState(): GapBackupState {
  return { status: 'idle', parts: [], minutes: [], requests: [], candidates: [], addedMatches: [], requestCount: 0, tokenCount: 0 }
}

function persist(scan: Scan, state: GapBackupState) {
  scan.gapBackup = state
  saveScan(scan, { immediate: true })
}

function log(scan: Scan, level: 'info' | 'warn' | 'error' | 'success', msg: string) {
  addLog(scan, level, msg)
  saveScan(scan)
}

function coverageMatches(scan: Scan) {
  // Coverage Review intentionally keeps rejected ranges covered so the same
  // short footage is not searched again by the manual recovery pass.
  return scan.matches || []
}

function uncovered(scan: Scan): ShortRange[] {
  const total = shortTotalOf(scan)
  return gapsOf(mergeRanges(coverageMatches(scan).map((match) => ({ start: match.shortStart, end: match.shortEnd }))), total)
    .filter((gap) => gap.end - gap.start >= 0.15)
}

function buildParts(gaps: ShortRange[]): GapBackupPart[] {
  const parts: GapBackupPart[] = []
  for (const gap of gaps) {
    let cursor = gap.start
    while (cursor < gap.end - 0.001) {
      const minuteIndex = Math.floor(cursor / 60)
      const end = Math.min(gap.end, (minuteIndex + 1) * 60)
      parts.push({
        index: parts.length + 1,
        minuteIndex,
        shortStart: cursor,
        shortEnd: end,
        gapStart: cursor,
        gapEnd: end,
        clipStart: 0,
        clipEnd: 0,
        result: 'pending',
      })
      cursor = end
    }
  }
  return parts
}

function orderedCandidateChunks(scan: Scan, minuteIndex: number): number[] {
  const segment = scan.shortSegments?.find((item) => item.index === minuteIndex)
  const trimStart = scan.movieTrimStart ?? 0
  const maxChunk = Math.max(0, scan.chunkCount - 1)
  const suggested = [...new Set((segment?.movieMinutes || []).map((minute) => Math.floor((minute * 60 - trimStart) / 60)))]
    .filter((index) => index >= 0 && index <= maxChunk)
  const minuteStart = minuteIndex * 60
  const minuteEnd = minuteStart + 60
  const accepted = coverageMatches(scan)
  const before = accepted.filter((match) => match.shortEnd <= minuteStart).sort((a, b) => b.shortEnd - a.shortEnd)[0]
  const after = accepted.filter((match) => match.shortStart >= minuteEnd).sort((a, b) => a.shortStart - b.shortStart)[0]
  const anchors = [before?.chunkIndex, after?.chunkIndex].filter((value): value is number => typeof value === 'number')
  const allowed = [...new Set([...anchors.filter((index) => suggested.includes(index)), ...suggested])]
  return allowed.sort((a, b) => {
    const da = anchors.length ? Math.min(...anchors.map((anchor) => Math.abs(anchor - a))) : suggested.indexOf(a)
    const db = anchors.length ? Math.min(...anchors.map((anchor) => Math.abs(anchor - b))) : suggested.indexOf(b)
    return da - db || suggested.indexOf(a) - suggested.indexOf(b)
  })
}

function scanCoverage(scan: Scan) {
  return coverageFromRanges(coverageMatches(scan).map((match) => ({ start: match.shortStart, end: match.shortEnd })), shortTotalOf(scan))
}

export function gapBackupRunning(id: string) {
  return active.has(id)
}

export function stopGapBackup(id: string) {
  const control = active.get(id)
  if (!control) return false
  control.stopping = true
  return true
}

export function gapBackupPreview(scan: Scan) {
  const saved = scan.gapBackup
  const state = saved && Array.isArray(saved.minutes) && Array.isArray(saved.requests) ? saved : emptyState()
  return { coverage: scanCoverage(scan), gaps: uncovered(scan), state }
}

export function startGapBackup(id: string, apiKeys: string[]) {
  if (active.has(id)) return { ok: false, error: 'Missing-scene finder already running' }
  const scan = getScan(id)
  if (!scan) return { ok: false, error: 'Scan not found' }
  if (scheduler.isRunning(id)) return { ok: false, error: 'Scan is still running — wait for verification to finish' }
  if (!scan.shortDuration || !scan.movieDuration || scan.awaitingTrim) return { ok: false, error: 'Upload both videos and confirm the movie trim first' }
  if (scan.gapBackup?.candidates.some((candidate) => candidate.review === 'pending')) return { ok: false, error: 'Review the pending Gemini candidates before retrying unresolved ranges' }
  if (!apiKeys.length) return { ok: false, error: 'Add a Gemini API key in Settings first' }
  const gaps = uncovered(scan)
  if (!gaps.length) return { ok: false, error: 'No true uncovered ranges remain' }
  const control = { stopping: false }
  active.set(id, control)
  void runGapBackup(scan, apiKeys, gaps, control).finally(() => active.delete(id))
  return { ok: true }
}

function clipSpecs(parts: GapBackupPart[]): GapFinderPartSpec[] {
  return parts.map((part) => ({ id: part.index, shortStart: part.shortStart, shortEnd: part.shortEnd, clipStart: part.clipStart, clipEnd: part.clipEnd }))
}

async function ensureChunk(scan: Scan, movieFile: string, index: number) {
  const chunksDir = path.join(scanMediaDir(scan.id), 'chunks')
  const file = chunkPath(chunksDir, index)
  if (fs.existsSync(file)) return file
  fs.mkdirSync(chunksDir, { recursive: true })
  const start = (scan.movieTrimStart ?? 0) + index * 60
  const end = Math.min(scan.movieTrimEnd ?? scan.movieDuration ?? start + 60, start + 60)
  await extractClipPrecise(movieFile, start, end, file)
  return file
}

async function runGapBackup(scan: Scan, apiKeys: string[], gaps: ShortRange[], control: { stopping: boolean }) {
  const previous = scan.gapBackup
  const parts = buildParts(gaps)
  const minuteIndexes = [...new Set(parts.map((part) => part.minuteIndex))]
  const minutes: GapBackupMinute[] = minuteIndexes.map((index) => ({
    index,
    start: index * 60,
    end: Math.min(scan.shortDuration!, (index + 1) * 60),
    status: 'queued',
    partIds: parts.filter((part) => part.minuteIndex === index).map((part) => part.index),
    candidateChunks: orderedCandidateChunks(scan, index),
    completedChunks: [],
  }))
  const state: GapBackupState = {
    ...emptyState(),
    status: 'cutting',
    progress: 'Missing short ranges ko minute-wise 24 fps clips me prepare kar rahe hain',
    runs: (previous?.runs || 0) + 1,
    parts,
    minutes,
    candidates: (previous?.candidates || []).filter((candidate) => candidate.review === 'accepted' && Boolean(candidate.id)),
    addedMatches: (scan.matches || []).filter((match) => match.origin === 'gap-backup'),
    startedAt: Date.now(),
  }
  persist(scan, state)
  log(scan, 'info', `Manual missing-scene finder started: ${parts.length} unresolved part(s) across ${minutes.length} short minute(s)`)
  const uploadedResources: Array<{ ai: ReturnType<typeof getClient>; name: string }> = []

  try {
    const shortFile = (await ensureLocalMedia(scan.id, 'short')) || localMediaPath(scan.id, 'short')
    const movieFile = (await ensureLocalMedia(scan.id, 'movie')) || localMediaPath(scan.id, 'movie')
    const mediaDir = scanMediaDir(scan.id)

    for (const minute of minutes) {
      if (control.stopping) break
      minute.status = 'preparing'
      minute.startedAt = Date.now()
      state.progress = `Short minute ${minute.index + 1}: 24 fps clip prepare ho raha hai`
      persist(scan, state)
      log(scan, 'info', `Missing-scene minute ${minute.index + 1}: preparing ${minute.partIds.length} gap part(s) at 24 fps`)
      const minuteParts = parts.filter((part) => minute.partIds.includes(part.index))
      const clipFile = path.join(mediaDir, 'gap-backup', `short-minute-${String(minute.index).padStart(3, '0')}.mp4`)
      const built = await buildBackupClip(shortFile, minuteParts.map((part) => ({ start: part.shortStart, end: part.shortEnd })), clipFile)
      minute.clip = { path: clipFile, durationSec: built.durationSec, sizeBytes: built.sizeBytes, fps: 24 }
      minute.preparedAt = Date.now()
      minuteParts.forEach((part, index) => {
        part.clipStart = built.parts[index].clipStart
        part.clipEnd = built.parts[index].clipEnd
      })
      if (!minute.candidateChunks.length) {
        minute.status = 'failed'
        minute.finishedAt = Date.now()
        minute.error = 'Original minute finder ne is short minute ke liye koi movie-minute suggestion nahi diya'
        log(scan, 'warn', `Missing-scene minute ${minute.index + 1}: no minute-finder movie suggestions; skipped`)
      } else {
        log(scan, 'info', `Missing-scene minute ${minute.index + 1}: clip ready (${built.durationSec.toFixed(2)}s); chunk order ${minute.candidateChunks.map((value) => value + 1).join(', ')}`)
      }
      persist(scan, state)
    }

    const lanes = apiKeys.flatMap((key, keyIndex) => CHUNK_MODEL_POOL
      .filter((model) => getModelUsage(model.id, key) < model.rpd)
      .map((model) => ({ key, keyIndex, model, ai: getClient(key), keyId: apiKeyHash(key) })))
    if (!lanes.length) throw new Error('Saari Gemini chunk-model lanes ki daily quota exhausted hai')

    const uploadJobs = new Map<number, Promise<Map<string, { uri: string; name: string }>>>()
    const beginMinuteUpload = (minute: GapBackupMinute, foreground: boolean) => {
      const existing = uploadJobs.get(minute.index)
      if (existing) return existing
      minute.status = 'uploading'
      if (foreground) {
        state.status = 'uploading'
        state.progress = `Short minute ${minute.index + 1} upload ho raha hai`
      }
      persist(scan, state)
      log(scan, 'info', `Missing-scene minute ${minute.index + 1}: uploading prepared clip to ${new Set(lanes.map((lane) => lane.keyId)).size} Gemini key(s)`)
      const job = (async () => {
        const uploads = new Map<string, { uri: string; name: string }>()
        await Promise.all([...new Set(lanes.map((lane) => lane.keyId))].map(async (keyId) => {
          const lane = lanes.find((item) => item.keyId === keyId)!
          const upload = await uploadVideo(lane.ai, minute.clip!.path)
          uploads.set(keyId, upload)
          uploadedResources.push({ ai: lane.ai, name: upload.name })
        }))
        minute.uploadedAt = Date.now()
        persist(scan, state)
        return uploads
      })()
      uploadJobs.set(minute.index, job)
      return job
    }

    for (let minutePosition = 0; minutePosition < minutes.length; minutePosition++) {
      const minute = minutes[minutePosition]
      if (control.stopping) break
      if (minute.status === 'failed' || !minute.clip) continue
      const shortUploads = await beginMinuteUpload(minute, true)
      if (control.stopping) {
        for (const [keyId, upload] of shortUploads) {
          const lane = lanes.find((item) => item.keyId === keyId)
          if (lane) void deleteFileQuiet(lane.ai, upload.name)
        }
        break
      }

      minute.status = 'searching'
      state.status = 'searching'
      const nextMinute = minutes.slice(minutePosition + 1).find((item) => item.status !== 'failed' && item.clip)
      if (nextMinute) void beginMinuteUpload(nextMinute, false)
      log(scan, 'info', `Missing-scene minute ${minute.index + 1}: upload ready; Gemini chunk search started`)
      const unresolved = () => minute.partIds.filter((partId) => !state.candidates.some((candidate) => candidate.part === partId && candidate.review !== 'rejected'))
      const batchSize = Math.min(BATCH_SIZE, lanes.length)
      for (let offset = 0, batchNumber = 1; offset < minute.candidateChunks.length && unresolved().length; offset += batchSize, batchNumber++) {
        if (control.stopping) break
        const batch = minute.candidateChunks.slice(offset, offset + batchSize)
        minute.currentBatch = batch
        state.activeBatch = batch
        state.progress = `Short minute ${minute.index + 1}: batch ${batchNumber}, chunks ${batch.map((value) => value + 1).join(', ')} Gemini par chal rahe hain`
        const batchRequests = batch.map((chunkIndex, slot) => {
          const lane = lanes[(offset + slot) % lanes.length]
          const chunkStart = (scan.movieTrimStart ?? 0) + chunkIndex * 60
          const chunkEnd = Math.min(scan.movieTrimEnd ?? scan.movieDuration!, chunkStart + 60)
          const request: GapBackupRequest = {
            id: `${minute.index}-${chunkIndex}-${Date.now()}-${slot}`,
            minuteIndex: minute.index,
            batch: batchNumber,
            chunkIndex,
            chunkStart,
            chunkEnd,
            lane: `key ${lane.keyIndex + 1} · ${lane.model.id}`,
            model: lane.model.id,
            status: 'queued',
            queuedAt: Date.now(),
          }
          state.requests.push(request)
          return { chunkIndex, lane, request }
        })
        persist(scan, state)
        log(scan, 'info', `Missing-scene minute ${minute.index + 1}: batch ${batchNumber} dispatched (${batch.length}/4 requests; chunks ${batch.map((value) => value + 1).join(', ')})`)

        await Promise.all(batchRequests.map(async ({ chunkIndex, lane, request }) => {
          request.status = 'uploading'
          request.startedAt = Date.now()
          persist(scan, state)
          let uploadedName: string | null = null
          try {
            const chunkFile = await ensureChunk(scan, movieFile, chunkIndex)
            const uploaded = await uploadVideo(lane.ai, chunkFile)
            uploadedName = uploaded.name
            uploadedResources.push({ ai: lane.ai, name: uploaded.name })
            request.uploadedAt = Date.now()
            if (control.stopping) {
              request.status = 'cancelled'
              return
            }
            request.status = 'running'
            state.requestCount = (state.requestCount || 0) + 1
            persist(scan, state)
            incrementModelUsage(lane.model.id, lane.key)
            const partList = parts.filter((part) => unresolved().includes(part.index))
            const response = await runGapFinderChunk(lane.ai, lane.model.id, shortUploads.get(lane.keyId)!.uri, uploaded.uri, clipSpecs(partList), request.chunkStart, request.chunkEnd)
            const hits = parseGapFinderOutput(response.text, new Set(partList.map((part) => part.index)), request.chunkStart, request.chunkEnd)
            request.raw = response.text
            request.tokens = response.tokens ?? undefined
            request.matches = hits.length
            request.status = 'done'
            state.tokenCount = (state.tokenCount || 0) + (response.tokens || 0)
            for (const hit of hits) {
              if (state.candidates.some((candidate) => candidate.part === hit.part && Math.abs(candidate.movieStart - hit.movieStart) < 0.5 && candidate.review !== 'rejected')) continue
              const targetPart = parts.find((part) => part.index === hit.part)
              if (!targetPart) continue
              const candidate: GapBackupCandidate = {
                id: `${hit.part}-${chunkIndex}-${Math.round(hit.movieStart * 1000)}`,
                part: hit.part,
                shortStart: targetPart.gapStart,
                shortEnd: targetPart.gapEnd,
                movieStart: hit.movieStart,
                movieEnd: hit.movieEnd,
                source: 'gap-backup',
                chunkIndex,
                model: lane.model.id,
                confidence: 1,
                reason: hit.evidence,
                review: 'pending',
                createdAt: Date.now(),
              }
              state.candidates.push(candidate)
              const part = parts.find((item) => item.index === hit.part)
              if (part) part.result = 'found'
            }
          } catch (error) {
            request.status = 'failed'
            request.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
          } finally {
            request.finishedAt = Date.now()
            minute.completedChunks.push(chunkIndex)
            if (uploadedName) void deleteFileQuiet(lane.ai, uploadedName)
            persist(scan, state)
            const outcome = request.status === 'done'
              ? `${request.matches || 0} strict match(es), ${(request.tokens || 0).toLocaleString()} tokens`
              : request.error || request.status
            log(scan, request.status === 'failed' ? 'error' : 'info', `Missing-scene minute ${minute.index + 1}, batch ${batchNumber}, chunk ${chunkIndex + 1}: ${outcome}`)
          }
        }))
        const remaining = unresolved().length
        log(scan, 'info', `Missing-scene minute ${minute.index + 1}: batch ${batchNumber} complete; ${remaining} part(s) still unresolved`)
      }
      for (const [keyId, upload] of shortUploads) {
        const lane = lanes.find((item) => item.keyId === keyId)
        if (lane) void deleteFileQuiet(lane.ai, upload.name)
      }
      minute.currentBatch = undefined
      for (const partId of unresolved()) {
        const part = parts.find((item) => item.index === partId)
        if (part?.result === 'pending') part.result = 'unresolved'
      }
      minute.status = state.candidates.some((candidate) => minute.partIds.includes(candidate.part) && candidate.review === 'pending') ? 'awaiting_review' : 'done'
      minute.finishedAt = Date.now()
      persist(scan, state)
    }

    await Promise.allSettled(uploadJobs.values())
    await Promise.allSettled(uploadedResources.map(({ ai, name }) => deleteFileQuiet(ai, name)))
    state.activeBatch = undefined
    if (control.stopping) {
      state.status = 'stopped'
      state.progress = 'User ne finder stop kiya; completed replies save hain aur Retry se unresolved work continue hoga'
    } else if (state.candidates.some((candidate) => candidate.review === 'pending')) {
      state.status = 'awaiting_review'
      state.progress = 'Gemini search complete — candidates ko side-by-side review karke Accept ya Reject karein'
    } else {
      state.status = 'done'
      state.progress = 'Search complete — koi strict pending candidate nahi mila'
    }
    state.finishedAt = Date.now()
    persist(scan, state)
    log(scan, 'success', `Missing-scene finder finished: ${state.candidates.filter((candidate) => candidate.review === 'pending').length} candidate(s) awaiting review`)
  } catch (error) {
    await Promise.allSettled(uploadedResources.map(({ ai, name }) => deleteFileQuiet(ai, name)))
    state.status = 'error'
    state.error = error instanceof Error ? error.message : String(error)
    state.progress = 'Finder error par ruk gaya; details niche request logs me hain'
    state.finishedAt = Date.now()
    persist(scan, state)
    log(scan, 'error', `Missing-scene finder failed: ${state.error}`)
  }
}

export function reviewGapCandidate(scan: Scan, candidateId: string, decision: 'accept' | 'reject') {
  const state = scan.gapBackup
  const candidate = state?.candidates.find((item) => item.id === candidateId)
  if (!state || !candidate) return { ok: false, error: 'Candidate not found' }
  if (decision === 'accept') {
    for (const item of state.candidates) if (item.part === candidate.part && item.id !== candidate.id && item.review === 'pending') item.review = 'rejected'
    candidate.review = 'accepted'
    const match: ChunkMatch = {
      shortStart: candidate.shortStart,
      shortEnd: candidate.shortEnd,
      movieStart: candidate.movieStart,
      movieEnd: candidate.movieEnd,
      chunkIndex: candidate.chunkIndex,
      model: candidate.model,
      verified: true,
      userPick: true,
      origin: 'gap-backup',
    }
    scan.matches = scan.matches.filter((item) => !(item.origin === 'gap-backup' && Math.abs(item.shortStart - candidate.shortStart) < 0.1))
    scan.matches.push(match)
    scan.matches.sort((a, b) => a.shortStart - b.shortStart)
    state.addedMatches = scan.matches.filter((item) => item.origin === 'gap-backup')
    const part = state.parts.find((item) => item.index === candidate.part)
    if (part) part.result = 'accepted'
  } else {
    candidate.review = 'rejected'
    const part = state.parts.find((item) => item.index === candidate.part)
    if (part && !state.candidates.some((item) => item.part === candidate.part && item.review === 'pending')) part.result = 'rejected'
  }
  if (!state.candidates.some((item) => item.review === 'pending')) {
    state.status = 'done'
    state.progress = 'Sab Gemini candidates review ho gaye'
  }
  persist(scan, state)
  return { ok: true }
}
