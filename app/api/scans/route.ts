import { NextResponse } from 'next/server'
import { listScans, newScan, pruneOldScans, MAX_SCANS, SCANS_DIR } from '@/lib/store'
import { restoreScans } from '@/lib/scan-store'
import { getStorageUsage, STORAGE_LIMIT_BYTES } from '@/lib/media'

export const runtime = 'nodejs'

export async function GET() {
  // Fresh instance: DATA_DIR/scans may be empty — pull records back from S3.
  await restoreScans(SCANS_DIR)
  const used = await getStorageUsage()
  return NextResponse.json({ scans: listScans(), storage: { used, limit: STORAGE_LIMIT_BYTES } })
}

export async function POST() {
  await restoreScans(SCANS_DIR)
  const scan = newScan()
  // Keep at most MAX_SCANS scans: creating one more removes the oldest one
  // (its JSON record, its local video files, and its S3 backup).
  const deleted = pruneOldScans(MAX_SCANS)
  return NextResponse.json({ id: scan.id, deleted, maxScans: MAX_SCANS })
}
