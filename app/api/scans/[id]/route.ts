import { NextResponse } from 'next/server'
import { getScan, getApiKey, getAllUsage, deleteScan, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { invalidateUsageCache } from '@/lib/media'
import { scheduler } from '@/lib/scheduler'
import { ensureBackgroundWorkers, stopBackgroundScan } from '@/lib/background-queue'
import { getSession } from '@/lib/users'
import { isMinuteFinderRunning, stopGeminiMinuteFinder } from '@/lib/gemini-minute-finder'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ensureBackgroundWorkers()
  const { id } = await ctx.params
  // Single long-lived server: the local JSON is always the freshest copy.
  let scan = getScan(id)
  if (!scan) {
    // Fresh instance: the record may only exist in S3.
    await restoreScans(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const key = getApiKey()
  return NextResponse.json({
    scan,
    running: scheduler.isRunning(id),
    usage: key ? getAllUsage(key) : null,
  })
}

/** Delete a scan completely: record + local files + work dirs + ALL S3 objects. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  await restoreScans(SCANS_DIR)
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.role !== 'admin' && scan.ownerUsername !== session.username) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Stop queued/running scan work and the minute finder before removing files.
  await stopBackgroundScan(id)
  if (scheduler.isRunning(id)) scheduler.stop(id)
  if (isMinuteFinderRunning(id)) stopGeminiMinuteFinder(id)

  deleteScan(id)
  invalidateUsageCache()
  return NextResponse.json({ ok: true, deleted: id })
}
