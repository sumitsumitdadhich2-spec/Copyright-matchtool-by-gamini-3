import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getFfmpegPath, getFfprobePath } from './ffmpeg-bin'

// ---------------------------------------------------------------------------
// AUTO MERGE (short + movie → merged.mp4) — stream copy ONLY, no re-encode.
//
// HARD RULE: -c copy concat is only valid when BOTH files share the same
// video codec + width + height + pixel format AND compatible audio streams.
// Any mismatch => NO merge, clear Hinglish error, pipeline stops.
// Originals are NEVER touched — merged.mp4 is a separate new file.
// ---------------------------------------------------------------------------

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

export interface StreamInfo {
  video: {
    codec: string
    width: number
    height: number
    pixFmt: string
  } | null
  audio: {
    codec: string
    sampleRate: number
    channels: number
  } | null
}

/** Probe first video + audio stream of a file (codec/resolution/pix_fmt/audio). */
export async function probeStreamInfo(file: string): Promise<StreamInfo> {
  const info: StreamInfo = { video: null, audio: null }
  // Video stream v:0
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,pix_fmt',
      '-of', 'csv=p=0',
      file,
    ])
    const parts = out.trim().split(',')
    if (parts.length >= 4) {
      const [codec, w, h, pixFmt] = parts
      const width = Number.parseInt(w, 10)
      const height = Number.parseInt(h, 10)
      if (codec && Number.isFinite(width) && Number.isFinite(height)) {
        info.video = { codec, width, height, pixFmt: pixFmt || 'unknown' }
      }
    }
  } catch {
    // no/unreadable video stream
  }
  // Audio stream a:0
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,channels',
      '-of', 'csv=p=0',
      file,
    ])
    const parts = out.trim().split(',')
    if (parts.length >= 3 && parts[0]) {
      info.audio = {
        codec: parts[0],
        sampleRate: Number.parseInt(parts[1], 10) || 0,
        channels: Number.parseInt(parts[2], 10) || 0,
      }
    }
  } catch {
    // no audio stream
  }
  return info
}

export type CompatResult = { ok: true } | { ok: false; reason: string }

/** HARD RULE check: stream-copy concat is only allowed when everything matches. */
export async function checkMergeCompatibility(shortFile: string, movieFile: string): Promise<CompatResult> {
  const [a, b] = await Promise.all([probeStreamInfo(shortFile), probeStreamInfo(movieFile)])

  if (!a.video || !b.video) {
    return { ok: false, reason: 'Video stream read nahi ho paya (ffprobe fail) — file valid video hai kya?' }
  }
  const av = a.video
  const bv = b.video
  const vDesc = (v: NonNullable<StreamInfo['video']>) => `${v.width}x${v.height} ${v.codec} (${v.pixFmt})`
  if (av.codec !== bv.codec || av.width !== bv.width || av.height !== bv.height || av.pixFmt !== bv.pixFmt) {
    return {
      ok: false,
      reason: `Short aur movie ka format/resolution alag hai — bina re-encode merge possible nahi. Same format/resolution wali files use karo. (short ${vDesc(av)} vs movie ${vDesc(bv)})`,
    }
  }
  // Audio: one has audio, other doesn't => concat -c copy corrupt file banata hai.
  if (Boolean(a.audio) !== Boolean(b.audio)) {
    return {
      ok: false,
      reason: `Ek file me audio hai, dusri me nahi — stream-copy merge corrupt hoga. (short audio: ${a.audio ? 'haan' : 'nahi'}, movie audio: ${b.audio ? 'haan' : 'nahi'})`,
    }
  }
  if (a.audio && b.audio) {
    if (a.audio.codec !== b.audio.codec || a.audio.sampleRate !== b.audio.sampleRate || a.audio.channels !== b.audio.channels) {
      return {
        ok: false,
        reason: `Short aur movie ka audio format alag hai — bina re-encode merge possible nahi. (short ${a.audio.codec}/${a.audio.sampleRate}Hz/${a.audio.channels}ch vs movie ${b.audio.codec}/${b.audio.sampleRate}Hz/${b.audio.channels}ch)`,
      }
    }
  }
  return { ok: true }
}

/** Escape a path for the ffmpeg concat demuxer list file (single quotes). */
function concatEscape(p: string): string {
  return p.replace(/'/g, "'\\''")
}

/**
 * Stream-copy merge: PART A (short) first, PART B (movie) after.
 * NO re-encode (-c copy) — original quality, exact duration sum, originals untouched.
 */
export async function mergeVideos(
  shortFile: string,
  movieFile: string,
  outFile: string,
  onLog?: (line: string) => void,
): Promise<void> {
  const listFile = `${outFile}.list.txt`
  fs.writeFileSync(listFile, `file '${concatEscape(shortFile)}'\nfile '${concatEscape(movieFile)}'\n`)
  try {
    await run(
      getFfmpegPath(),
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile],
      onLog,
    )
  } finally {
    try {
      fs.unlinkSync(listFile)
    } catch {
      // ignore
    }
  }
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    throw new Error('Merge output file empty/missing — ffmpeg concat fail hua')
  }
}

export function mergedFilePath(mediaDir: string): string {
  return path.join(mediaDir, 'merged.mp4')
}
