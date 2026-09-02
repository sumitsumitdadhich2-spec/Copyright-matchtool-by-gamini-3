import { NextResponse } from 'next/server'
import { handleUpload, generateClientTokenFromReadWriteToken, type HandleUploadBody } from '@vercel/blob/client'
import { getScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'
import { mediaBlobPath } from '@/lib/media'

export const runtime = 'nodejs'

/**
 * Token endpoint for DIRECT browser → Vercel Blob uploads (@vercel/blob/client).
 *
 * The video bytes NEVER pass through this app server: the browser talks to the
 * Blob edge directly with a multipart upload (many parts in parallel), so the
 * user's full upstream bandwidth is used instead of being throttled by the
 * server/proxy hop. After the upload lands, the client calls
 * /upload/complete which pulls the file to local disk (datacenter speed) and
 * runs the ffmpeg finalize.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan = getScan(id)
  if (!scan) {
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  let body: HandleUploadBody | { type: 'direct'; kind: 'short' | 'movie'; contentType?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const allowed = [mediaBlobPath(id, 'short'), mediaBlobPath(id, 'movie')]

  // FAST PATH: hand the browser a short-lived client token scoped to exactly
  // one pathname so it can drive its own high-concurrency multipart upload
  // (createMultipartUpload / uploadPart / completeMultipartUpload). The stock
  // `upload()` helper caps at 6 parallel parts which starves high-latency
  // links; our own uploader runs many more in flight.
  if ('type' in body && body.type === 'direct') {
    if (body.kind !== 'short' && body.kind !== 'movie') {
      return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json({ error: 'Blob storage not configured' }, { status: 503 })
    }
    const pathname = mediaBlobPath(id, body.kind)
    try {
      const token = await generateClientTokenFromReadWriteToken({
        token: process.env.BLOB_READ_WRITE_TOKEN,
        pathname,
        allowedContentTypes: ['video/*', 'application/octet-stream'],
        maximumSizeInBytes: 5 * 1024 * 1024 * 1024, // 5 GB per video
        addRandomSuffix: false,
        allowOverwrite: true,
        // Enough for a multi-GB movie on a slow uplink.
        validUntil: Date.now() + 6 * 60 * 60 * 1000,
      })
      return NextResponse.json({ token, pathname })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload token failed' }, { status: 400 })
    }
  }

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!allowed.includes(pathname)) {
          throw new Error('Invalid upload path')
        }
        return {
          allowedContentTypes: ['video/*', 'application/octet-stream'],
          maximumSizeInBytes: 5 * 1024 * 1024 * 1024, // 5 GB per video
          addRandomSuffix: false,
          allowOverwrite: true,
        }
      },
      // The client-driven /upload/complete does the real finalize (this
      // webhook can't reach preview deployments, so we don't rely on it).
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Upload token failed' }, { status: 400 })
  }
}
