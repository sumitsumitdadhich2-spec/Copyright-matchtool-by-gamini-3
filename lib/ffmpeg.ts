import fs from 'node:fs'
import path from 'node:path'
import { CHUNK_SECONDS } from './models'
import { getFfmpegPath } from './ffmpeg-bin'
import {
  CancelToken,
  engineCount,
  parallelMap,
  parseProgressLine,
  planSlices,
  runFfmpeg,
  runFfprobe,
  sliceProgress,
  type TimeSlice,
} from './ffmpeg-pool'
import { placeWork, removeStageWork } from './work-dir'

// ---------------------------------------------------------------------------
// PRECISE ENCODING — no stream copy anywhere.
//
//   * every cut: `-ss <abs>` BEFORE `-i` (accurate seek: decode from the
//     previous keyframe, drop until the exact timestamp) + exact `-t`
//   * `-fflags +genpts` on input, `-avoid_negative_ts make_zero`,
//     `-fps_mode cfr`, `-pix_fmt yuv420p`, 48 kHz audio on output
//   * long tasks are split into ENGINES time slices on the 60 s chunk grid
//     (lib/ffmpeg-pool.ts) and run concurrently, one single-threaded ffmpeg
//     per core; slices use IDENTICAL params so a join is seamless
//   * joins are re-encodes too (concat demuxer → libx264/aac); intermediates
//     at CRF 18 (near-lossless), the final join at the target quality
//   * every output is verified with ffprobe: duration ≈ expected (±1 frame)
// ---------------------------------------------------------------------------

/** Every file sent to Gemini is hard-encoded at 24 fps (Gemini's default video rate). */
const SCAN_FPS = 24
const SCAN_FPS_STR = String(SCAN_FPS)

/** Input-side flags for precise cutting. Placed before `-i`. */
const IN_FLAGS = ['-fflags', '+genpts']
/** Output-side flags shared by every encode. */
const OUT_FLAGS = ['-avoid_negative_ts', 'make_zero', '-fps_mode', 'cfr', '-pix_fmt', 'yuv420p', '-threads', '1']

/** Scan-copy video params (640px / 24 fps / CRF 28 / veryfast) — Gemini uploads. */
const SCAN_VIDEO = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28']
const SCAN_AUDIO = ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '48000']
const SCAN_VF = `scale=640:-2,fps=${SCAN_FPS_STR}`

export interface FfmpegLog {
  (msg: string): void
}

// ---------- Probing ----------

export async function probeDuration(file: string): Promise<number> {
  try {
    const out = await runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    const dur = Number.parseFloat(out.trim())
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('Could not determine video duration')
    return dur
  } catch (probeErr) {
    const dur = await probeDurationViaFfmpeg(file)
    if (dur !== null) return dur
    throw probeErr
  }
}

/** Fallback: read duration from `ffmpeg -i` stderr. */
async function probeDurationViaFfmpeg(file: string): Promise<number | null> {
  let stderr = ''
  try {
    await runFfmpeg(['-i', file], { label: 'probe', onStderr: (l) => (stderr += l) })
  } catch (err) {
    stderr += err instanceof Error ? err.message : String(err)
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  const dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(dur) && dur > 0 ? dur : null
}

/** True when the file has at least one audio stream. */
export async function probeHasAudio(file: string): Promise<boolean> {
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file])
    return out.trim().length > 0
  } catch {
    return false
  }
}

/** Probe video width/height (first video stream). */
export async function probeResolution(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    const [w, h] = out.trim().split(/[,\s]+/).map((v) => Number.parseInt(v, 10))
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h }
    return null
  } catch {
    return null
  }
}

/** Probe the average frame rate of the first video stream (null when unknown). */
export async function probeFps(file: string): Promise<number | null> {
  try {
    const out = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate', '-of', 'csv=p=0', file])
    for (const tok of out.trim().split(/[,\s]+/)) {
      const [n, d] = tok.split('/').map(Number)
      const fps = d ? n / d : n
      if (Number.isFinite(fps) && fps > 0 && fps <= 240) return fps
    }
    return null
  } catch {
    return null
  }
}

