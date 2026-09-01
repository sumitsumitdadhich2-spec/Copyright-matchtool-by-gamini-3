import { NextResponse } from 'next/server'
import { getFreshScan, saveScan, addLog } from '@/lib/store'
import { getSession } from '@/lib/users'
import { getAllUserApiKeys, getUserTwelveLabsKey } from '@/lib/user-keys'
import { deductTokens, refundTokens, SCAN_TOKEN_COST } from '@/lib/tokens'
import { scheduler } from '@/lib/scheduler'

export const runtime = 'nodejs'

/**
 * POST { minutes: number[] } — user approves which MOVIE minutes to check
 * (subset of the Pegasus segment_4 suggestions). Sets per-short-minute
 * selection + movie search ranges, then auto-starts the Gemini scan
 * (existing pipeline — prompts/verifier/candidates untouched).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await ctx.params
  const scan = await getFreshScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })

  const pipeline = scan.mergePipeline
  if (!pipeline || pipeline.status !== 'awaiting_approval' || !pipeline.minuteSuggestions?.length) {
    return NextResponse.json({ error: 'Minute list ready nahi hai — pehle pipeline complete hone do.' }, { status: 400 })
  }
  if (scheduler.isRunning(id)) {
    return NextResponse.json({ error: 'Scan already running' }, { status: 409 })
  }

  const body = (await req.json().catch(() => ({}))) as { minutes?: number[] }
  const requested = Array.isArray(body.minutes) ? body.minutes.filter((n) => Number.isInteger(n) && n >= 0) : []
  const suggestedSet = new Set(pipeline.minuteSuggestions.map((s) => s.minute))
  const approved = requested.filter((m) => suggestedSet.has(m))
  if (approved.length === 0) {
    return NextResponse.json({ error: 'Kam se kam ek suggested minute approve karo.' }, { status: 400 })
  }
  const approvedSet = new Set(approved)

  const segs = scan.shortSegments
  if (!segs || segs.length === 0) {
    return NextResponse.json({ error: 'Short video segments missing' }, { status: 400 })
  }

  // Map approved MOVIE minutes back to each SHORT minute via segment_4's
  // PART A windows. A short minute is scanned only against the approved
  // movie minutes its scenes pointed at (existing per-minute range system).
  const trimStart = scan.movieTrimStart ?? 0
  const trimEnd = scan.movieTrimEnd ?? scan.movieDuration ?? 0
  const rangeNotes: string[] = []
  for (const seg of segs) {
    const relevantMinutes: number[] = []
    for (const sug of pipeline.minuteSuggestions) {
      if (!approvedSet.has(sug.minute)) continue
      const overlaps = sug.shortWindows.some((w) => w.start < seg.end && w.end > seg.start)
      if (overlaps) relevantMinutes.push(sug.minute)
    }
    if (relevantMinutes.length === 0) {
      seg.selected = false
      delete seg.movieRangeStart
      delete seg.movieRangeEnd
      continue
    }
    seg.selected = true
    // Range = min..max of approved minutes for this short minute, clamped to trim.
    const rawStart = Math.min(...relevantMinutes) * 60
    const rawEnd = (Math.max(...relevantMinutes) + 1) * 60
    const start = Math.max(trimStart, rawStart)
    const end = Math.min(trimEnd, rawEnd)
    if (end > start && !(start <= trimStart && end >= trimEnd)) {
      seg.movieRangeStart = start
      seg.movieRangeEnd = end
      rangeNotes.push(`minute ${seg.index + 1} → movie ${Math.round(start)}s–${Math.round(end)}s`)
    } else {
      delete seg.movieRangeStart
      delete seg.movieRangeEnd
    }
  }

  if (!segs.some((s) => s.selected !== false)) {
    return NextResponse.json(
      { error: 'Approved minutes kisi short minute se map nahi hue — Retry ya manual Full scan use karo.' },
      { status: 400 },
    )
  }

  scan.mergePipeline = { ...pipeline, status: 'approved', approvedMinutes: approved.sort((a, b) => a - b) }
  addLog(
    scan,
    'success',
    `Minute list approved: movie minute(s) ${approved
      .sort((a, b) => a - b)
      .map((m) => m + 1)
      .join(', ')} — Gemini scan start ho raha hai`,
  )
  if (rangeNotes.length > 0) {
    addLog(scan, 'info', `Per-minute movie ranges (Pegasus segment_4 se): ${rangeNotes.join('; ')}`)
  }
  saveScan(scan, { immediate: true })

  // ---- Auto-start the Gemini scan (mirrors POST /start) ----
  const userApiKeys = await getAllUserApiKeys(session.username)
  if (userApiKeys.length === 0) {
    return NextResponse.json(
      { error: 'Approved! Lekin Gemini API key nahi hai — Settings me key add karke Start dabao.' },
      { status: 400 },
    )
  }
  let charged = false
  if (session.role !== 'admin') {
    const newBalance = await deductTokens(session.username, SCAN_TOKEN_COST)
    if (newBalance === null) {
      return NextResponse.json(
        { error: `Tokens khatm ho gaye hain! 1 scan = ${SCAN_TOKEN_COST} tokens. Admin se tokens lo.`, tokensExhausted: true },
        { status: 402 },
      )
    }
    charged = true
  }
  const tlApiKey = await getUserTwelveLabsKey(session.username)
  const result = await scheduler.start(id, false, userApiKeys, tlApiKey)
  if (!result.ok) {
    if (charged) await refundTokens(session.username, SCAN_TOKEN_COST)
    return NextResponse.json({ error: result.error }, { status: 400 })
  }
  return NextResponse.json({ ok: true, approved: approved.map((m) => m + 1) })
}
