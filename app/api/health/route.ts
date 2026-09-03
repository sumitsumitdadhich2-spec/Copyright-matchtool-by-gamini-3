import { NextResponse } from 'next/server'
import fs from 'node:fs'
import os from 'node:os'
import { poolSnapshot } from '@/lib/ffmpeg-pool'
import { bootWorkDirs, ramWorkUsed } from '@/lib/work-dir'
import { diskFree } from '@/lib/media'
import { storageEnabled, storageHealthy } from '@/lib/storage'
import { DATA_DIR, WORK_DIR, WORK_RAM_BUDGET_BYTES, MAX_SCANS } from '@/lib/paths'
import { getFfmpegPathSync } from '@/lib/ffmpeg-bin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/health — used by the Docker HEALTHCHECK and for a quick look at the
 * box: cores/engines, active ffmpeg jobs, RAM + tmpfs usage, disk free, S3.
 * Unauthenticated on purpose (no secrets, no user data). Returns 503 when the
 * data dir is not writable or ffmpeg is missing — S3 being down only flags
 * `degraded` (uploads/scans keep working from the local disk).
 */
export async function GET() {
  bootWorkDirs()
  const pool = poolSnapshot()
  const disk = diskFree()
  const mem = { total: os.totalmem(), free: os.freemem() }

  let tmpfs: { total: number; free: number } | null = null
  try {
    const st = fs.statfsSync(WORK_DIR)
    tmpfs = { total: Number(st.blocks) * Number(st.bsize), free: Number(st.bavail) * Number(st.bsize) }
  } catch {
    tmpfs = null
  }

  let dataWritable = true
  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK)
  } catch {
    dataWritable = false
  }

  let ffmpeg: string | null = null
  try {
    ffmpeg = getFfmpegPathSync()
  } catch {
    ffmpeg = null
  }

  const s3 = storageEnabled() ? await storageHealthy() : { ok: false, error: 'S3_BUCKET not set' }
  const ok = dataWritable && ffmpeg !== null
  const status = !ok ? 'error' : s3.ok ? 'ok' : 'degraded'

  return NextResponse.json(
    {
      status,
      uptimeSec: Math.round(process.uptime()),
      cpu: { cores: pool.cores, engines: pool.engines },
      ffmpeg: { bin: ffmpeg, active: pool.active, queued: pool.queued, jobs: pool.jobs },
      ram: { totalBytes: mem.total, freeBytes: mem.free, processRssBytes: process.memoryUsage().rss },
      work: {
        dir: WORK_DIR,
        usedBytes: ramWorkUsed(),
        budgetBytes: WORK_RAM_BUDGET_BYTES,
        tmpfs,
      },
      disk: { dir: DATA_DIR, writable: dataWritable, freeBytes: disk.free, totalBytes: disk.total },
      s3: { enabled: storageEnabled(), reachable: s3.ok, error: s3.ok ? undefined : s3.error },
      limits: { maxScans: MAX_SCANS },
    },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