export interface DurationCheck {
  ok: boolean
  actual: number
  expected: number
  diff: number
  tolerance: number
}

/**
 * Verify an encode landed on the expected duration (±1 frame at `fps`, with a
 * small floor for container rounding). Logs the result; never throws.
 */
export async function verifyDuration(file: string, expected: number, fps: number, log?: FfmpegLog, label = path.basename(file)): Promise<DurationCheck> {
  const tolerance = Math.max(1 / Math.max(1, fps), 0.05) + 0.02
  let actual = 0
  try {
    actual = await probeDuration(file)
  } catch {
    // leave 0 → not ok
  }
  const diff = actual - expected
  const ok = Math.abs(diff) <= tolerance
  const msg = `[verify] ${label}: ${actual.toFixed(3)}s vs expected ${expected.toFixed(3)}s (${diff >= 0 ? '+' : ''}${(diff * 1000).toFixed(0)} ms, tol ±${(tolerance * 1000).toFixed(0)} ms) ${ok ? 'OK' : 'MISMATCH'}`
  if (ok) console.log(msg)
  else console.warn(msg)
  log?.(msg.replace('[verify] ', 'Verify: '))
  return { ok, actual, expected, diff, tolerance }
}

// ---------- Movie chunking (chunk-XXXX.mp4) ----------

export interface ChunkOptions {
  onLog?: FfmpegLog
  token?: CancelToken
}

/**
 * Cut the movie into exact sequential 1-minute chunks, re-encoded at 24 fps /
 * 640px / CRF 28 with keyframes forced on the 60 s grid.
 *
 * PARALLEL: the [trimStart, trimEnd) range is split into ENGINES slices whose
 * edges are chunk edges; each slice runs its own ffmpeg with the segment muxer
 * and `-segment_start_number` so the global numbering is identical to a single
 * sequential run (chunkAbsWindow in lib/scheduler.ts stays correct).
 */
export async function chunkMovie(
  movieFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
  trimStart = 0,
  trimEnd?: number,
  opts: ChunkOptions = {},
): Promise<number> {
  const rangeEnd = trimEnd !== undefined && trimEnd > trimStart ? Math.min(trimEnd, duration) : duration
  return chunkRange(movieFile, outDir, 'chunk', trimStart, rangeEnd, onProgress, opts)
}

export function chunkPath(outDir: string, index: number): string {
  return path.join(outDir, `chunk-${String(index).padStart(4, '0')}.mp4`)
}

/**
 * Cut the SHORT video into exact sequential 1-minute scan segments
 * (seg-0000.mp4, ...) with the same params as movie chunks. Original untouched.
 */
export async function chunkShort(
  shortFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
  opts: ChunkOptions = {},
): Promise<number> {
  return chunkRange(shortFile, outDir, 'seg', 0, duration, onProgress, opts)
}

export function segmentPath(outDir: string, index: number): string {
  return path.join(outDir, `seg-${String(index).padStart(4, '0')}.mp4`)
}

