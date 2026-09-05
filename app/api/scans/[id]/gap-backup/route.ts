import { NextResponse } from 'next/server'
import { getFreshScan } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys } from '@/lib/user-keys'
import { gapBackupPreview, gapBackupRunning, startGapBackup } from '@/lib/gap-backup'

export const runtime = 'nodejs'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  const preview = gapBackupPreview(scan)
  return NextResponse.json({ ...preview, running: gapBackupRunning(id) })
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await ctx.params
  const keys = await getAllUserApiKeys(session.username)
  const result = startGapBackup(id, keys)
  return NextResponse.json(result, { status: result.ok ? 200 : 409 })
}
