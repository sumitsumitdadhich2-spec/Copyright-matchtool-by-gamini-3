'use client'

import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Circle, Loader2, Pause, Play, RotateCcw, Search, Square, X } from 'lucide-react'
import type { GapBackupCandidate, GapBackupRequest, GapBackupState, Scan, ShortCoverage, ShortRange } from '@/lib/types'
import { fetcher, fmtDuration, fmtTime } from '@/lib/format'
import { displayModelName } from '@/lib/models'

interface GapResponse {
  coverage: ShortCoverage
  gaps: ShortRange[]
  state: GapBackupState
  running: boolean
}

const PHASES = [
  { key: 'cutting', label: 'Prepare clips' },
  { key: 'uploading', label: 'Upload' },
  { key: 'searching', label: 'Chunk batches' },
  { key: 'awaiting_review', label: 'Review' },
  { key: 'done', label: 'Done' },
] as const

function requestTone(status: GapBackupRequest['status']) {
  if (status === 'done') return 'bg-success/15 text-success'
  if (status === 'failed') return 'bg-destructive/15 text-destructive'
  if (status === 'running' || status === 'uploading') return 'bg-primary/15 text-primary'
  return 'bg-muted text-muted-foreground'
}

function ReviewCandidate({ scanId, candidate, onReview }: { scanId: string; candidate: GapBackupCandidate; onReview: (id: string, action: 'accept' | 'reject') => void }) {
  const [busy, setBusy] = useState(false)
  const [playing, setPlaying] = useState(false)
  const shortRef = useRef<HTMLVideoElement>(null)
  const movieRef = useRef<HTMLVideoElement>(null)
  const shortSrc = `/api/scans/${scanId}/media?kind=short`
  const movieSrc = `/api/scans/${scanId}/media?kind=movie`
  const shortDuration = candidate.shortEnd - candidate.shortStart

  function pauseBoth(reset = false) {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    shortVideo?.pause()
    movieVideo?.pause()
    if (reset) {
      if (shortVideo) shortVideo.currentTime = candidate.shortStart
      if (movieVideo) movieVideo.currentTime = candidate.movieStart
    }
    setPlaying(false)
  }

  useEffect(() => {
    pauseBoth(true)
  }, [candidate.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function relativeTime(video: HTMLVideoElement, start: number) {
    return Math.max(0, video.currentTime - start)
  }

  function seekToSharedPosition() {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (!shortVideo || !movieVideo) return
    const shortPosition = relativeTime(shortVideo, candidate.shortStart)
    const moviePosition = relativeTime(movieVideo, candidate.movieStart)
    const shortInRange = shortVideo.currentTime >= candidate.shortStart - 0.05 && shortVideo.currentTime < candidate.shortEnd - 0.05
    const movieInRange = movieVideo.currentTime >= candidate.movieStart - 0.05 && movieVideo.currentTime < candidate.movieEnd - 0.05
    const sharedPosition = shortInRange && movieInRange ? Math.min(shortPosition, moviePosition, shortDuration) : 0
    shortVideo.currentTime = candidate.shortStart + sharedPosition
    movieVideo.currentTime = candidate.movieStart + sharedPosition
  }

  async function togglePlay() {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (!shortVideo || !movieVideo) return
    if (playing) {
      pauseBoth()
      return
    }
    seekToSharedPosition()
    try {
      await Promise.all([shortVideo.play(), movieVideo.play()])
      setPlaying(true)
    } catch {
      pauseBoth()
    }
  }

  function synchronizeFromShort() {
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (!shortVideo || !movieVideo) return
    const position = relativeTime(shortVideo, candidate.shortStart)
    if (shortVideo.currentTime >= candidate.shortEnd - 0.02 || position >= shortDuration - 0.02) {
      pauseBoth(true)
      return
    }
    const movieTarget = candidate.movieStart + position
    if (Math.abs(movieVideo.currentTime - movieTarget) > 0.12) movieVideo.currentTime = movieTarget
  }

  function handleNativePause() {
    if (!playing) return
    const shortVideo = shortRef.current
    const movieVideo = movieRef.current
    if (shortVideo && !shortVideo.paused) shortVideo.pause()
    if (movieVideo && !movieVideo.paused) movieVideo.pause()
    setPlaying(false)
  }

  async function review(action: 'accept' | 'reject') {
    pauseBoth()
    setBusy(true)
    await onReview(candidate.id, action)
    setBusy(false)
  }

  return (
    <article className="rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">Needs your review</span>
        <span className="font-mono text-[10px] text-muted-foreground">chunk {candidate.chunkIndex + 1} · {displayModelName(candidate.model)}</span>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium"><span>Short missing range</span><span className="font-mono text-muted-foreground">{fmtTime(candidate.shortStart)}–{fmtTime(candidate.shortEnd)}</span></div>
          <video ref={shortRef} preload="metadata" src={shortSrc} muted playsInline onLoadedMetadata={() => { if (shortRef.current) shortRef.current.currentTime = candidate.shortStart }} onTimeUpdate={synchronizeFromShort} onPause={handleNativePause} className="aspect-video w-full rounded-md bg-foreground/10 object-contain" aria-label="Short video missing range preview" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs font-medium"><span>Gemini movie candidate</span><span className="font-mono text-muted-foreground">{fmtTime(candidate.movieStart)}–{fmtTime(candidate.movieEnd)}</span></div>
          <video ref={movieRef} preload="metadata" src={movieSrc} muted playsInline onLoadedMetadata={() => { if (movieRef.current) movieRef.current.currentTime = candidate.movieStart }} onTimeUpdate={() => { if (movieRef.current && movieRef.current.currentTime >= candidate.movieEnd - 0.02) pauseBoth(true) }} onPause={handleNativePause} className="aspect-video w-full rounded-md bg-foreground/10 object-contain" aria-label="Movie candidate preview" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void togglePlay()} className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">
          {playing ? <Pause className="size-3.5" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          {playing ? 'Pause both' : 'Play both'}
        </button>
        <button type="button" onClick={() => pauseBoth(true)} className="flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs font-medium hover:bg-secondary"><RotateCcw className="size-3.5" aria-hidden /> Restart</button>
        <span className="text-xs text-muted-foreground">Synchronized from each range start</span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Gemini evidence:</span> {candidate.reason}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void review('accept')} disabled={busy} className="flex items-center gap-1.5 rounded-md bg-success px-3 py-2 text-xs font-medium text-success-foreground disabled:opacity-50"><Check className="size-3.5" aria-hidden /> Accept match</button>
        <button type="button" onClick={() => void review('reject')} disabled={busy} className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"><X className="size-3.5" aria-hidden /> Reject</button>
      </div>
    </article>
  )
}

function RequestRow({ request }: { request: GapBackupRequest }) {
  const shouldAutoOpen = request.status === 'uploading' || request.status === 'running' || request.status === 'failed'
  const [open, setOpen] = useState(shouldAutoOpen)
  useEffect(() => {
    if (shouldAutoOpen) setOpen(true)
    else if (request.status === 'done') setOpen(false)
  }, [request.status, shouldAutoOpen])
  const elapsed = request.finishedAt && request.startedAt ? fmtDuration(request.finishedAt - request.startedAt) : null
  return (
    <div className="rounded-md border border-border bg-background/60">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 p-2 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
        <span className="font-mono text-xs">Batch {request.batch} · chunk {request.chunkIndex + 1}</span>
        <span className="hidden text-[10px] text-muted-foreground sm:inline">{fmtTime(request.chunkStart)}–{fmtTime(request.chunkEnd)}</span>
        <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${requestTone(request.status)}`}>{request.status}</span>
      </button>
      {open && (
        <div className="border-t border-border p-3">
          <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
            <span className="rounded bg-muted px-2 py-1">{request.lane.replace(request.model, displayModelName(request.model))}</span>
            {typeof request.tokens === 'number' && <span className="rounded bg-muted px-2 py-1">{request.tokens.toLocaleString()} tokens</span>}
            {typeof request.matches === 'number' && <span className="rounded bg-muted px-2 py-1">{request.matches} strict match(es)</span>}
            {elapsed && <span className="rounded bg-muted px-2 py-1">{elapsed}</span>}
          </div>
          {request.error && <p role="alert" className="mt-2 text-xs text-destructive">{request.error}</p>}
          <div className="mt-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Raw Gemini reply</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-foreground p-3 font-mono text-[11px] leading-relaxed text-background">{request.raw || (request.status === 'running' ? 'Gemini response ka wait ho raha hai…' : 'Abhi raw reply available nahi hai.')}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

export function GapBackupPanel({ scan }: { scan: Scan }) {
  const { data, mutate } = useSWR<GapResponse>(`/api/scans/${scan.id}/gap-backup`, fetcher, { refreshInterval: 1200 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = data ?? { coverage: scan.report?.coverage, gaps: [], state: scan.gapBackup, running: false }
  const coverage = preview.coverage
  const fallbackState: GapBackupState = { status: 'idle', parts: [], minutes: [], requests: [], candidates: [], addedMatches: [] }
  const rawState = preview.state ?? fallbackState
  const state = Array.isArray(rawState.minutes) && Array.isArray(rawState.requests) ? rawState : fallbackState
  if (!coverage || (coverage.gaps.length === 0 && state.status === 'idle')) return null
  const running = Boolean(data?.running || ['cutting', 'uploading', 'searching'].includes(state.status))
  const currentPhase = PHASES.findIndex((phase) => phase.key === state.status)
  const pending = state.candidates.filter((candidate) => candidate.review === 'pending')
  const groupedRequests = state.minutes.map((minute) => ({ minute, requests: state.requests.filter((request) => request.minuteIndex === minute.index) }))

  async function action(actionName: 'start' | 'stop' | 'accept' | 'reject', candidateId?: string) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/scans/${scan.id}/gap-backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(actionName === 'start' ? {} : { action: actionName, candidateId }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) setError(body.error || 'Request complete nahi hui')
      await mutate()
    } catch {
      setError('Network request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Manual missing-scene finder" className="panel border-warning/40">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 text-warning" aria-hidden />
        <div>
          <h2 className="text-sm font-semibold">Manual missing-scene finder</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Initial minute finder se alag, transparent 24 fps search</p>
        </div>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-xs text-warning">{coverage.pct}% covered</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{coverage.missingSec.toFixed(1)}s missing</span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {coverage.gaps.map((gap) => <span key={`${gap.start}-${gap.end}`} className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 font-mono text-xs text-warning">{fmtTime(gap.start)}–{fmtTime(gap.end)}</span>)}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {!running ? (
          <button type="button" onClick={() => void action('start')} disabled={busy || pending.length > 0} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
            {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : state.status === 'idle' ? <Search className="size-3.5" aria-hidden /> : <RotateCcw className="size-3.5" aria-hidden />}
            {state.status === 'idle' ? 'Find missing scenes' : 'Retry unresolved ranges'}
          </button>
        ) : (
          <button type="button" onClick={() => void action('stop')} disabled={busy} className="flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive"><Square className="size-3.5 fill-current" aria-hidden /> Stop finder</button>
        )}
        <span className="text-xs text-muted-foreground">Manual only · suggested movie chunks only · maximum 4 parallel</span>
      </div>
      {pending.length > 0 && <p className="mt-2 text-xs text-warning">Pehle {pending.length} pending candidate(s) Accept/Reject karein; uske baad unresolved ranges Retry kar sakte hain.</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}

      {state.status !== 'idle' && (
        <div className="mt-5 rounded-lg border border-border bg-secondary/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {PHASES.map((phase, index) => {
              const activePhase = phase.key === state.status || (state.status === 'stopped' && phase.key === 'searching') || (state.status === 'error' && index === Math.max(0, currentPhase))
              const passed = currentPhase >= 0 && index < currentPhase
              return <div key={phase.key} className="flex items-center gap-1.5"><span className={`flex size-5 items-center justify-center rounded-full ${passed ? 'bg-success text-success-foreground' : activePhase ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{passed ? <Check className="size-3" aria-hidden /> : activePhase && running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Circle className="size-2.5" aria-hidden />}</span><span className={`text-[10px] ${activePhase ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{phase.label}</span>{index < PHASES.length - 1 && <span className="mx-1 h-px w-4 bg-border" />}</div>
            })}
          </div>
          <p className="mt-3 text-xs text-foreground">{state.progress || state.status}</p>
          <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{state.requests.filter((request) => request.status === 'queued').length} queued</span><span>·</span>
            <span>{state.requests.filter((request) => request.status === 'uploading' || request.status === 'running').length} active</span><span>·</span>
            <span>{state.requests.filter((request) => request.status === 'done').length} completed</span><span>·</span>
            <span>{state.requests.filter((request) => request.status === 'failed').length} failed</span><span>·</span>
            <span>{state.requestCount || 0} Gemini attempts</span><span>·</span><span>{(state.tokenCount || 0).toLocaleString()} tokens</span><span>·</span><span>{pending.length} review pending</span>
          </div>
          {state.error && <p role="alert" className="mt-2 text-xs text-destructive">{state.error}</p>}
        </div>
      )}

      {pending.length > 0 && <div className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Side-by-side candidate review</h3><div className="mt-2 flex flex-col gap-3">{pending.map((candidate) => <ReviewCandidate key={candidate.id} scanId={scan.id} candidate={candidate} onReview={(id, decision) => action(decision, id)} />)}</div></div>}

      {groupedRequests.length > 0 && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live Gemini activity and replies</h3>
          <div className="mt-2 flex flex-col gap-3">
            {groupedRequests.map(({ minute, requests }) => (
              <article key={minute.index} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2"><Play className="size-3.5 text-primary" aria-hidden /><h4 className="text-xs font-semibold">Short minute {minute.index + 1}</h4><span className="font-mono text-[10px] text-muted-foreground">{fmtTime(minute.start)}–{fmtTime(minute.end)}</span><span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] ${minute.status === 'failed' ? 'bg-destructive/15 text-destructive' : minute.status === 'awaiting_review' ? 'bg-warning/15 text-warning' : 'bg-primary/15 text-primary'}`}>{minute.status.replace('_', ' ')}</span></div>
                <div className="mt-2 flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                  <span>{minute.partIds.length} gap part(s)</span><span>·</span>
                  <span>{requests.filter((request) => request.status === 'queued').length} queued</span><span>·</span>
                  <span>{requests.filter((request) => request.status === 'uploading' || request.status === 'running').length} active</span><span>·</span>
                  <span>{minute.completedChunks.length}/{minute.candidateChunks.length} chunks checked</span>
                  {minute.clip && <><span>·</span><span>{minute.clip.durationSec.toFixed(2)}s clip · {(minute.clip.sizeBytes / 1024 / 1024).toFixed(1)} MB · 24 fps</span></>}
                </div>
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">Search order: {minute.candidateChunks.length ? minute.candidateChunks.map((chunk) => `chunk ${chunk + 1}`).join(' → ') : 'No minute-finder suggestion'}{minute.currentBatch?.length ? ` · Current batch: ${minute.currentBatch.map((chunk) => chunk + 1).join(', ')}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{minute.partIds.map((partId) => { const part = state.parts.find((item) => item.index === partId); return <span key={partId} className="rounded bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">P{partId} · {part?.result || 'pending'}</span> })}</div>
                {minute.error && <p role="alert" className="mt-2 text-xs text-destructive">{minute.error}</p>}
                <div className="mt-2 flex flex-col gap-2">{requests.length ? requests.map((request) => <RequestRow key={request.id} request={request} />) : <p className="rounded-md border border-dashed border-border p-3 text-xs leading-relaxed text-muted-foreground">{minute.status === 'failed' ? 'Is minute ke liye Gemini request nahi bheji gayi. Upar failure reason diya hai.' : minute.status === 'uploading' ? '24 fps clip Gemini Files par upload ho rahi hai. Upload complete hote hi request cards yahan aayenge.' : 'Clip aur request queue prepare ho rahi hai. Lane, model, timing aur raw reply request start hote hi yahan dikhenge.'}</p>}</div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
