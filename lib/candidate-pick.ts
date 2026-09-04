import type { CandidateEntry, CandidateGroup, ChunkMatch, MatchOrigin, Scan } from './types'

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

/** Provenance of a match produced from group `g`. A rescan-found window is
 *  'rescan' — unless the group itself came from the gap-backup pass, whose
 *  origin is the more useful thing to know downstream. */
export function groupMatchOrigin(g: CandidateGroup, viaRescan: boolean): MatchOrigin {
  const base = g.origin ?? 'chunk'
  if (viaRescan && base !== 'gap-backup') return 'rescan'
  return base
}

/** Human label for logs: "[origin: chunk scan #12]" / "[origin: rescan]" /
 *  "[origin: gap backup window #7]" / "[origin: user pick]". */
export function originTag(origin: MatchOrigin | undefined, chunkIndex?: number, originWindow?: number): string {
  switch (origin) {
    case 'rescan':
      return '[origin: rescan]'
    case 'gap-backup':
      return `[origin: gap backup${originWindow !== undefined ? ` window #${originWindow}` : ''}]`
    case 'user':
      return '[origin: user pick]'
    default:
      return `[origin: chunk scan${chunkIndex !== undefined ? ` #${chunkIndex}` : ''}]`
  }
}

/** REJECTED — KEPT: the best candidate window of a rejected group. Prefer the
 *  most recent rescan-found window (the rescan had the whole chunk to look at),
 *  otherwise the first (highest-ranked) original candidate. */
export function bestRejectedCandidate(g: CandidateGroup): { c: CandidateEntry; index: number; viaRescan: boolean } | null {
  if (g.candidates.length === 0) return null
  for (let i = g.candidates.length - 1; i >= 0; i--) {
    const c = g.candidates[i]
    if (c.rescan === 'found' && c.rescanMovieStart != null && c.rescanMovieEnd != null && c.rescanMovieEnd > c.rescanMovieStart) {
      return { c, index: i, viaRescan: true }
    }
  }
  return { c: g.candidates[0], index: 0, viaRescan: false }
}

/** Rewrite scan.matches for ONE candidate group.
 *
 *  USER PICK wins: one verified match built from the picked candidate window
 *  (rescan window when viaRescan) — even if the AI rejected / never verified it.
 *  Otherwise the AI verdict:
 *   confirmed  → ONE verified match (rescan window when confirmedViaRescan)
 *   rejected   → best candidate KEPT, flagged rejected=true, verified=false
 *                ("almost right" beats a hole in the merge). Superseded groups
 *                (a confirmed group already owns the window) push nothing.
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
      origin: 'user',
      originWindow: g.originWindow,
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
      origin: groupMatchOrigin(g, g.confirmedViaRescan),
      originWindow: g.originWindow,
    })
  } else if (g.status === 'rejected' && !g.superseded) {
    const best = bestRejectedCandidate(g)
    if (best) {
      scan.matches.push({
        shortStart: g.shortStart,
        shortEnd: g.shortEnd,
        movieStart: best.viaRescan ? best.c.rescanMovieStart! : best.c.movieStart,
        movieEnd: best.viaRescan ? best.c.rescanMovieEnd! : best.c.movieEnd,
        chunkIndex: best.c.chunkIndex,
        model: best.c.model,
        verified: false,
        rejected: true,
        viaRescan: best.viaRescan || undefined,
        origin: groupMatchOrigin(g, best.viaRescan),
        originWindow: g.originWindow,
      })
    }
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
        origin: groupMatchOrigin(g, false),
        originWindow: g.originWindow,
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
  /** main clip of a REJECTED group kept in the merge (no user pick) — red badge */
  rejectedKept: boolean
  /** provenance of this window */
  origin: MatchOrigin
  originWindow?: number
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
        const mainMatch = mains.find((m) => nearlySame(m.movieStart, ms) && nearlySame(m.movieEnd, me))
        const isMain = mainMatch !== undefined
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
          rejectedKept: isMain && !isUserPick && (mainMatch?.rejected === true || g.status === 'rejected'),
          origin: mainMatch?.origin ?? groupMatchOrigin(g, viaRescan),
          originWindow: g.originWindow,
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

/** Is this match a REJECTED group's best candidate kept in the merge? */
export function isRejectedKept(m: ChunkMatch): boolean {
  return m.rejected === true && m.userPick !== true
}

/** Short UI label for a provenance chip. */
export function originLabel(origin: MatchOrigin | undefined, originWindow?: number): string {
  switch (origin) {
    case 'rescan':
      return 'rescan'
    case 'gap-backup':
      return originWindow !== undefined ? `gap backup #${originWindow}` : 'gap backup'
    case 'user':
      return 'your pick'
    default:
      return 'chunk scan'
  }
}
