'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Play, Square, RotateCcw, Loader2, LogOut, ScanSearch, Settings, Users } from 'lucide-react'
import type { Scan, MinuteFinderMode } from '@/lib/types'
import { fetcher } from '@/lib/format'
import { useAuth } from '@/components/auth/auth-gate'
import { UsersDialog } from '@/components/auth/users-dialog'
import { TokenBadge, TokensExhaustedBanner, useTokens } from './token-badge'
import { SettingsDialog } from './settings-dialog'
import { UploadPanel } from './upload-panel'
import { TwelveLabsPanel } from './twelvelabs-panel'
import { MinuteFinderPanel } from './minute-finder-panel'
import { TrimPanel } from './trim-panel'
import { MinuteSelectPanel } from './minute-select-panel'
import { ScanTimeline } from './scan-timeline'
import { ModelBoard } from './model-board'
import { ChunkResultsPanel } from './chunk-results-panel'
import { CandidatesPanel } from './candidates-panel'
import { LogsPanel } from './logs-panel'
import { ReportPanel } from './report-panel'
import { ComparePanel } from './compare-panel'
import { RenderPanel } from './render-panel'
import { HistoryPanel } from './history-panel'

interface ScanResponse {
  scan: Scan
  running: boolean
  usage: Record<string, number> | null
}

