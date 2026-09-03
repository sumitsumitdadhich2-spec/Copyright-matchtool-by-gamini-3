'use client'

import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'
import type { Scan } from '@/lib/types'
import { EngineBadge } from './engine-badge'

const LEVEL_CLS: Record<string, string> = {
  info: 'text-muted-foreground',
  warn: 'text-amber-400',
  error: 'text-destructive',
  success: 'text-success',
}

export function LogsPanel({ scan }: { scan: Scan }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)

  useEffect(() => {
    const el = boxRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [scan.logs.length])

  return (
    <section aria-label="Live logs" className="panel">
      <div className="flex items-center gap-2">
        <Terminal className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold">Live Logs</h2>
        <EngineBadge live={scan.status === 'scanning' || scan.status === 'chunking' || scan.renderJob?.status === 'rendering'} className="ml-auto" />
        <span className="font-mono text-xs text-muted-foreground">{scan.logs.length}</span>
      </div>
      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="mt-3 h-64 overflow-y-auto rounded-md border border-border bg-background p-2 font-mono text-xs leading-relaxed"
        role="log"
        aria-live="polite"
      >
        {scan.logs.length === 0 ? (
          <p className="text-muted-foreground">Logs will stream here during the scan.</p>
        ) : (
          scan.logs.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/60">
                {new Date(l.t).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={LEVEL_CLS[l.level] || ''}>{l.msg.replace(/flash/gi, 'shiva')}</span>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
