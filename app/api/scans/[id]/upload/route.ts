import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { finalizeUploadedMedia, localMediaPath, mirrorMediaToStorage } from '@/lib/media'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'

export const runtime = 'nodejs'

/**
 * SINGLE-STREAM, RESUMABLE upload — the ONLY upload path.
 *
 * The browser opens ONE request and streams the whole file through it. The
 * body is piped straight from the socket onto the EBS disk (never buffered in
 * RAM — a 4 GB movie uses a few hundred KB of memory). One long-lived TCP
 * connection with no per-chunk round trips is what gives full line speed.
 *
 * IMPORTANT: this route is EXCLUDED from proxy.ts's matcher. When the proxy
 * matches a route, Next.js clones + buffers the request body in memory (10 MB
 * cap → "Request body exceeded 10MB" and a truncated file). So authentication
 * is done here, inside the handler.
 *
 * Resume: the upload is keyed by a fingerprint of the file (name + size +
 * lastModified). A sidecar .meta records how many CONTIGUOUS bytes have landed.
 * If the connection drops, the browser asks GET ?kind=&session=&total= for
 * `received` and re-opens the stream from that byte with ?offset=. A different
 * fingerprint starts a fresh .part.
 *
 * When the last byte lands the file is renamed into place and ffprobe runs
 * immediately. The S3 backup runs in the background — never blocks the user.
 *
 * POST query params:
 *   ?kind=short|movie & name=<filename> & total=<file size> & session=<fingerprint>
 *   & offset=<byte offset the stream starts at>
 */

