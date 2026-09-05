'use client'

import { useRef, useState } from 'react'
import { Target, Play, ShieldCheck, ShieldX, ShieldQuestion, RefreshCw, Loader2 } from 'lucide-react'
import type { Scan, CandidateGroup, CandidateEntry } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { originLabel } from '@/lib/candidate-pick'

const GROUP_BADGE: Record<CandidateGroup['status'], { label: string; cls: string }> = {
  pending: { label: 'Pending verify', cls: 'bg-muted text-muted-foreground' },
  verifying: { label: 'Verifying 24fps', cls: 'bg-primary/15 text-primary' },
  rescanning: { label: 'Rescanning', cls: 'bg-warning/15 text-warning' },
  confirmed: { label: 'Confirmed', cls: 'bg-success/15 text-success' },
  rejected: { label: 'Rejected (final)', cls: 'bg-destructive/15 text-destructive' },
  unverified: { label: 'Unverified', cls: 'bg-warning/15 text-warning' },
}

export function CandidatesPanel({ scan }: { scan: Scan }) {
  const groups = scan.candidateGroups ?? []
  const totalCandidates = groups.reduce((n, g) => n + g.candidates.length, 0)

  return (
    <section aria-label="Match candidates" className="panel">
      <div className="flex items-center gap-2">
        <Target className="size-4 text-destructive" aria-hidden />
        <h2 className="text-sm font-semibold">Match Candidates</h2>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {groups.length} group{groups.length === 1 ? '' : 's'} · {totalCandidates} candidate{totalCandidates === 1 ? '' : 's'}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          When two or more chunks report the same short-video segment, every distinct movie window is saved here as a candidate. Each one goes through the 24fps verifier, and failed candidates trigger a full-chunk rescan.
        </p>
      ) : (
        <div className="mt-3 grid gap-3">
          {[...groups]
            .sort((a, b) => a.shortStart - b.shortStart)
            .map((g) => (
              <GroupCard key={g.id} scan={scan} g={g} />
            ))}
        </div>
      )}
    </section>
  )
}

function GroupCard({ scan, g }: { scan: Scan; g: CandidateGroup }) {
  const badge = GROUP_BADGE[g.status]
  const busy = g.status === 'verifying' || g.status === 'rescanning'
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">
          Short {fmtTime(g.shortStart)} – {fmtTime(g.shortEnd)}
        </span>
        <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs ${badge.cls}`}>
          {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
          {badge.label}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">{originLabel(g.origin, g.originWindow)}</span>
      </div>
      <div className="mt-2 grid gap-2">
        {g.candidates.map((c, i) => (
          <CandidateRow key={i} scan={scan} g={g} c={c} index={i} />
        ))}
      </div>
    </div>
  )
}

function verdictBadge(c: CandidateEntry, g: CandidateGroup, index: number) {
  const isWinner = g.status === 'confirmed' && g.confirmedIndex === index
  if (isWinner) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">
        <ShieldCheck className="size-3" aria-hidden />
        {g.confirmedViaRescan ? 'SAME (via rescan)' : 'SAME'}
      </span>
    )
  }
  if (c.verdict === 'verifying' || c.rescanVerdict === 'verifying' || c.rescan === 'rescanning') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 font-mono text-xs text-primary">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        checking
      </span>
    )
  }
  if (c.verdict === 'different') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-xs text-destructive">
        <ShieldX className="size-3" aria-hidden />
        DIFFERENT
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
      <ShieldQuestion className="size-3" aria-hidden />
      pending
    </span>
  )
}

function CandidateRow({ scan, g, c, index }: { scan: Scan; g: CandidateGroup; c: CandidateEntry; index: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showVideo, setShowVideo] = useState(false)
  const previewStart = g.confirmedViaRescan && g.confirmedIndex === index && c.rescanMovieStart != null ? c.rescanMovieStart : c.movieStart

  function openPreview() {
    setShowVideo(true)
    requestAnimationFrame(() => {
      const v = videoRef.current
      if (!v) return
      const seek = () => {
        v.currentTime = previewStart
        void v.play().catch(() => {})
      }
      if (v.readyState >= 1) seek()
      else v.addEventListener('loadedmetadata', seek, { once: true })
    })
  }

  return (
    <div className="rounded-md border border-border/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold">
          #{index + 1} Movie {fmtTime(c.movieStart)} – {fmtTime(c.movieEnd)}
        </span>
        <span className="font-mono text-xs text-muted-foreground">chunk {c.chunkIndex}</span>
        <span className="ml-auto flex items-center gap-1">
          {g.status === 'rejected' && !g.superseded && index === 0 && <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-mono text-xs text-destructive">rejected kept</span>}
          {verdictBadge(c, g, index)}
        </span>
      </div>
      <div className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
        <span>
          Found by <span className="font-mono">{displayModelName(c.model)}</span>
          {c.verifierModel && (
            <>
              {' · verified by '}
              <span className="font-mono">{displayModelName(c.verifierModel)}</span>
            </>
          )}
        </span>
        {c.verifierReason && <span className="line-clamp-2 italic">{c.verifierReason}</span>}
        {c.rescan !== 'none' && c.rescan !== 'pending' && (
          <span className="flex items-center gap-1">
            <RefreshCw className="size-3 shrink-0" aria-hidden />
            {c.rescan === 'rescanning' && `Rescanning full chunk ${c.chunkIndex}...`}
            {c.rescan === 'not_found' && 'Rescan: segment NOT found in full chunk'}
            {c.rescan === 'found' && c.rescanMovieStart != null && (
              <>
                Rescan found {fmtTime(c.rescanMovieStart)} – {fmtTime(c.rescanMovieEnd ?? c.rescanMovieStart)}
                {c.rescanVerdict === 'same' && ' — verifier: SAME'}
                {c.rescanVerdict === 'different' && ' — verifier: DIFFERENT (final)'}
              </>
            )}
          </span>
        )}
        {c.rescanReason && <span className="line-clamp-2 italic">{c.rescanReason}</span>}
      </div>
      {showVideo ? (
        <video
          ref={videoRef}
          src={`/api/scans/${scan.id}/media?kind=movie`}
          controls
          className="mt-2 w-full rounded-md bg-black"
          aria-label={`Movie preview at ${fmtTime(previewStart)}`}
        />
      ) : (
        <button
          type="button"
          onClick={openPreview}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-input py-1.5 text-xs font-medium hover:bg-secondary"
        >
          <Play className="size-3.5" aria-hidden /> Preview at {fmtTime(previewStart)}
        </button>
      )}
    </div>
  )
}
