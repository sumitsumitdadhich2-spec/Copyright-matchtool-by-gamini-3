import { NextResponse } from 'next/server'
import fs from 'node:fs'
import { getScan, saveScan, addLog, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'
import { finalizeUploadedMedia, localMediaPath } from '@/lib/media'
import { getSession } from '@/lib/users'
import { getUserTwelveLabsKey } from '@/lib/user-keys'
import { startMergePipeline, pipelineReady, isPipelineRunning } from '@/lib/merge-pipeline'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * CHUNKED upload: the browser slices the video into small pieces (~4 MB) and
 * sends them sequentially. Small request bodies pass through proxies and
 * serverless body-size limits that silently truncate a single giant POST.
 *
 * Each chunk carries its byte offset; the server appends it to a .part file
 * and, once the final byte arrives, renames it into place and runs ffmpeg.
 * Retried chunks (same offset) are detected and skipped, so the client can
 * safely retry on network errors.
 *
 * Query params:
 *   ?kind=short|movie & name=<filename> & offset=<byte offset> & total=<file size>
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan = getScan(id)
  if (!scan) {
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
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

  // Starting a new upload (offset 0) always begins a fresh .part file.
  const partSize = offset === 0 ? 0 : fs.existsSync(/*turbopackIgnore: true*/ part) ? fs.statSync(part).size : 0

  if (offset === 0) {
    try {
      fs.writeFileSync(part, chunk)
    } catch (err) {
      console.error('[upload] write failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Upload failed while saving the file. Please try again.' }, { status: 500 })
    }
  } else if (offset === partSize) {
    // Expected next chunk — append.
    try {
      fs.appendFileSync(part, chunk)
    } catch (err) {
      console.error('[upload] append failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Upload failed while saving the file. Please try again.' }, { status: 500 })
    }
  } else if (offset + chunk.length <= partSize) {
    // Duplicate of an already-written chunk (client retried after a lost
    // response) — ignore it, the bytes are already on disk.
  } else {
    // Gap or partial overlap — the .part file is out of sync with the client.
    // Report where the server actually is so the client can resume from there.
    return NextResponse.json(
      { error: 'Upload out of sync — please restart the upload.', received: partSize },
      { status: 409 },
    )
  }

  const newSize = fs.statSync(/*turbopackIgnore: true*/ part).size
  if (newSize < total) {
    // More chunks to come.
    return NextResponse.json({ ok: true, received: newSize })
  }

  // Last chunk arrived — verify and move into place.
  if (newSize !== total) {
    try {
      fs.unlinkSync(part)
    } catch {
      // ignore cleanup failure
    }
    console.error(`[upload] size mismatch after final chunk: expected ${total}, got ${newSize}`)
    return NextResponse.json(
      { error: `Upload incomplete — received ${newSize.toLocaleString()} of ${total.toLocaleString()} bytes. Please try again.` },
      { status: 400 },
    )
  }
  fs.renameSync(part, dest)

  // Probe with ffmpeg and set up segments / trim state right away.
  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // AUTO MERGE PIPELINE trigger (short-after-movie order): agar short abhi
  // aaya hai aur movie ka trim pehle se confirmed hai → pipeline auto-start.
  // (Movie-after-short order trim route se trigger hota hai.)
  if (kind === 'short') {
    try {
      const fresh = getScan(id)
      if (fresh && pipelineReady(fresh) && !isPipelineRunning(id)) {
        const st = fresh.mergePipeline?.status
        if (!st || st === 'idle') {
          const session = await getSession()
          const tlKey = session ? await getUserTwelveLabsKey(session.username) : null
          if (!tlKey) {
            addLog(fresh, 'info', 'TwelveLabs key nahi — auto merge pipeline skip, app normal flow me chalega')
            saveScan(fresh)
          } else {
            startMergePipeline(id, tlKey)
          }
        }
      }
    } catch (err) {
      console.error('[upload] merge pipeline auto-trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ ok: true, done: true, duration: result.duration, size: result.size })
}