interface PartMeta {
  session: string
  total: number
  name: string
  /** Contiguous bytes on disk from byte 0. */
  received: number
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

function parseCommon(req: Request) {
  const url = new URL(req.url)
  const kind = url.searchParams.get('kind')
  const session = (url.searchParams.get('session') || '').slice(0, 64)
  const total = Number.parseInt(url.searchParams.get('total') || '', 10)
  return { url, kind, session, total }
}

/** Current resumable state for this exact file (0 when nothing usable is on disk). */
function currentReceived(dest: string, session: string, total: number): number {
  const part = `${dest}.part`
  const meta = readMeta(`${dest}.meta`)
  if (!meta || meta.session !== session || meta.total !== total) return 0
  if (!fs.existsSync(/*turbopackIgnore: true*/ part)) return 0
  // Trust the smaller of meta vs. actual size — never claim bytes we don't have.
  const onDisk = fs.statSync(/*turbopackIgnore: true*/ part).size
  return Math.max(0, Math.min(meta.received, onDisk))
}

/** Resume probe: how many contiguous bytes of this exact file already landed? */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return NextResponse.json({ error: 'Unauthorized — please log in' }, { status: 401 })
  const { id } = await ctx.params
  const scan = await loadScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const { kind, session, total } = parseCommon(req)
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }
  if (!session || !Number.isFinite(total) || total <= 0) return NextResponse.json({ received: 0 })
  return NextResponse.json({ received: currentReceived(localMediaPath(id, kind), session, total) })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sessionUser = await getSession()
  if (!sessionUser) return NextResponse.json({ error: 'Unauthorized — please log in' }, { status: 401 })

  const { id } = await ctx.params
  const scan = await loadScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const { url, kind, session: rawSession, total } = parseCommon(req)
  const rawName = url.searchParams.get('name') || 'video.mp4'
  const name = rawName.trim() || 'video.mp4'
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }
  const session = rawSession || 'legacy'
  const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(offset) || offset < 0 || offset >= total) {
    return NextResponse.json({ error: 'Invalid offset/total' }, { status: 400 })
  }
  if (!req.body) return NextResponse.json({ error: 'Empty upload body' }, { status: 400 })

  const dest = localMediaPath(id, kind)
  const part = `${dest}.part`
  const metaPath = `${dest}.meta`
  fs.mkdirSync(path.dirname(dest), { recursive: true })

  // ---- Where does this stream have to start? The client must continue
  // exactly where the disk ends. If it doesn't (stale tab, race), tell it the
  // truth with 409 so it re-syncs instead of corrupting the file.
  let received = currentReceived(dest, session, total)
  if (offset === 0 && received > 0 && received < total) {
    // Explicit fresh start of the same file — drop the old attempt.
    received = 0
  }
  if (offset !== received) {
    return NextResponse.json({ error: 'Offset mismatch — resuming from the server position', received }, { status: 409 })
  }
  if (received === 0) {
    safeUnlink(part)
    safeUnlink(metaPath)
  }
  const meta: PartMeta = { session, total, name, received, updatedAt: Date.now() }
  writeMeta(metaPath, meta)

  // ---- Stream socket → disk. `r+` keeps existing bytes when resuming.
  const out = fs.createWriteStream(part, { flags: received === 0 ? 'w' : 'r+', start: received, highWaterMark: 4 * 1024 * 1024 })
  let bytes = 0
  let lastMetaFlush = Date.now()
  const counter = new (await import('node:stream')).Transform({
    highWaterMark: 4 * 1024 * 1024,
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length
      if (received + bytes > total) {
        cb(new Error('Stream extends past declared file size'))
        return
      }
      // Persist progress every ~2 s so a crash mid-stream still resumes close to the edge.
      const now = Date.now()
      if (now - lastMetaFlush > 2000) {
        lastMetaFlush = now
        try {
          writeMeta(metaPath, { ...meta, received: received + bytes, updatedAt: now })
        } catch {
          // best effort
        }
      }
      cb(null, chunk)
    },
  })

  const startedAt = Date.now()
  try {
    await pipeline(Readable.fromWeb(req.body as import('node:stream/web').ReadableStream), counter, out)
  } catch (err) {
    // Client disconnected / network drop: keep what landed so the browser can
    // resume from `received` on its next attempt. The write stream has already
    // flushed everything it accepted at this point.
    const landed = received + bytes
    try {
      // Only count bytes that are really on disk.
      const onDisk = fs.existsSync(/*turbopackIgnore: true*/ part) ? fs.statSync(/*turbopackIgnore: true*/ part).size : 0
      writeMeta(metaPath, { ...meta, received: Math.min(landed, onDisk), updatedAt: Date.now() })
    } catch {
      // ignore
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[upload] ${kind} stream interrupted at ${landed}/${total} bytes: ${msg}`)
    if (msg.includes('past declared')) {
      safeUnlink(part)
      safeUnlink(metaPath)
      return NextResponse.json({ error: 'Upload data exceeded the declared file size' }, { status: 400 })
    }
    return NextResponse.json({ error: 'Upload interrupted', received: Math.min(landed, total) }, { status: 499 })
  }

  received += bytes
  const secs = Math.max(0.001, (Date.now() - startedAt) / 1000)
  console.log(`[upload] ${kind}: +${(bytes / 1048576).toFixed(1)} MB in ${secs.toFixed(1)}s (${((bytes * 8) / secs / 1e6).toFixed(0)} Mbps) → ${received}/${total}`)

  if (received < total) {
    // Client closed early on purpose (or the network truncated the body).
    writeMeta(metaPath, { ...meta, received, updatedAt: Date.now() })
    return NextResponse.json({ ok: true, received })
  }

  // ---- Every byte landed — verify size on disk and move into place.
  const size = fs.statSync(/*turbopackIgnore: true*/ part).size
  if (size !== total) {
    safeUnlink(part)
    safeUnlink(metaPath)
    console.error(`[upload] size mismatch after stream end: expected ${total}, got ${size}`)
    return NextResponse.json(
      { error: `Upload incomplete — received ${size.toLocaleString()} of ${total.toLocaleString()} bytes. Please try again.` },
      { status: 400 },
    )
  }
  fs.renameSync(part, dest)
  safeUnlink(metaPath)

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
        await dispatchMinuteFinder(id, { username: sessionUser.username, role: sessionUser.role })
      }
    } catch (err) {
      console.error('[upload] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ ok: true, done: true, duration: result.duration, size: result.size })
}
