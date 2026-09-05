'use client'

import useSWR from 'swr'
import { History, Plus } from 'lucide-react'
import type { ScanSummary } from '@/lib/types'
import { fetcher, fmtTime } from '@/lib/format'

const STATUS_CLS: Record<string, string> = {
  done: 'bg-success/15 text-success',
  scanning: 'bg-primary/15 text-primary',
  verifying: 'bg-primary/15 text-primary',
  stopped: 'bg-amber-500/15 text-amber-400',
  error: 'bg-destructive/15 text-destructive',
  queued: 'bg-muted text-muted-foreground',
}

export function HistoryPanel({ activeId, onSelect, onNew }: { activeId: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const { data } = useSWR<{ scans: ScanSummary[] }>('/api/scans', fetcher, { refreshInterval: 5000 })
  const scans = data?.scans || []

  return (
    <section aria-label="Scan history" className="panel">
      <div className="flex items-center gap-2">
        <History className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Scan History</h2>
        <button
          type="button"
          onClick={onNew}
          className="btn-press ml-auto flex items-center gap-1 rounded-lg border border-input px-2.5 py-1 text-xs font-medium hover:border-primary/40 hover:bg-secondary"
        >
          <Plus className="size-3.5" aria-hidden /> New scan
        </button>
      </div>
      {scans.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No scans yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {scans.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className={`btn-press w-full rounded-lg border p-2.5 text-left text-xs ${
                  s.id === activeId
                    ? 'border-primary/50 bg-primary/10 shadow-md shadow-primary/10'
                    : 'border-border bg-background/60 hover:border-primary/30 hover:bg-secondary'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{s.movieName || 'Untitled scan'}</span>
                  <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] ${STATUS_CLS[s.status] || 'bg-muted text-muted-foreground'}`}>
                    {s.background?.state === 'queued' ? `queued${s.background.position ? ` #${s.background.position}` : ''}` : s.background?.state === 'running' ? 'background' : s.status}
                  </span>
                </div>
                <div className="mt-0.5 flex gap-2 text-muted-foreground">
                  <span>{new Date(s.createdAt).toLocaleString()}</span>
                  {s.movieDuration ? <span className="font-mono">{fmtTime(s.movieDuration)}</span> : null}
                  <span className="ml-auto font-mono">{s.matchCount} match(es)</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
