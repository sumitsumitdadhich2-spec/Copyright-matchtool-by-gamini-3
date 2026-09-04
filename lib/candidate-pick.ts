import type { CandidateEntry, CandidateGroup, ChunkMatch, Scan } from './types'

// ---------------------------------------------------------------------------
// CANDIDATE PICK — user choice of the main clip for one short window.
//
// Pure helpers shared by the scheduler (server), the pick API route (server)
// and the preview/compare panels (client). No fs / no side effects.
// ---------------------------------------------------------------------------

/** Two short-video ranges are "the same segment" when they overlap ≥50% of the shorter one. */
export function sameShortSegment(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
  if (overlap <= 0) return false
  const shorter = Math.min(aEnd - aStart, bEnd - bStart)
  return shorter <= 0 ? false : overlap / shorter >= 0.5
}

/** Rewrite scan.matches for ONE candidate group.
 *
 *  USER PICK wins: one verified match built from the picked candidate window
 *  (rescan window when viaRescan) — even if the AI rejected / never verified it.
 *  Otherwise the AI verdict:
 *   confirmed  → ONE verified match (rescan window when confirmedViaRescan)
 *   rejected   → all this group's matches removed
 *   unverified → original candidate windows kept, flagged verified=false
 *   pending / verifying / rescanning → group not decided yet: matches untouched
 *     (the raw chunk matches stay in place until the verifier finishes). */
export function applyGroupMatches(scan: Scan, g: CandidateGroup): void {
  const pick = g.userPick
  const picked = pick ? g.candidates[pick.index] : undefined
  const undecided = g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning'
  if (!picked && undecided) return

  scan.matches = (scan.matches || []).filter((m) => !sameShortSegment(g.shortStart, g.shortEnd, m.shortStart, m.shortEnd))

  if (picked && pick) {
    const useRescan = pick.viaRescan && picked.rescanMovieStart != null && picked.rescanMovieEnd != null
    scan.matches.push({
      shortStart: g.shortStart,
      shortEnd: g.shortEnd,
      movieStart: useRescan ? picked.rescanMovieStart! : picked.movieStart,
      movieEnd: useRescan ? picked.rescanMovieEnd! : picked.movieEnd,
      chunkIndex: picked.chunkIndex,
      model: picked.model,
      verified: true,
      viaRescan: useRescan || undefined,
      userPick: true,
    })
  } else if (g.status === 'confirmed' && g.confirmedIndex !== null) {
    const c = g.candidates[g.confirmedIndex]
    scan.matches.push({
      shortStart: g.shortStart,
      shortEnd: g.shortEnd,
      movieStart: g.confirmedViaRescan ? c.rescanMovieStart! : c.movieStart,
      movieEnd: g.confirmedViaRescan ? c.rescanMovieEnd! : c.movieEnd,
      chunkIndex: c.chunkIndex,
      model: c.model,
      verified: true,
      viaRescan: g.confirmedViaRescan || undefined,
    })
  } else if (g.status === 'unverified') {
    for (const c of g.candidates) {
      scan.matches.push({
        shortStart: g.shortStart,
        shortEnd: g.shortEnd,
        movieStart: c.movieStart,
        movieEnd: c.movieEnd,
        chunkIndex: c.chunkIndex,
        model: c.model,
        verified: false,
      })
    }
  }
  scan.matches.sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
}

// ---------- Client-side option list for the preview / compare panels ----------

export type CandidateOptionState = 'main' | 'confirmed' | 'rejected' | 'unverified' | 'pending' | 'checking'

/** One selectable movie window for a short clip (a candidate, or its rescan window). */
export interface CandidateOption {
  groupId: string
  groupStatus: CandidateGroup['status']
  /** index into group.candidates[] */
  index: number
  viaRescan: boolean
  /** short window of the OWNING group (ABSOLUTE short seconds) */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE movie seconds */
  movieStart: number
  movieEnd: number
  chunkIndex: number
  model: string
  /** what the AI decided about this exact window */
  state: CandidateOptionState
  /** this window is the current main clip (AI confirmed or user pick) */
  isMain: boolean
  /** this window is the user's explicit pick */
  isUserPick: boolean
}

function windowState(c: CandidateEntry, g: CandidateGroup, index: number, viaRescan: boolean): CandidateOptionState {
  if (g.status === 'confirmed' && g.confirmedIndex === index && g.confirmedViaRescan === viaRescan) return 'confirmed'
  const verdict = viaRescan ? c.rescanVerdict : c.verdict
  if (verdict === 'same') return 'confirmed'
  if (verdict === 'different') return 'rejected'
  if (verdict === 'verifying' || (!viaRescan && c.rescan === 'rescanning')) return 'checking'
  if (g.status === 'rejected') return 'rejected'
  if (g.status === 'unverified' || verdict === 'error') return 'unverified'
  return 'pending'
}

function nearlySame(a: number, b: number) {
  return Math.abs(a - b) <= 0.05
}

/** All candidate windows whose group covers the given short window (the clip
 *  currently shown in the preview / compare). Rescan-found windows count as
 *  their own option. Every group state is included — confirmed, unverified,
 *  rejected and not-yet-checked — the choice belongs to the user. */
export function candidateOptionsFor(scan: Pick<Scan, 'matches' | 'candidateGroups'>, shortStart: number, shortEnd: number): CandidateOption[] {
  const groups = (scan.candidateGroups || []).filter((g) => {
    const overlap = Math.min(g.shortEnd, shortEnd) - Math.max(g.shortStart, shortStart)
    return overlap > 0.05
  })
  const mains = (scan.matches || []).filter((m) => Math.min(m.shortEnd, shortEnd) - Math.max(m.shortStart, shortStart) > 0.05)
  const out: CandidateOption[] = []
  for (const g of groups) {
    g.candidates.forEach((c, index) => {
      const push = (viaRescan: boolean, ms: number, me: number) => {
        const isMain = mains.some((m) => nearlySame(m.movieStart, ms) && nearlySame(m.movieEnd, me))
        const isUserPick = !!g.userPick && g.userPick.index === index && g.userPick.viaRescan === viaRescan
        out.push({
          groupId: g.id,
          groupStatus: g.status,
          index,
          viaRescan,
          shortStart: g.shortStart,
          shortEnd: g.shortEnd,
          movieStart: ms,
          movieEnd: me,
          chunkIndex: c.chunkIndex,
          model: c.model,
          state: isMain ? 'main' : windowState(c, g, index, viaRescan),
          isMain,
          isUserPick,
        })
      }
      push(false, c.movieStart, c.movieEnd)
      if (c.rescan === 'found' && c.rescanMovieStart != null && c.rescanMovieEnd != null) {
        push(true, c.rescanMovieStart, c.rescanMovieEnd)
      }
    })
  }
  // De-duplicate identical windows (adjacent chunks often report the same window).
  const seen = new Set<string>()
  return out
    .filter((o) => {
      const k = `${o.movieStart.toFixed(2)}-${o.movieEnd.toFixed(2)}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.shortStart - b.shortStart || a.movieStart - b.movieStart)
}

/** A clip "has candidates" when at least one alternative window exists besides its current main. */
export function hasAlternatives(options: CandidateOption[]): boolean {
  return options.some((o) => !o.isMain)
}

/** Does the given match come from a user pick? (helper for badges) */
export function isUserPicked(m: ChunkMatch): boolean {
  return m.userPick === true
}
