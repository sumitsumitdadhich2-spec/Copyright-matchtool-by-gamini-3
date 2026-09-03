'use client'

import { useEffect, useState } from 'react'
import type { Scan, ChunkState, ShortSegmentStatus } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-muted',
  scanning: 'bg-primary animate-pulse',
  no_match: 'bg-success/70',
  match: 'bg-destructive',
  failed: 'bg-amber-500/80',
  cancelled: 'bg-muted/50',
}

const SEG_STATUS_LABEL: Record<ShortSegmentStatus, string> = {
  pending: 'pending',
  scanning: 'scanning',
  verifying: 'verifying',
  done: 'done',
}

/** Pick the chunks to display for a given selected minute. The active minute is
 *  mirrored into scan.chunks (live states); other minutes come straight from
 *  shortSegments[i].chunks. */
function chunksForSegment(scan: Scan, segIdx: number): ChunkState[] {
  const segs = scan.shortSegments
  if (!segs || segs.length === 0) return scan.chunks
  if (segIdx === (scan.currentShortSegment ?? 0)) return scan.chunks
  const seg = segs[segIdx]
  if (!seg) return scan.chunks
  if (seg.chunks.length > 0) return seg.chunks
  // Segment not started yet — synthesize pending placeholders so the grid stays stable.
  return Array.from({ length: scan.chunkCount }, (_, i) => ({ index: i, status: 'pending' as const, attempts: 0 }))
}

export function ScanTimeline({ scan }: { scan: Scan }) {
  const segs = scan.shortSegments || []
  const multi = segs.length > 1
  const [selected, setSelected] = useState<number | null>(null)
  // Default: follow the running minute until the user picks one explicitly.
  const activeSeg = scan.currentShortSegment ?? 0
  const segIdx = selected ?? activeSeg

  // Clear a stale manual selection when switching scans / segment count changes.
  useEffect(() => {
    setSelected(null)
  }, [scan.id, segs.length])

  if (scan.chunkCount === 0) {
    return (
      <section aria-label="Scan timeline" className="panel">
        <h2 className="text-sm font-semibold">Scan Timeline</h2>
        <p className="mt-2 text-xs text-muted-foreground">Upload a movie to see the minute-by-minute timeline.</p>
      </section>
    )
  }

  const chunks = chunksForSegment(scan, segIdx)
  const done = chunks.filter((c) => c.status === 'match' || c.status === 'no_match').length

  return (
    <section aria-label="Scan timeline" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Scan Timeline</h2>
        {multi && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary">
            short minute {segIdx + 1}/{segs.length}
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {done}/{scan.chunkCount} chunks
        </span>
      </div>

      {multi && (
        <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label="Short video minutes">
          {segs.map((seg) => {
            const isSel = seg.index === segIdx
            const isActive = seg.index === activeSeg
            return (
              <button
                key={seg.index}
                type="button"
                role="tab"
                aria-selected={isSel}
                onClick={() => setSelected(seg.index === activeSeg ? null : seg.index)}
                title={`Short ${fmtTime(seg.start)}–${fmtTime(seg.end)} — ${SEG_STATUS_LABEL[seg.status]}`}
                className={`btn-press flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[10px] ${
                  isSel
                    ? 'border-primary bg-primary/15 text-primary shadow-sm shadow-primary/20'
                    : 'border-input text-muted-foreground hover:border-primary/40 hover:bg-secondary'
                }`}
              >
                Min {seg.index + 1}
                {seg.status === 'done' && <span className="text-success" aria-hidden>✓</span>}
                {(seg.status === 'scanning' || seg.status === 'verifying') && (
                  <span className="inline-block size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
                )}
                {isActive && seg.status !== 'done' && <span className="sr-only">(current)</span>}
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1" role="list" aria-label="Movie minute blocks">
        {chunks.map((c) => (
          <div
            key={c.index}
            role="listitem"
            title={`Minute ${c.index} (${fmtTime(c.index * 60)}–${fmtTime((c.index + 1) * 60)}) — ${c.status}${c.model ? ` · ${displayModelName(c.model)}` : ''}${
              c.confidence !== undefined ? ` · conf ${c.confidence}` : ''
            }`}
            className={`h-5 w-5 rounded-sm ${STATUS_CLASS[c.status] || 'bg-muted'} transition-all duration-300 hover:scale-125 hover:ring-2 hover:ring-primary/50`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <LegendDot cls="bg-muted" label="pending" />
        <LegendDot cls="bg-primary" label="scanning" />
        <LegendDot cls="bg-success/70" label="no match" />
        <LegendDot cls="bg-destructive" label="match" />
        <LegendDot cls="bg-amber-500/80" label="failed" />
        <LegendDot cls="bg-muted/50" label="cancelled" />
      </div>
    </section>
  )
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${cls}`} aria-hidden />
      {label}
    </span>
  )
}
