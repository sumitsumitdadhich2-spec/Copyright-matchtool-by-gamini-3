'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SplitSquareHorizontal } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'
import { candidateOptionsFor, hasAlternatives } from '@/lib/candidate-pick'
import { CandidateChooser } from './candidate-chooser'

/** Side-by-side preview of matched windows: each parsed "Short X --> Movie Y" line
 *  is one pair with (near-)equal durations on both sides.
 *
 *  CANDIDATES: when the short window of a pair has alternative movie windows
 *  (other candidates of its group — confirmed, unverified, rejected or not yet
 *  checked), extra Prev/Next-candidate buttons appear. Browsing swaps ONLY the
 *  movie side so the user compares each candidate against the same short clip,
 *  and "Make this the main clip" turns that candidate into the pair used by the
 *  stitched preview and the export. */
export function ComparePanel({ scan }: { scan: Scan }) {
  const pairs = scan.matches || []
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  // null = the pair's own movie window; a number = options[candIdx] on the movie side
  const [candIdx, setCandIdx] = useState<number | null>(null)
  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)

  const pair = pairs[Math.min(idx, pairs.length - 1)]
  const options = useMemo(
    () => (pair ? candidateOptionsFor(scan, pair.shortStart, pair.shortEnd) : []),
    [scan, pair?.shortStart, pair?.shortEnd], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const showChooser = hasAlternatives(options)
  const viewing = candIdx === null ? null : options[Math.min(candIdx, options.length - 1)]
  // Movie-side window actually shown (candidate or the pair's own window).
  const movieStart = viewing ? viewing.movieStart : pair?.movieStart ?? 0
  const movieEnd = viewing ? viewing.movieEnd : pair?.movieEnd ?? 0

  // Keep index in range when pairs change between refreshes.
  useEffect(() => {
    if (idx > 0 && idx >= pairs.length) setIdx(Math.max(0, pairs.length - 1))
  }, [idx, pairs.length])

  // Leaving a pair always returns to its main window.
  useEffect(() => {
    setCandIdx(null)
  }, [idx, pair?.shortStart])

  // Seek both players to the window start whenever the shown windows change.
  useEffect(() => {
    if (!pair) return
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) {
      sv.pause()
      sv.currentTime = pair.shortStart
    }
    if (mv) {
      mv.pause()
      mv.currentTime = movieStart
    }
    setPlaying(false)
  }, [pair?.shortStart, movieStart]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!pair) return null

  function clampLoop(video: HTMLVideoElement | null, start: number, end: number) {
    if (!video) return
    if (video.currentTime >= end || video.currentTime < start - 0.25) {
      video.currentTime = start
      video.pause()
      setPlaying(false)
    }
  }

  function togglePlay() {
    const sv = shortRef.current
    const mv = movieRef.current
    if (!sv || !mv) return
    if (playing) {
      sv.pause()
      mv.pause()
      setPlaying(false)
    } else {
      // Re-align both to the window start if either has drifted past the end.
      if (sv.currentTime >= pair!.shortEnd - 0.05) sv.currentTime = pair!.shortStart
      if (mv.currentTime >= movieEnd - 0.05) mv.currentTime = movieStart
      void sv.play()
      void mv.play()
      setPlaying(true)
    }
  }

  function restart() {
    const sv = shortRef.current
    const mv = movieRef.current
    if (sv) sv.currentTime = pair!.shortStart
    if (mv) mv.currentTime = movieStart
  }

  const src = (kind: 'short' | 'movie') => `/api/scans/${scan.id}/media?kind=${kind}`
  const duration = pair.shortEnd - pair.shortStart

  return (
    <section aria-label="Side-by-side comparison" className="panel">
      <div className="flex flex-wrap items-center gap-2">
        <SplitSquareHorizontal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Side-by-Side Match Comparison</h2>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          match {idx + 1} / {pairs.length}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">{duration.toFixed(3)}s</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">chunk {viewing ? viewing.chunkIndex : pair.chunkIndex}</span>
        {showChooser && (
          <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-xs text-primary">{options.length} candidates</span>
        )}
        {pair.userPick && !viewing && (
          <span className="rounded-full bg-success/15 px-2 py-0.5 font-mono text-xs text-success">your choice</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIdx((i) => Math.max(0, i - 1))}
            disabled={idx === 0}
            className="flex items-center gap-1 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Previous
          </button>
          <button
            type="button"
            onClick={() => setIdx((i) => Math.min(pairs.length - 1, i + 1))}
            disabled={idx >= pairs.length - 1}
            className="flex items-center gap-1 rounded-md border border-input px-3 py-1.5 text-xs font-medium hover:bg-secondary disabled:opacity-40"
          >
            Next <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium">Short video</span>
            <span className="font-mono text-muted-foreground">
              {fmtTime(pair.shortStart)} – {fmtTime(pair.shortEnd)}
            </span>
          </figcaption>
          <video
            ref={shortRef}
            src={src('short')}
            preload="metadata"
            muted
            playsInline
            onTimeUpdate={() => clampLoop(shortRef.current, pair.shortStart, pair.shortEnd)}
            className="aspect-video w-full rounded-md border border-border bg-black object-contain"
          />
        </figure>
        <figure className="flex flex-col gap-1.5">
          <figcaption className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between">
            <span className="font-medium">{viewing ? 'Movie — candidate' : 'Movie'}</span>
            <span className="font-mono text-muted-foreground">
              {fmtTime(movieStart)} – {fmtTime(movieEnd)}
            </span>
          </figcaption>
          <video
            ref={movieRef}
            src={src('movie')}
            preload="metadata"
            muted
            playsInline
            onTimeUpdate={() => clampLoop(movieRef.current, movieStart, movieEnd)}
            className={`aspect-video w-full rounded-md border bg-black object-contain ${viewing ? 'border-primary' : 'border-border'}`}
          />
        </figure>
      </div>

      {showChooser && (
        <div className="mt-3">
          <CandidateChooser scan={scan} options={options} viewIdx={candIdx} onView={setCandIdx} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={togglePlay}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
        >
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>
        <button
          type="button"
          onClick={restart}
          className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"
        >
          <RotateCcw className="size-3.5" aria-hidden /> Restart match
        </button>
        <span className="ml-auto rounded-full bg-secondary px-2 py-0.5 font-mono text-xs">
          {displayModelName(viewing ? viewing.model : pair.model)}
        </span>
      </div>
    </section>
  )
}
