'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { AlertTriangle, Loader2, Search } from 'lucide-react'
import type { GapBackupState, Scan, ShortCoverage, ShortRange } from '@/lib/types'
import { fetcher, fmtTime } from '@/lib/format'

interface GapResponse {
  coverage: ShortCoverage
  gaps: ShortRange[]
  state: GapBackupState
  running: boolean
}

export function GapBackupPanel({ scan }: { scan: Scan }) {
  const { data, mutate } = useSWR<GapResponse>(`/api/scans/${scan.id}/gap-backup`, fetcher, { refreshInterval: 1500 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const preview = data ?? { coverage: scan.report?.coverage, gaps: [], state: scan.gapBackup, running: false }
  const coverage = preview.coverage
  if (!coverage || coverage.gaps.length === 0) return null
  const state: GapBackupState = preview.state ?? { status: 'idle', parts: [], uploads: {}, movieUploads: {}, windows: [], candidates: [], addedMatches: [] }

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/scans/${scan.id}/gap-backup`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) setError(body.error || 'Gap backup could not start')
      void mutate()
    } catch {
      setError('Gap backup request failed')
    } finally {
      setBusy(false)
    }
  }

  const running = data?.running || ['cutting', 'uploading', 'searching', 'chunking', 'verifying'].includes(state.status)

  return (
    <section aria-label="Manual gap review" className="panel border-warning/40">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-4 text-warning" aria-hidden />
        <h2 className="text-sm font-semibold">Coverage review</h2>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-xs text-warning">{coverage.pct}% covered</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{coverage.missingSec.toFixed(1)}s missing</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        These are exact short-video ranges with no current match. Rejected-kept matches are included in coverage and are not shown as gaps.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {coverage.gaps.map((gap) => (
          <span key={`${gap.start}-${gap.end}`} className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 font-mono text-xs text-warning">
            {fmtTime(gap.start)} – {fmtTime(gap.end)}
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || running}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Search className="size-3.5" aria-hidden />}
          {running ? `${state.status}…` : 'Find these in the movie'}
        </button>
        <span className="text-xs text-muted-foreground">Manual only — no automatic backup starts at scan completion.</span>
      </div>
      {state.status !== 'idle' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Status: <span className="font-mono">{state.status}</span>
          {state.candidates.length ? ` · ${state.candidates.length} candidate(s)` : ''}
          {state.error ? ` · ${state.error}` : ''}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}
