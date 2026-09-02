import { NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'
import { finalizeUploadedMedia, mediaBlobPath, type MediaKind } from '@/lib/media'
import { getSession } from '@/lib/users'
import { pipelineReady } from '@/lib/merge-pipeline'
import { dispatchMinuteFinder } from '@/lib/minute-finder-dispatch'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * DIRECT browser → Blob upload (@vercel/blob/client, multipart).
 *
 * The video bytes NEVER pass through this serverless function. The browser
 * asks this route for a short-lived client token, then streams the file in
 * parallel multipart chunks straight to Vercel Blob's upload endpoint — which
 * saturates the user's uplink instead of being throttled by the ~1 MB/s a
 * function-proxied 4 MB-per-request loop manages. It also side-steps the
 * 4.5 MB function body limit and per-instance /tmp affinity.
 *
 * One route, two modes (keeps the Hobby 12-function budget intact):
 *   POST /upload                      → @vercel/blob/client token handshake
 *   POST /upload?action=complete      → { kind, name }: pull Blob → /tmp,
 *                                        ffprobe, set up segments/trim state
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
  if (url.searchParams.get('action') === 'complete') {
    return complete(req, scan.id)
  }

  // ---- Token handshake for the client SDK ----
  let body: HandleUploadBody
  try {
    body = (await req.json()) as HandleUploadBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const allowed = new Set([mediaBlobPath(id, 'short'), mediaBlobPath(id, 'movie')])

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!allowed.has(pathname)) throw new Error('Invalid upload path')
        return {
          allowedContentTypes: ['video/*', 'application/octet-stream'],
          maximumSizeInBytes: 5 * 1024 * 1024 * 1024, // 5 GB per video
          addRandomSuffix: false,
          allowOverwrite: true,
        }
      },
      // Production webhook — intentionally a no-op. The client-driven
      // ?action=complete does the real finalize so it works identically in
      // preview (where Blob cannot call back into the sandbox) and production.
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload token failed' }, { status: 400 })
  }
}

async function complete(req: Request, id: string) {
  let kind: MediaKind
  let name: string
  try {
    const j = (await req.json()) as { kind?: string; name?: string }
    if (j.kind !== 'short' && j.kind !== 'movie') throw new Error('kind must be short or movie')
    kind = j.kind
    name = (j.name || '').trim() || 'video.mp4'
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid body' }, { status: 400 })
  }

  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  // Pull the freshly uploaded file from Blob to /tmp (force = replace any
  // stale local copy), probe with ffmpeg and set up segments / trim state.
  const result = await finalizeUploadedMedia(scan, kind, name)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  // AUTO MINUTE FINDER trigger (short-after-movie order): agar short abhi
  // aaya hai aur movie ka trim pehle se confirmed hai → user ke toggle ke
  // hisaab se Gemini Minute Finder / TwelveLabs pipeline / nothing.
  // (Movie-after-short order trim route se trigger hota hai.)
  if (kind === 'short') {
    try {
      const fresh = getScan(id)
      if (fresh && pipelineReady(fresh)) {
        const session = await getSession()
        await dispatchMinuteFinder(id, session ? { username: session.username, role: session.role } : null)
      }
    } catch (err) {
      console.error('[upload] minute finder auto-trigger failed:', err instanceof Error ? err.message : err)
    }
  }

  return NextResponse.json({ ok: true, done: true, duration: result.duration, size: result.size })
}
