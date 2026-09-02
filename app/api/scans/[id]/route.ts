import { NextResponse } from 'next/server'
import { getScan, getFreshScan, getApiKey, getAllUsage, deleteScan, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'
import { invalidateUsageCache } from '@/lib/media'
import { scheduler } from '@/lib/scheduler'
import { getSession } from '@/lib/users'
import { isMinuteFinderRunning, stopGeminiMinuteFinder } from '@/lib/gemini-minute-finder'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  let scan: Awaited<ReturnType<typeof getFreshScan>>
  if (scheduler.isRunning(id) || isMinuteFinderRunning(id)) {
    // Scan / minute finder is actively running ON THIS instance — local state is freshest.
    scan = getScan(id)
  } else {
    // Cross-instance safe read: another serverless instance may have just
    // updated this scan (e.g. finalized an upload). Compare local vs Blob
    // and serve whichever is newer, so state never "disappears".
    scan = await getFreshScan(id)
  }
  if (!scan) {
    // Cold start: the record may only exist in Blob storage.
    await restoreScansFromBlob(SCANS_DIR)
    scan = getScan(id)
  }
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const key = getApiKey()
  return NextResponse.json({
    scan,
    running: scheduler.isRunning(id),
    usage: key ? getAllUsage(key) : null,
  })
}

/** Delete a scan completely: record + local files + ALL Blob storage (videos included). */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  await restoreScansFromBlob(SCANS_DIR)
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Stop any running scan job / minute finder before removing its files.
  if (scheduler.isRunning(id)) scheduler.stop(id)
  if (isMinuteFinderRunning(id)) stopGeminiMinuteFinder(id)

  deleteScan(id)
  invalidateUsageCache()
  return NextResponse.json({ ok: true, deleted: id })
}
