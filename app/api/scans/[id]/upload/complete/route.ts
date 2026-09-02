import { NextResponse } from 'next/server'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob, flushScanToBlob } from '@/lib/scan-blob'
import { ensureLocalMedia, finalizeUploadedMedia } from '@/lib/media'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * Called by the client AFTER the direct browser → Blob upload finished.
 * Pulls the video from Blob to local disk (server-to-Blob is datacenter
 * bandwidth — far faster than the user's uplink), probes it with ffmpeg and
 * sets up the scan state (segments for shorts, trim-await for movies).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan = getScan(id)
  if (!scan) {
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { kind?: string; name?: string }
  const kind = body.kind
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'video.mp4'
  if (kind !== 'short' && kind !== 'movie') {
    return NextResponse.json({ error: 'kind must be short or movie' }, { status: 400 })
  }

  // force=true: a fresh upload must replace any stale local copy of a
  // previous video for this scan/kind.
  const local = await ensureLocalMedia(id, kind, true)
  if (!local) {
    return NextResponse.json(
      { error: 'Video not found in storage — the upload may not have finished. Please try again.' },
      { status: 400 },
    )
  }

  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // Same auto-trigger as the chunked route: short arrived after the movie
  // trim was already confirmed → kick off the minute finder.
  if (kind === 'short') {
    try {
      const fresh = getScan(id)
      if (fresh && pipelineReady(fresh)) {
        const session = await getSession()
        await dispatchMinuteFinder(id, session ? { username: session.username, role: session.role } : null)
      }
    } catch (err) {
      console.error('[upload/complete] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  // Make sure the finalized state is IN Blob before responding — the next
  // poll may hit another instance.
  const finalized = getScan(id)
  if (finalized) await flushScanToBlob(finalized)

  return NextResponse.json({ ok: true, done: true, duration: result.duration, size: result.size })
}