/** Shared implementation for chunkMovie / chunkShort. */
async function chunkRange(
  source: string,
  outDir: string,
  prefix: 'chunk' | 'seg',
  rangeStart: number,
  rangeEnd: number,
  onProgress: (pct: number) => void,
  opts: ChunkOptions,
): Promise<number> {
  fs.mkdirSync(outDir, { recursive: true })
  const rangeDur = Math.max(1, rangeEnd - rangeStart)
  const slices = planSlices(rangeStart, rangeEnd)
  const engines = engineCount()
  opts.onLog?.(`ffmpeg: ${prefix === 'chunk' ? 'movie chunking' : 'short segmenting'} ${rangeDur.toFixed(0)}s → ${slices.length} slice(s) on ${engines} engines (1 process/core)`)
  const startedAt = Date.now()
  // Holder object (not a bare `let`) so TS keeps the union type across the closure.
  const peak: { speed: number | null } = { speed: null }

  const progress = sliceProgress((doneSec, speed) => {
    onProgress(Math.min(99, Math.round((doneSec / rangeDur) * 100)))
    if (speed !== null) peak.speed = Math.max(peak.speed ?? 0, speed)
  })

  // Each slice writes into its own staging dir so a rounding-tail file at a
  // slice end can never overwrite the next slice's first chunk.
  const stagingFor = (s: TimeSlice) => path.join(outDir, `.slice-${String(s.index).padStart(2, '0')}`)
  for (const s of slices) {
    fs.rmSync(stagingFor(s), { recursive: true, force: true })
    fs.mkdirSync(stagingFor(s), { recursive: true })
  }

  await parallelMap(slices, async (s) => {
    const sliceDur = s.end - s.start
    const args: string[] = ['-y', ...IN_FLAGS]
    if (s.start > 0.0005) args.push('-ss', s.start.toFixed(3))
    args.push('-i', source, '-t', sliceDur.toFixed(3))
    args.push(
      '-vf', SCAN_VF,
      ...SCAN_VIDEO,
      '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
      ...SCAN_AUDIO,
      ...OUT_FLAGS,
      '-f', 'segment',
      '-segment_time', String(CHUNK_SECONDS),
      '-segment_start_number', String(s.firstChunk),
      '-reset_timestamps', '1',
      path.join(stagingFor(s), `${prefix}-%04d.mp4`),
    )
    const t0 = Date.now()
    await runFfmpeg(args, { label: `${prefix}-slice-${s.index}`, token: opts.token, onStderr: progress.forSlice(s.index, sliceDur) })
    progress.complete(s.index, sliceDur)
    const secs = (Date.now() - t0) / 1000
    opts.onLog?.(`ffmpeg: slice ${s.index + 1}/${slices.length} done (${sliceDur.toFixed(0)}s of video in ${secs.toFixed(1)}s, ${(sliceDur / Math.max(0.1, secs)).toFixed(1)}x)`)
  })

  // Assemble: move each slice's files into outDir; drop rounding tails.
  let produced = 0
  for (const s of slices) {
    const dir = stagingFor(s)
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.mp4')).sort()
    const isLast = s.index === slices.length - 1
    const maxIndex = s.firstChunk + s.chunkCount - 1
    for (const f of files) {
      const idx = Number.parseInt(f.slice(prefix.length + 1, prefix.length + 5), 10)
      const src = path.join(dir, f)
      if (!isLast && idx > maxIndex) {
        // Sub-frame rounding tail past the slice's last chunk — never real content.
        const size = fs.statSync(src).size
        opts.onLog?.(`ffmpeg: dropped rounding tail ${f} from slice ${s.index} (${size} bytes)`)
        fs.rmSync(src, { force: true })
        continue
      }
      fs.renameSync(src, path.join(outDir, f))
      produced++
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }

  onProgress(100)
  const total = fs.readdirSync(outDir).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.mp4')).length
  const wall = (Date.now() - startedAt) / 1000
  opts.onLog?.(`ffmpeg: ${total} ${prefix} file(s) in ${wall.toFixed(1)}s (${(rangeDur / Math.max(0.1, wall)).toFixed(1)}x realtime across ${slices.length} engines${peak.speed ? `, peak ${peak.speed.toFixed(1)}x` : ''})`)

  // Verify: first + last chunk land on the grid.
  const first = path.join(outDir, `${prefix}-0000.mp4`)
  if (fs.existsSync(first)) await verifyDuration(first, Math.min(CHUNK_SECONDS, rangeDur), SCAN_FPS, opts.onLog)
  if (total > 1) {
    const lastFile = path.join(outDir, `${prefix}-${String(total - 1).padStart(4, '0')}.mp4`)
    const lastExpected = rangeDur - (total - 1) * CHUNK_SECONDS
    if (fs.existsSync(lastFile) && lastExpected > 0) await verifyDuration(lastFile, lastExpected, SCAN_FPS, opts.onLog)
  }
  if (produced !== total) opts.onLog?.(`ffmpeg: note — ${produced} file(s) moved this run, ${total} present in ${path.basename(outDir)}`)
  return total
}

/** Remove all short-segment scan files. */
export function cleanupSegments(outDir: string) {
  removeMatching(outDir, (f) => f.startsWith('seg-'))
}

export function cleanupChunks(outDir: string) {
  removeMatching(outDir, (f) => f.startsWith('chunk-'))
}

/** Remove all temporary verifier/rescan clip files. */
export function cleanupClips(clipsDir: string) {
  removeMatching(clipsDir, (f) => f.endsWith('.mp4'))
}

function removeMatching(dir: string, pred: (f: string) => boolean) {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!pred(f)) continue
    try {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

// ---------- Short clips (verifier / rescan) — pooled precise cuts ----------

/** Extract a sub-clip (24 fps scan copy). Runs through the engine pool. */
export async function extractSegment(sourceFile: string, start: number, end: number, outFile: string, token?: CancelToken): Promise<void> {
  return extractClipPrecise(sourceFile, start, end, outFile, token)
}

/**
 * Millisecond-precise clip cut for the verifier/rescan pipeline (24 fps /
 * 640px / CRF 28 / mono AAC). Very short windows are padded to 1 s so Gemini
 * gets enough frames. Pooled — the scheduler's clips are cut concurrently.
 */
export async function extractClipPrecise(sourceFile: string, start: number, end: number, outFile: string, token?: CancelToken): Promise<void> {
  const s = Math.max(0, start)
  const dur = Math.max(1, end - start)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  await runFfmpeg(
    ['-y', ...IN_FLAGS, '-ss', s.toFixed(3), '-i', sourceFile, '-t', dur.toFixed(3), '-vf', SCAN_VF, ...SCAN_VIDEO, ...SCAN_AUDIO, ...OUT_FLAGS, '-movflags', '+faststart', outFile],
    { label: `clip ${s.toFixed(1)}s+${dur.toFixed(1)}s`, token },
  )
  await verifyDuration(outFile, dur, SCAN_FPS)
}

// ---------- Generic slice → encode → join pipeline ----------

export interface SliceEncodeSpec {
  /** Source video (absolute path). */
  source: string
  /** Absolute range in the source. */
  rangeStart: number
  rangeEnd: number
  /** Work dir owner (scan id) + stage name for RAM placement / cleanup. */
  scanId: string
  stage: string
  /** Final output path. */
  outFile: string
  /** Target geometry / rate every part AND the join must share. */
  width: number
  height: number
  fps: number
  /** Audio channels for every part (1 or 2). Silence is synthesized when the source has none. */
  channels: 1 | 2
  /** Encode preset for parts + join. */
  preset: 'veryfast' | 'medium'
  /** Final join quality: CRF or bitrate. */
  final: { crf: number; audioKbps: number } | { videoKbps: number; audioKbps: number }
  /** Estimated bytes the parts will occupy (for RAM/disk placement). */
  estimatedBytes: number
  onProgress?: (pct: number, note: string) => void
  onLog?: FfmpegLog
  token?: CancelToken
  label?: string
}

function scalePadFilter(w: number, h: number, fps: number): string {
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1`
}

/** Part encode: near-lossless CRF 18 intermediate at the shared geometry. */
function partArgs(
  spec: Pick<SliceEncodeSpec, 'source' | 'width' | 'height' | 'fps' | 'channels' | 'preset'>,
  hasAudio: boolean,
  s: TimeSlice,
  partFile: string,
): string[] {
  const dur = s.end - s.start
  const args: string[] = ['-y', ...IN_FLAGS]
  if (s.start > 0.0005) args.push('-ss', s.start.toFixed(3))
  args.push('-t', dur.toFixed(3), '-i', spec.source)
  if (!hasAudio) args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', `anullsrc=channel_layout=${spec.channels === 1 ? 'mono' : 'stereo'}:sample_rate=48000`)
  args.push(
    '-filter_complex',
    `[0:v]${scalePadFilter(spec.width, spec.height, spec.fps)}[v];${hasAudio ? '[0:a]' : '[1:a]'}aresample=48000:async=1,aformat=channel_layouts=${spec.channels === 1 ? 'mono' : 'stereo'}[a]`,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', spec.preset, '-crf', '18',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', String(spec.channels),
    ...OUT_FLAGS,
    partFile,
  )
  return args
}

/** Final join: concat demuxer → full re-encode at the target quality. */
export function joinArgs(listFile: string, spec: Pick<SliceEncodeSpec, 'width' | 'height' | 'fps' | 'channels' | 'preset' | 'final'>, outFile: string, extraVf?: string): string[] {
  const vcodec =
    'crf' in spec.final
      ? ['-c:v', 'libx264', '-preset', spec.preset, '-crf', String(spec.final.crf)]
      : [
          '-c:v', 'libx264', '-preset', spec.preset,
          '-b:v', `${spec.final.videoKbps}k`,
          '-maxrate', `${Math.round(spec.final.videoKbps * 1.5)}k`,
          '-bufsize', `${spec.final.videoKbps * 2}k`,
        ]
  return [
    '-y', ...IN_FLAGS, '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', extraVf ? `${extraVf},fps=${spec.fps},setsar=1` : `fps=${spec.fps},setsar=1`,
    ...vcodec,
    '-c:a', 'aac', '-b:a', `${spec.final.audioKbps}k`, '-ar', '48000', '-ac', String(spec.channels),
    ...OUT_FLAGS,
    '-movflags', '+faststart',
    outFile,
  ]
}

export function writeConcatList(listFile: string, files: string[]) {
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n')
}

/**
 * Encode [rangeStart, rangeEnd) of `source` into `outFile` using every engine:
 * parts in parallel (CRF 18) → concat → final re-encode. Returns the part
 * files too (callers may re-join at a different quality without re-cutting).
 */
export async function sliceEncode(spec: SliceEncodeSpec): Promise<{ parts: string[]; workDir: string; durationSec: number }> {
  const rangeDur = Math.max(0.1, spec.rangeEnd - spec.rangeStart)
  const { parts, workDir } = await encodeParts(spec)
  spec.onLog?.(`ffmpeg: ${spec.label || spec.stage} — joining with re-encode...`)
  await joinParts(parts, spec, spec.outFile, rangeDur)
  const durationSec = await probeDuration(spec.outFile)
  return { parts, workDir, durationSec }
}

/**
 * Parts-only half of sliceEncode: cut + encode [rangeStart, rangeEnd) into
 * numbered CRF 18 part files (all engines busy) WITHOUT joining them. Callers
 * that combine several sources (merge: short + movie) build their own list
 * and call joinParts once. Progress spans `progressRange` (default 0..70 %).
 */
export async function encodeParts(
  spec: Omit<SliceEncodeSpec, 'outFile' | 'final'> & { partPrefix?: string; progressRange?: [number, number] },
): Promise<{ parts: string[]; workDir: string }> {
  const rangeDur = Math.max(0.1, spec.rangeEnd - spec.rangeStart)
  const hasAudio = await probeHasAudio(spec.source)
  const slices = planSlices(spec.rangeStart, spec.rangeEnd)
  const placement = placeWork(spec.scanId, spec.stage, spec.estimatedBytes)
  const label = spec.label || spec.stage
  const prefix = spec.partPrefix || 'part'
  const [p0, p1] = spec.progressRange ?? [0, 70]
  spec.onLog?.(`ffmpeg: ${label} — ${slices.length} slice(s) on ${engineCount()} engines, parts in ${placement.inRam ? 'RAM' : 'disk'} (${placement.dir})`)

  const parts = slices.map((s) => path.join(placement.dir, `${prefix}-${String(s.index).padStart(4, '0')}.mp4`))
  const progress = sliceProgress((doneSec, speed) => {
    spec.onProgress?.(Math.min(p1, p0 + Math.round((doneSec / rangeDur) * (p1 - p0))), `Encoding ${slices.length} slice(s) in parallel${speed ? ` (${speed.toFixed(1)}x)` : ''}...`)
  })

  const t0 = Date.now()
  await parallelMap(slices, async (s) => {
    const dur = s.end - s.start
    const ts = Date.now()
    await runFfmpeg(partArgs(spec, hasAudio, s, parts[s.index]), { label: `${label} part ${s.index}`, token: spec.token, onStderr: progress.forSlice(s.index, dur) })
    progress.complete(s.index, dur)
    const secs = (Date.now() - ts) / 1000
    spec.onLog?.(`ffmpeg: ${label} slice ${s.index + 1}/${slices.length}: ${dur.toFixed(1)}s in ${secs.toFixed(1)}s (${(dur / Math.max(0.1, secs)).toFixed(1)}x)`)
  })
  spec.onLog?.(`ffmpeg: ${label} parts done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { parts, workDir: placement.dir }
}

/** Join already-encoded parts into outFile (re-encode) and verify the duration. */
export async function joinParts(
  parts: string[],
  spec: Pick<SliceEncodeSpec, 'width' | 'height' | 'fps' | 'channels' | 'preset' | 'final' | 'onProgress' | 'onLog' | 'token' | 'label'>,
  outFile: string,
  expectedDur: number,
  extraVf?: string,
): Promise<void> {
  const listFile = `${outFile}.concat.txt`
  writeConcatList(listFile, parts)
  const tmp = `${outFile}.tmp.mp4`
  try {
    await runFfmpeg(joinArgs(listFile, spec, tmp, extraVf), {
      label: `${spec.label || 'join'} join`,
      token: spec.token,
      onStderr: (line) => {
        const { time, speed } = parseProgressLine(line)
        if (time === null) return
        spec.onProgress?.(70 + Math.min(29, Math.round((time / expectedDur) * 29)), `Joining (precise re-encode${speed ? `, ${speed.toFixed(1)}x` : ''})...`)
      },
    })
    fs.renameSync(tmp, outFile)
  } finally {
    fs.rmSync(listFile, { force: true })
    fs.rmSync(tmp, { force: true })
  }
  await verifyDuration(outFile, expectedDur, spec.fps, spec.onLog, path.basename(outFile))
}

// ---------- Twelve Labs normalize ----------

/**
 * Twelve Labs upload requirements: aspect ratio between 1:1 and 2.4:1 and at
 * least 360px on each side. If the source violates either rule, write a
 * padded/scaled COPY and return its path; otherwise return null.
 */
export async function normalizeForTwelveLabs(sourceFile: string, scanId = 'tl', onLog?: FfmpegLog): Promise<string | null> {
  const res = await probeResolution(sourceFile)
  if (!res) return null
  const { width: w, height: h } = res
  const MIN_SIDE = 360
  const MAX_AR = 2.35
  const MIN_AR = 1.0

  let targetW = w
  let targetH = h
  if (w / h > MAX_AR) targetH = Math.ceil(w / MAX_AR)
  else if (w / h < MIN_AR) targetW = h
  if (Math.min(targetW, targetH) < MIN_SIDE) {
    const scale = MIN_SIDE / Math.min(targetW, targetH)
    targetW = Math.ceil(targetW * scale)
    targetH = Math.ceil(targetH * scale)
  }
  targetW += targetW % 2
  targetH += targetH % 2
  if (targetW === w && targetH === h) return null

  const outFile = `${sourceFile}.tl-normalized.mp4`
  if (fs.existsSync(outFile)) return outFile

  const duration = await probeDuration(sourceFile)
  const fps = (await probeFps(sourceFile)) ?? 24
  const stage = `tl-normalize-${path.basename(sourceFile).replace(/\W+/g, '_')}`
  try {
    await sliceEncode({
      source: sourceFile,
      rangeStart: 0,
      rangeEnd: duration,
      scanId,
      stage,
      outFile,
      width: targetW,
      height: targetH,
      fps: Math.min(60, Math.round(fps)),
      channels: 2,
      preset: 'veryfast',
      final: { crf: 26, audioKbps: 96 },
      estimatedBytes: Math.ceil(duration * 0.6 * 1024 * 1024),
      onLog,
      label: 'TwelveLabs normalize',
    })
  } finally {
    removeStageWork(scanId, stage)
  }
  return outFile
}

// ---------- Gemini Minute Finder: movie upload copy ----------

/** Gemini Files API hard limit is 2 GB per file — stay safely under it. */
export const PRESCAN_MAX_BYTES = 1.9 * 1024 * 1024 * 1024

/**
 * Build the UPLOAD COPY of the movie for the Gemini Minute Finder: the trim
 * range cut precisely (no stream copy) and encoded at 480p / 24 fps / CRF 30
 * (parts in parallel, CRF 18 intermediates). If the result is still > 1.9 GB
 * the SAME parts are re-joined at 360p / CRF 32 — no second cut.
 */
export async function preparePrescanMovieCopy(
  movieFile: string,
  outFile: string,
  movieDuration: number,
  trimStart: number,
  trimEnd: number,
  onProgress: (pct: number, note: string) => void,
  opts: { scanId?: string; onLog?: FfmpegLog; token?: CancelToken } = {},
): Promise<{ durationSec: number; sizeBytes: number; reencoded: boolean }> {
  const rangeEnd = Math.min(trimEnd, movieDuration)
  const rangeDur = Math.max(1, rangeEnd - trimStart)
  const scanId = opts.scanId || path.basename(path.dirname(outFile))
  const stage = 'prescan-copy'
  const src = await probeResolution(movieFile)
  const ar = src ? src.width / src.height : 16 / 9
  const w480 = even(Math.round(480 * ar))
  const w360 = even(Math.round(360 * ar))

  onProgress(0, 'Precise re-encode (480p, all cores)...')
  try {
    const { parts } = await sliceEncode({
      source: movieFile,
      rangeStart: trimStart,
      rangeEnd,
      scanId,
      stage,
      outFile,
      width: w480,
      height: 480,
      fps: SCAN_FPS,
      channels: 1,
      preset: 'veryfast',
      final: { crf: 30, audioKbps: 64 },
      estimatedBytes: Math.ceil(rangeDur * 0.35 * 1024 * 1024),
      onProgress,
      onLog: opts.onLog,
      token: opts.token,
      label: 'Minute Finder movie copy',
    })
    if (fs.statSync(outFile).size > PRESCAN_MAX_BYTES) {
      onProgress(70, 'Still > 1.9 GB — re-joining smaller copy (360p)...')
      opts.onLog?.('ffmpeg: prescan copy > 1.9 GB → re-join parts at 360p / CRF 32')
      fs.rmSync(outFile, { force: true })
      await joinParts(
        parts,
        { width: w360, height: 360, fps: SCAN_FPS, channels: 1, preset: 'veryfast', final: { crf: 32, audioKbps: 48 }, onProgress, onLog: opts.onLog, token: opts.token, label: 'Minute Finder 360p' },
        outFile,
        rangeDur,
        `scale=${w360}:360`,
      )
      if (fs.statSync(outFile).size > PRESCAN_MAX_BYTES) {
        fs.rmSync(outFile, { force: true })
        throw new Error('Movie copy 360p par bhi 1.9 GB se badi hai — chhota trim range use karo.')
      }
    }
  } finally {
    removeStageWork(scanId, stage)
  }

  onProgress(100, 'Movie copy ready')
  const durationSec = await probeDuration(outFile)
  return { durationSec, sizeBytes: fs.statSync(outFile).size, reencoded: true }
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1
}

// Shared encode building blocks (used by lib/render.ts and lib/merge.ts).
export { IN_FLAGS, OUT_FLAGS, SCAN_FPS, scalePadFilter }
