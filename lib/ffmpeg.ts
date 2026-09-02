import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHUNK_SECONDS } from './models'
import { getFfmpegPath, getFfprobePath } from './ffmpeg-bin'

async function run(binPromise: Promise<string>, args: string[], onStderr?: (line: string) => void): Promise<string> {
  const bin = await binPromise
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => {
      const s = d.toString()
      stderr += s
      onStderr?.(s)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-800)}`))
    })
  })
}

export async function probeDuration(file: string): Promise<number> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      file,
    ])
    const dur = Number.parseFloat(out.trim())
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('Could not determine video duration')
    return dur
  } catch (probeErr) {
    // The bundled ffprobe (v4.0) is older than the bundled ffmpeg (v7.0) and
    // can fail on newer codecs (e.g. AV1). Fall back to parsing ffmpeg's
    // "Duration: HH:MM:SS.ss" stderr line before giving up.
    const dur = await probeDurationViaFfmpeg(file)
    if (dur !== null) return dur
    throw probeErr
  }
}

/** Fallback: read duration from `ffmpeg -i` stderr (works on codecs the old ffprobe can't parse). */
async function probeDurationViaFfmpeg(file: string): Promise<number | null> {
  let stderr = ''
  try {
    // `ffmpeg -i` with no output exits non-zero by design — capture stderr either way.
    await run(getFfmpegPath(), ['-hide_banner', '-i', file], (line) => (stderr += line))
  } catch (err) {
    stderr += err instanceof Error ? err.message : String(err)
  }
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  const dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  return Number.isFinite(dur) && dur > 0 ? dur : null
}

/** True when the file has at least one audio stream (silent movies need a synthesized track for concat). */
export async function probeHasAudio(file: string): Promise<boolean> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      file,
    ])
    return out.trim().length > 0
  } catch {
    return false
  }
}

function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** Every file sent to Gemini is hard-encoded at 24 fps (Gemini's default video rate). */
const SCAN_FPS_STR = '24'

/**
 * Cut the movie into exact sequential 1-minute chunks.
 * Re-encodes at 24 fps / 640px width / CRF 28 with keyframes forced at every 60s so
 * chunk boundaries are frame-accurate and files stay small for upload.
 * Optional trimStart/trimEnd (ABSOLUTE original-movie seconds) chunk ONLY that range —
 * the original movie file is never modified, only the scan copies are cut.
 */
export async function chunkMovie(
  movieFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
  trimStart = 0,
  trimEnd?: number,
): Promise<number> {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'chunk-%04d.mp4')
  const rangeEnd = trimEnd !== undefined && trimEnd > trimStart ? Math.min(trimEnd, duration) : duration
  const rangeDur = Math.max(1, rangeEnd - trimStart)
  const trimmed = trimStart > 0.01 || rangeEnd < duration - 0.01
  const args: string[] = ['-y']
  if (trimStart > 0.01) args.push('-ss', trimStart.toFixed(3))
  args.push('-i', movieFile)
  if (trimmed) args.push('-t', rangeDur.toFixed(3))
  args.push(
    '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'segment',
    '-segment_time', String(CHUNK_SECONDS),
    '-reset_timestamps', '1',
    pattern,
  )
  await run(getFfmpegPath(), args, (line) => {
    const t = parseFfmpegTime(line)
    if (t !== null) onProgress(Math.min(99, Math.round((t / rangeDur) * 100)))
  })
  onProgress(100)
  return fs.readdirSync(outDir).filter((f) => f.startsWith('chunk-') && f.endsWith('.mp4')).length
}

export function chunkPath(outDir: string, index: number): string {
  return path.join(outDir, `chunk-${String(index).padStart(4, '0')}.mp4`)
}

/**
 * Cut the SHORT video into exact sequential 1-minute scan segments (seg-0000.mp4, ...).
 * Same encode params as movie chunks (24 fps / 640px / CRF 28) — these files are
 * ONLY for scanning; the original short.mp4 is never touched.
 */
export async function chunkShort(
  shortFile: string,
  outDir: string,
  duration: number,
  onProgress: (pct: number) => void,
): Promise<number> {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'seg-%04d.mp4')
  await run(
    getFfmpegPath(),
    [
      '-y',
      '-i', shortFile,
      '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-force_key_frames', `expr:gte(t,n_forced*${CHUNK_SECONDS})`,
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-f', 'segment',
      '-segment_time', String(CHUNK_SECONDS),
      '-reset_timestamps', '1',
      pattern,
    ],
    (line) => {
      const t = parseFfmpegTime(line)
      if (t !== null) onProgress(Math.min(99, Math.round((t / duration) * 100)))
    },
  )
  onProgress(100)
  return fs.readdirSync(outDir).filter((f) => f.startsWith('seg-') && f.endsWith('.mp4')).length
}

export function segmentPath(outDir: string, index: number): string {
  return path.join(outDir, `seg-${String(index).padStart(4, '0')}.mp4`)
}

/** Remove all short-segment scan files. */
export function cleanupSegments(outDir: string) {
  if (!fs.existsSync(outDir)) return
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('seg-')) {
      try {
        fs.unlinkSync(path.join(outDir, f))
      } catch {
        // ignore
      }
    }
  }
}

/** Probe video width/height (first video stream). */
export async function probeResolution(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      file,
    ])
    const [w, h] = out.trim().split(/[,\s]+/).map((v) => Number.parseInt(v, 10))
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h }
    return null
  } catch {
    return null
  }
}

/**
 * Twelve Labs upload requirements: aspect ratio between 1:1 and 2.4:1 and
 * at least 360px on each side. If the source violates either rule, write a
 * padded/scaled COPY (black bars — content untouched) and return its path.
 * If the source is already valid (or probing fails), return null and the
 * caller uploads the original file as-is.
 */
export async function normalizeForTwelveLabs(sourceFile: string): Promise<string | null> {
  const res = await probeResolution(sourceFile)
  if (!res) return null
  let { width: w, height: h } = res
  const MIN_SIDE = 360
  // Slightly inside the limits so rounding can never tip us back over.
  const MAX_AR = 2.35
  const MIN_AR = 1.0

  let targetW = w
  let targetH = h
  // Too wide (like 1280x532 = 2.41:1) => pad height. Too tall => pad width.
  if (w / h > MAX_AR) targetH = Math.ceil(w / MAX_AR)
  else if (w / h < MIN_AR) targetW = h
  // Enforce minimum 360px on each side (scale up keeping the padded ratio).
  if (Math.min(targetW, targetH) < MIN_SIDE) {
    const scale = MIN_SIDE / Math.min(targetW, targetH)
    targetW = Math.ceil(targetW * scale)
    targetH = Math.ceil(targetH * scale)
  }
  // ffmpeg needs even dimensions for yuv420p.
  targetW += targetW % 2
  targetH += targetH % 2

  // Already valid (nothing changed) — upload the original untouched.
  if (targetW === w && targetH === h) return null

  const outFile = `${sourceFile}.tl-normalized.mp4`
  if (fs.existsSync(outFile)) return outFile // cached from a previous attempt
  await run(getFfmpegPath(), [
    '-y',
    '-i', sourceFile,
    '-vf', `scale=${targetW}:-2:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2:black`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '96k',
    outFile,
  ])
  return outFile
}

// ---------- Gemini Minute Finder: movie upload copy ----------

/** Gemini Files API hard limit is 2 GB per file — stay safely under it. */
export const PRESCAN_MAX_BYTES = 1.9 * 1024 * 1024 * 1024

/**
 * Build the UPLOAD COPY of the movie for the Gemini Minute Finder:
 *   - cut to the confirmed trim range (absolute original-movie seconds)
 *   - stream copy (-c copy, fast) when the cut stays ≤ 1.9 GB
 *   - otherwise a compressed re-encode (480p / 24 fps / CRF 30 / AAC 64k),
 *     and a second, smaller pass (360p / CRF 32) if it is STILL too big.
 * Audio is always kept (dialogue is the strongest fingerprint).
 * Only this copy goes to Gemini — the original, chunks and render are untouched.
 */
export async function preparePrescanMovieCopy(
  movieFile: string,
  outFile: string,
  movieDuration: number,
  trimStart: number,
  trimEnd: number,
  onProgress: (pct: number, note: string) => void,
): Promise<{ durationSec: number; sizeBytes: number; reencoded: boolean }> {
  const rangeEnd = Math.min(trimEnd, movieDuration)
  const rangeDur = Math.max(1, rangeEnd - trimStart)
  const trimmed = trimStart > 0.01 || rangeEnd < movieDuration - 0.01
  const srcSize = fs.statSync(movieFile).size
  const estCutSize = trimmed ? srcSize * (rangeDur / Math.max(1, movieDuration)) : srcSize

  const cutArgs = (): string[] => {
    const a: string[] = ['-y']
    if (trimStart > 0.01) a.push('-ss', trimStart.toFixed(3))
    a.push('-i', movieFile)
    if (trimmed) a.push('-t', rangeDur.toFixed(3))
    return a
  }
  const progress = (note: string) => (line: string) => {
    const t = parseFfmpegTime(line)
    if (t !== null) onProgress(Math.min(99, Math.round((t / rangeDur) * 100)), note)
  }

  const tmp = `${outFile}.tmp.mp4`
  let reencoded = false

  if (estCutSize <= PRESCAN_MAX_BYTES) {
    // Fast path: stream copy (no re-encode). -ss before -i seeks to the
    // nearest keyframe, which may start a few seconds early — the ±1 minute
    // buffer on the minute list absorbs that.
    onProgress(0, 'Stream copy (no re-encode)...')
    await run(getFfmpegPath(), [...cutArgs(), '-c', 'copy', '-movflags', '+faststart', tmp], progress('Stream copy...'))
    if (fs.statSync(tmp).size > PRESCAN_MAX_BYTES) {
      // Estimate was off — fall through to re-encode.
      fs.unlinkSync(tmp)
    } else {
      fs.renameSync(tmp, outFile)
    }
  }

  if (!fs.existsSync(outFile)) {
    reencoded = true
    onProgress(0, 'Re-encoding compressed copy (480p)...')
    await run(
      getFfmpegPath(),
      [
        ...cutArgs(),
        '-vf', 'scale=-2:480', '-r', '24',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
        '-movflags', '+faststart',
        tmp,
      ],
      progress('Re-encoding 480p...'),
    )
    if (fs.statSync(tmp).size > PRESCAN_MAX_BYTES) {
      fs.unlinkSync(tmp)
      onProgress(0, 'Still > 1.9 GB — re-encoding smaller copy (360p)...')
      await run(
        getFfmpegPath(),
        [
          ...cutArgs(),
          '-vf', 'scale=-2:360', '-r', '24',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
          '-c:a', 'aac', '-b:a', '48k', '-ac', '1',
          '-movflags', '+faststart',
          tmp,
        ],
        progress('Re-encoding 360p...'),
      )
      if (fs.statSync(tmp).size > PRESCAN_MAX_BYTES) {
        fs.unlinkSync(tmp)
        throw new Error('Movie copy 360p par bhi 1.9 GB se badi hai — chhota trim range use karo.')
      }
    }
    fs.renameSync(tmp, outFile)
  }

  onProgress(100, 'Movie copy ready')
  const durationSec = await probeDuration(outFile)
  return { durationSec, sizeBytes: fs.statSync(outFile).size, reencoded }
}

// ---------- Render/export helpers (used by lib/render.ts) ----------

/** Absolute path to a runnable ffmpeg binary (render pipeline spawns its own process for kill support). */
export function getFfmpegBin(): Promise<string> {
  return getFfmpegPath()
}

/** Parse an ffmpeg progress line into { time, speed } (either may be null). */
export function parseFfmpegProgress(line: string): { time: number | null; speed: number | null } {
  const time = parseFfmpegTime(line)
  const sm = line.match(/speed=\s*(\d+(?:\.\d+)?)x/)
  const speed = sm ? Number.parseFloat(sm[1]) : null
  return { time, speed }
}

/** Extract a sub-clip from a video (used when trimming the short video on upload). Output is 24 fps. */
export async function extractSegment(
  sourceFile: string,
  start: number,
  end: number,
  outFile: string,
): Promise<void> {
  const dur = Math.max(1, end - start)
  await run(getFfmpegPath(), [
    '-y',
    '-ss', start.toFixed(2),
    '-i', sourceFile,
    '-t', dur.toFixed(2),
    '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    outFile,
  ])
}

/** Millisecond-precise clip cut for the verifier/rescan pipeline.
 * Re-encodes at 24 fps (640px / CRF 28 / mono AAC) so cuts are frame-accurate at 24 fps.
 * Very short windows are padded to a minimum of 1s so Gemini gets enough frames. */
export async function extractClipPrecise(
  sourceFile: string,
  start: number,
  end: number,
  outFile: string,
): Promise<void> {
  const dur = Math.max(1, end - start)
  await run(getFfmpegPath(), [
    '-y',
    '-ss', Math.max(0, start).toFixed(3),
    '-i', sourceFile,
    '-t', dur.toFixed(3),
    '-vf', `scale=640:-2,fps=${SCAN_FPS_STR}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    outFile,
  ])
}

/** Remove all temporary verifier/rescan clip files. */
export function cleanupClips(clipsDir: string) {
  if (!fs.existsSync(clipsDir)) return
  for (const f of fs.readdirSync(clipsDir)) {
    if (f.endsWith('.mp4')) {
      try {
        fs.unlinkSync(path.join(clipsDir, f))
      } catch {
        // ignore
      }
    }
  }
}

export function cleanupChunks(outDir: string) {
  if (!fs.existsSync(outDir)) return
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith('chunk-')) {
      try {
        fs.unlinkSync(path.join(outDir, f))
      } catch {
        // ignore
      }
    }
  }
}