export function Dashboard() {
  const [scanId, setScanId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const { user, logout } = useAuth()
  const { tokens, exhausted, refreshTokens } = useTokens()

  const { data, mutate } = useSWR<ScanResponse>(scanId ? `/api/scans/${scanId}` : null, fetcher, {
    refreshInterval: (latest) => {
      const st = latest?.scan?.status
      const rendering = latest?.scan?.renderJob?.status === 'rendering'
      const segmenting =
        latest?.scan?.shortSegmentingProgress !== undefined && latest.scan.shortSegmentingProgress < 100
      return st === 'scanning' || st === 'chunking' || latest?.running || rendering || segmenting ? 1500 : 5000
    },
  })

  // Minute finder toggle (per-user setting): gemini (default) | twelvelabs | off.
  const { data: settings, mutate: mutateSettings } = useSWR<{ minuteFinder?: MinuteFinderMode }>('/api/settings', fetcher)
  const minuteFinderMode: MinuteFinderMode = settings?.minuteFinder ?? 'gemini'

  const scan = data?.scan || null
  const running = data?.running || false
  const status = scan?.status

  // Scan is BLOCKED when a normal user's tokens are exhausted (admin is unlimited).
  const scanBlocked = user.role !== 'admin' && exhausted
  const canStart = Boolean(scan && !running && status === 'ready' && scan.chunkCount > 0 && !scanBlocked)
  // Segments-aware: any incomplete minute (or any resumable chunk inside one) allows Resume.
  const hasResumableWork = Boolean(
    scan &&
      (scan.shortSegments?.length
        ? scan.shortSegments.some(
            (seg) =>
              seg.status !== 'done' ||
              seg.chunks.some((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled'),
          )
        : scan.chunks.some((c) => c.status === 'pending' || c.status === 'scanning' || c.status === 'cancelled')),
  )
  const canResume = Boolean(
    scan && !running && (status === 'stopped' || ((status === 'error' || status === 'scanning') && hasResumableWork)),
  )
  // Stop dab chuka hai lekin in-flight requests background me settle ho rahi hain —
  // partial results/export TURANT available hain, dobara Stop ki zaroorat nahi.
  const stoppingInBackground = Boolean(running && status === 'stopped')
  const canStop = running && !stoppingInBackground

  async function action(path: string, body?: object) {
    if (!scanId) return
    setBusy(true)
    setActionError(null)
    const res = await fetch(`/api/scans/${scanId}/${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    setBusy(false)
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setActionError(j.error || 'Action failed')
    }
    void mutate()
    refreshTokens()
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-4 p-4 md:p-6">
      <header className="alert-in sticky top-3 z-20 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card/80 p-3 shadow-lg backdrop-blur-md md:px-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md shadow-primary/30">
            <ScanSearch className="size-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight tracking-tight md:text-lg">
              Shiva <span className="text-primary">MatchTool</span>
            </h1>
            <p className="hidden font-mono text-[11px] uppercase tracking-wider text-muted-foreground sm:block">
              AI scanner · 1 prompt/min · 24 fps
            </p>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <TokenBadge tokens={tokens} />
          {(status === 'scanning' || status === 'verifying') && (
            <>
              <span className="pill-live flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {(() => {
                  const segCount = scan?.shortSegments?.length ?? 0
                  const minute =
                    segCount > 1 ? ` minute ${(scan?.currentShortSegment ?? 0) + 1}/${segCount}` : ''
                  return status === 'verifying' ? `Verifying${minute} at 24 fps...` : `Scanning${minute}...`
                })()}
              </span>
              {/* Verify pipeline runs IN PARALLEL with chunk scanning — show its own status. */}
              {status === 'scanning' &&
                (() => {
                  const active = (scan?.candidateGroups || []).filter(
                    (g) => g.status === 'pending' || g.status === 'verifying' || g.status === 'rescanning',
                  ).length
                  return active > 0 ? (
                    <span className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      Verify pipeline: {active} group(s)
                    </span>
                  ) : null
                })()}
            </>
          )}
          {stoppingInBackground && (
            <span className="flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-3 py-1 text-xs font-medium text-warning">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Stopping — partial results ready (export niche available)
            </span>
          )}
          <button
            type="button"
            onClick={() => action('start')}
            disabled={!canStart || busy}
            className="btn-press flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 disabled:opacity-40 disabled:shadow-none"
          >
            <Play className="size-4" aria-hidden /> Start scan
          </button>
          <button
            type="button"
            onClick={() => action('start', { resume: true })}
            disabled={!canResume || busy}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium hover:border-primary/40 hover:bg-secondary disabled:opacity-40"
          >
            <RotateCcw className="size-4" aria-hidden /> Resume
          </button>
          <button
            type="button"
            onClick={() => action('stop')}
            disabled={!canStop || busy}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-destructive/50 bg-card px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-40"
          >
            <Square className="size-4" aria-hidden /> Stop
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings — API keys"
            className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium hover:border-primary/40 hover:bg-secondary"
          >
            <Settings className="size-4" aria-hidden />
            <span className="hidden sm:inline">Settings</span>
          </button>
          {user.role === 'admin' && (
            <button
              type="button"
              onClick={() => setUsersOpen(true)}
              aria-label="Manage users"
              title="Manage users — create and control IDs"
              className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium hover:border-primary/40 hover:bg-secondary"
            >
              <Users className="size-4" aria-hidden />
              <span className="hidden sm:inline">Users</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => logout()}
            aria-label={`Log out ${user.username}`}
            title={`Logged in as ${user.username} — log out`}
            className="btn-press flex items-center gap-1.5 rounded-lg border border-input bg-card px-3 py-2 text-sm font-medium hover:border-destructive/40 hover:bg-secondary"
          >
            <LogOut className="size-4" aria-hidden />
            <span className="hidden sm:inline">{user.username}</span>
          </button>
        </div>
      </header>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {user.role === 'admin' && <UsersDialog open={usersOpen} onClose={() => setUsersOpen(false)} />}

      {scanBlocked && <TokensExhaustedBanner tokens={tokens} />}

      {actionError && (
        <p role="alert" className="alert-in rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}
      {scan?.error && (
        <p role="alert" className="alert-in rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Scan error: {scan.error}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {scan && (
            <MinuteFinderPanel
              scan={scan}
              mode={minuteFinderMode}
              onModeChanged={(m) => void mutateSettings((prev) => ({ ...(prev || {}), minuteFinder: m }), { revalidate: true })}
            />
          )}
          {/* Old TwelveLabs auto pipeline — only behind the toggle (zero changes inside). */}
          {scan && minuteFinderMode === 'twelvelabs' && <TwelveLabsPanel scan={scan} />}
          <UploadPanel scan={scan} selectedScanId={scanId} onScanCreated={(id) => setScanId(id)} refresh={() => void mutate()} />
          {scan && scan.awaitingTrim && scan.movieDuration && scan.status !== 'chunking' && (
            <TrimPanel scan={scan} refresh={() => void mutate()} />
          )}
          {scan && (scan.shortSegments?.length ?? 0) > 1 && !scan.awaitingTrim && (
            <MinuteSelectPanel scan={scan} running={running} refresh={() => void mutate()} />
          )}
          <ScanTimeline scan={scan || emptyScan()} />
          <ModelBoard scan={scan} usage={data?.usage || null} />
          {scan && <CandidatesPanel scan={scan} />}
          {scan && scan.report && <ReportPanel scan={scan} />}
          {scan && (scan.matches?.length ?? 0) > 0 && <ComparePanel scan={scan} />}
          {scan && (scan.status === 'done' || scan.status === 'stopped') && (scan.matches?.length ?? 0) > 0 && (
            <RenderPanel scan={scan} />
          )}
          {scan && <ChunkResultsPanel scan={scan} />}
          {scan && <LogsPanel scan={scan} />}
        </div>
        <div className="flex flex-col gap-4">
          <HistoryPanel
            activeId={scanId}
            onSelect={(id) => setScanId(id)}
            onNew={() => {
              setScanId(null)
              setActionError(null)
            }}
          />
        </div>
      </div>
    </div>
  )
}

function emptyScan(): Scan {
  return {
    id: '',
    createdAt: 0,
    status: 'created',
    shortName: null,
    movieName: null,
    shortSize: null,
    movieSize: null,
    shortDuration: null,
    movieDuration: null,
    chunkCount: 0,
    chunkingProgress: 0,
    chunks: [],
    matches: [],
    candidateGroups: [],
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
    modelStates: {},
  }
}
