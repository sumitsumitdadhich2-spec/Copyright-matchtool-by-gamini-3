import { NextResponse } from 'next/server'
import { getScan, saveScan, addLog } from '@/lib/store'
import { scheduler } from '@/lib/scheduler'
import { applyGroupMatches } from '@/lib/candidate-pick'
import { fmtTime } from '@/lib/format'

export const runtime = 'nodejs'

/** USER CHOICE: make one candidate window the MAIN clip for its short window.
 *
 *  Body: { groupId, candidateIndex, viaRescan? }  → pick that candidate
 *        { groupId, candidateIndex: null }         → clear the pick (back to AI verdict)
 *
 *  Rewrites scan.matches for that group only, so the stitched preview, the
 *  side-by-side compare and the export (all built from scan.matches) update
 *  together. Works for confirmed, unverified, rejected AND not-yet-checked
 *  groups — the choice is the user's. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const scan = getScan(id)
  if (!scan) return NextResponse.json({ error: 'Scan not found' }, { status: 404 })
  // The running scheduler owns the in-memory scan and would overwrite a file
  // edit on its next save — ask for Stop first.
  if (scheduler.isRunning(id) || scan.status === 'scanning' || scan.status === 'verifying') {
    return NextResponse.json({ error: 'Scan chal raha hai — candidate choose karne se pehle Stop karo' }, { status: 409 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    groupId?: string
    candidateIndex?: number | null
    viaRescan?: boolean
  }
  const g = (scan.candidateGroups || []).find((x) => x.id === body.groupId)
  if (!g) return NextResponse.json({ error: 'Candidate group not found' }, { status: 404 })

  if (body.candidateIndex === null) {
    delete g.userPick
    applyGroupMatches(scan, g)
    addLog(scan, 'info', `User choice cleared for short ${fmtTime(g.shortStart)}–${fmtTime(g.shortEnd)} — AI verdict (${g.status}) restored`)
  } else {
    const idx = Number(body.candidateIndex)
    if (!Number.isInteger(idx) || idx < 0 || idx >= g.candidates.length) {
      return NextResponse.json({ error: 'Invalid candidate index' }, { status: 400 })
    }
    const c = g.candidates[idx]
    const viaRescan = body.viaRescan === true
    if (viaRescan && (c.rescanMovieStart == null || c.rescanMovieEnd == null)) {
      return NextResponse.json({ error: 'This candidate has no rescan window' }, { status: 400 })
    }
    g.userPick = { index: idx, viaRescan, at: Date.now() }
    applyGroupMatches(scan, g)
    const ms = viaRescan ? c.rescanMovieStart! : c.movieStart
    const me = viaRescan ? c.rescanMovieEnd! : c.movieEnd
    addLog(
      scan,
      'success',
      `USER CHOICE: short ${fmtTime(g.shortStart)}–${fmtTime(g.shortEnd)} → movie ${fmtTime(ms)}–${fmtTime(me)} (candidate #${idx + 1}${viaRescan ? ', rescan window' : ''}, chunk ${c.chunkIndex}) set as MAIN clip — AI verdict was ${g.status}. Preview + export updated.`,
    )
  }

  // Keep the frozen report in sync so the report tab matches preview/export.
  if (scan.report) scan.report.matches = scan.matches
  saveScan(scan, { immediate: true })
  return NextResponse.json({ ok: true, matches: scan.matches.length })
}
