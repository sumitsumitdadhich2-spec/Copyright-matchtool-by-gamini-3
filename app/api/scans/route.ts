import { NextResponse } from 'next/server'
import { listScans, newScan, pruneOldScans, MAX_SCANS, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { getStorageUsage, STORAGE_LIMIT_BYTES } from '@/lib/media'
import { getSession } from '@/lib/users'
import { ensureBackgroundWorkers, MAX_BACKGROUND_SCANS_PER_USER } from '@/lib/background-queue'

export const runtime = 'nodejs'

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await restoreScans(SCANS_DIR)
  await ensureBackgroundWorkers()
  const used = await getStorageUsage()
  const scans = listScans().filter((scan) => session.role === 'admin' || scan.ownerUsername === session.username)
  return NextResponse.json({ scans, storage: { used, limit: STORAGE_LIMIT_BYTES }, backgroundLimit: MAX_BACKGROUND_SCANS_PER_USER })
}

export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await restoreScans(SCANS_DIR)
  const scan = newScan(session.username)
  // Keep at most MAX_SCANS scans: creating one more removes the oldest one
  // (its JSON record, its local video files, and its S3 backup).
  const deleted = pruneOldScans(MAX_SCANS)
  return NextResponse.json({ id: scan.id, deleted, maxScans: MAX_SCANS })
}
