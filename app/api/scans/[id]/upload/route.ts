import { NextResponse } from 'next/server'
import fs from 'node:fs'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { finalizeUploadedMedia, localMediaPath, mirrorMediaToStorage } from '@/lib/media'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'

export const runtime = 'nodejs'

/**
 * PARALLEL CHUNKED, RESUMABLE upload — the ONLY upload path.
 *
 * The browser slices the video into chunks (16 MB by default) and sends
 * several of them at once. Each chunk is written at its byte offset
 * (positional write) straight onto the EBS disk — the file can be larger than
 * RAM. A sidecar .meta file tracks which byte ranges have landed; the request
 * that completes coverage renames the file into place and runs ffprobe.
 *
 * Resume: the meta is keyed by a fingerprint of the file (name + size +
 * lastModified). GET ?kind=&fingerprint= returns the ranges already received
 * so a refreshed browser only sends what is missing. A different fingerprint
 * starts a fresh .part.
 *
 * S3 backup runs in the background after finalize — never blocks the user.
 *
 * POST query params:
 *   ?kind=short|movie & name=<filename> & offset=<byte offset> & total=<file size>
 *   & session=<file fingerprint>
 */

interface PartMeta {
  session: string
  total: number
  name: string
  /** Sorted, non-overlapping [start, end) byte ranges received so far. */
  ranges: Array<[number, number]>
  updatedAt: number
}

function readMeta(metaPath: string): PartMeta | null {
  try {
    if (!fs.existsSync(/*turbopackIgnore: true*/ metaPath)) return null
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PartMeta
  } catch {
    return null
  }
}

function writeMeta(metaPath: string, meta: PartMeta) {
  const tmp = `${metaPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(meta))
  fs.renameSync(tmp, metaPath)
}

/** Insert [start, end) and merge adjacent/overlapping ranges. */
function addRange(ranges: Array<[number, number]>, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let s = start
  let e = end
  let inserted = false
  for (const [rs, re] of ranges) {
    if (re < s) {
      out.push([rs, re])
    } else if (rs > e) {
      if (!inserted) {
        out.push([s, e])
        inserted = true
      }
      out.push([rs, re])
    } else {
      s = Math.min(s, rs)
      e = Math.max(e, re)
    }
  }
  if (!inserted) out.push([s, e])
  return out
}

function covered(ranges: Array<[number, number]>): number {
  let n = 0
  for (const [s, e] of ranges) n += e - s
  return n
}

function safeUnlink(p: string) {
  try {
    fs.unlinkSync(p)
  } catch {
    // ignore
  }
}

async function loadScan(id: string) {
  let scan = getScan(id)
  if (!scan) {
    await restoreScans(SCANS_DIR)
    scan = getScan(id)
  }
  return scan
}

/** Resume probe: which byte ranges of this exact file have already landed? */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = await loadScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind')
  const session = (url.searchParams.get('session') || '').slice(0, 64)
  const total = Number.parseInt(url.searchParams.get('total') || '', 10)
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }
  const dest = localMediaPath(id, kind)
  const meta = readMeta(`${dest}.meta`)
  if (!meta || meta.session !== session || meta.total !== total || !fs.existsSync(/*turbopackIgnore: true*/ `${dest}.part`)) {
    return NextResponse.json({ ranges: [], received: 0 })
  }
  return NextResponse.json({ ranges: meta.ranges, received: covered(meta.ranges) })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = await loadScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind')
  const rawName = url.searchParams.get('name') || 'video.mp4'
  const name = rawName.trim() || 'video.mp4'
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }

  const offset = Number.parseInt(url.searchParams.get('offset') || '', 10)
  const total = Number.parseInt(url.searchParams.get('total') || '', 10)
  const session = (url.searchParams.get('session') || '').slice(0, 64) || 'legacy'
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(total) || total <= 0 || offset >= total) {
    return NextResponse.json({ error: 'Invalid offset/total' }, { status: 400 })
  }

  let chunk: Buffer
  try {
    chunk = Buffer.from(await req.arrayBuffer())
  } catch (err) {
    console.error('[upload] failed to read chunk body:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Failed to read upload chunk. Please retry.' }, { status: 400 })
  }
  if (chunk.length === 0) {
    return NextResponse.json({ error: 'Empty upload chunk' }, { status: 400 })
  }
  if (offset + chunk.length > total) {
    return NextResponse.json({ error: 'Chunk extends past declared file size' }, { status: 400 })
  }

  const dest = localMediaPath(id, kind)
  const part = `${dest}.part`
  const metaPath = `${dest}.meta`

  // ---- Positional write onto EBS. All fs work below is synchronous so two
  // concurrent requests in the same process can never interleave a
  // read-modify-write of the meta file.
  let complete = false
  try {
    let meta = readMeta(metaPath)
    const fresh = !meta || meta.session !== session || meta.total !== total || !fs.existsSync(/*turbopackIgnore: true*/ part)
    if (fresh) {
      // New upload attempt — start a clean .part (drops any half-finished one).
      safeUnlink(part)
      fs.closeSync(fs.openSync(part, 'w'))
      meta = { session, total, name, ranges: [], updatedAt: Date.now() }
    }

    const fd = fs.openSync(part, 'r+')
    try {
      let written = 0
      while (written < chunk.length) {
        written += fs.writeSync(fd, chunk, written, chunk.length - written, offset + written)
      }
    } finally {
      fs.closeSync(fd)
    }

    meta!.ranges = addRange(meta!.ranges, offset, offset + chunk.length)
    meta!.updatedAt = Date.now()
    writeMeta(metaPath, meta!)

    const received = covered(meta!.ranges)
    if (received < total) {
      // More chunks to come (or still in flight).
      return NextResponse.json({ ok: true, received })
    }

    // Every byte has landed — verify the on-disk size and move into place.
    const size = fs.statSync(/*turbopackIgnore: true*/ part).size
    if (size !== total) {
      safeUnlink(part)
      safeUnlink(metaPath)
      console.error(`[upload] size mismatch after final chunk: expected ${total}, got ${size}`)
      return NextResponse.json(
        { error: `Upload incomplete — received ${size.toLocaleString()} of ${total.toLocaleString()} bytes. Please try again.` },
        { status: 400 },
      )
    }
    fs.renameSync(part, dest)
    safeUnlink(metaPath)
    complete = true
  } catch (err) {
    console.error('[upload] write failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Upload failed while saving the file. Please try again.' }, { status: 500 })
  }
  if (!complete) return NextResponse.json({ ok: true })

  // Probe with ffprobe and set up segments / trim state right away.
  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // Durable copy to S3 in the background — the user never waits for it.
  void mirrorMediaToStorage(id, kind, req.headers.get('x-video-type') || 'video/mp4')

  // AUTO MINUTE FINDER trigger (short-after-movie order): agar short abhi
  // aaya hai aur movie ka trim pehle se confirmed hai → user ke toggle ke
  // hisaab se Gemini Minute Finder / TwelveLabs pipeline / nothing.
  // (Movie-after-short order trim route se trigger hota hai.)
  if (kind === 'short') {
    try {
      const fresh = getScan(id)
      if (fresh && pipelineReady(fresh)) {
        const s = await getSession()
        await dispatchMinuteFinder(id, s ? { username: s.username, role: s.role } : null)
      }
    } catch (err) {
      console.error('[upload] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ ok: true, done: true, duration: result.duration, size: result.size })
}
