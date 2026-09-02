import 'server-only'

import { getScan, saveScan, addLog } from './store'
import { getAllUserApiKeys, getUserTwelveLabsKey, getUserMinuteFinderMode } from './user-keys'
import { startMergePipeline, pipelineReady, isPipelineRunning } from './merge-pipeline'
import { startGeminiMinuteFinder, isMinuteFinderRunning } from './gemini-minute-finder'
import type { MinuteFinderMode } from './types'

export interface DispatchUser {
  username: string
  role: 'admin' | 'user'
}

/**
 * SINGLE auto-trigger entry point used by the upload (short-after-movie) and
 * trim (movie-after-short) routes once both videos are in and the trim is
 * confirmed. Reads the user's `minuteFinder` toggle:
 *
 *   'gemini'     → Gemini Minute Finder (20-min windows → minute list → auto chunk scan)
 *   'twelvelabs' → the OLD merge → Marengo → Pegasus → approval flow (unchanged)
 *   'off'        → nothing; the user presses Start for a normal Full scan
 *
 * A running pipeline is never interrupted — a toggle change applies from the
 * next upload/trim. Errors are logged on the scan, never thrown to the route.
 */
export async function dispatchMinuteFinder(scanId: string, user: DispatchUser | null): Promise<MinuteFinderMode | null> {
  const scan = getScan(scanId)
  if (!scan || !pipelineReady(scan)) return null
  if (!user) return null

  const mode = await getUserMinuteFinderMode(user.username)

  if (mode === 'off') {
    addLog(scan, 'info', 'Minute finder OFF — manual Start dabao (normal Full scan)')
    saveScan(scan)
    return mode
  }

  if (mode === 'twelvelabs') {
    // ---- OLD BEHAVIOUR, verbatim: only fresh pipelines auto-start ----
    if (isPipelineRunning(scanId)) return mode
    const st = scan.mergePipeline?.status
    if (st && st !== 'idle') return mode
    const tlKey = await getUserTwelveLabsKey(user.username)
    if (!tlKey) {
      addLog(scan, 'info', 'TwelveLabs key nahi — auto merge pipeline skip, app normal flow me chalega')
      saveScan(scan)
    } else {
      startMergePipeline(scanId, tlKey)
    }
    return mode
  }

  // ---- 'gemini' ----
  if (isMinuteFinderRunning(scanId)) return mode
  const keys = await getAllUserApiKeys(user.username)
  if (keys.length === 0) {
    addLog(scan, 'warn', 'Gemini API key nahi — Minute Finder skip. Settings me key add karo ya manual Start (Full scan) dabao')
    saveScan(scan)
    return mode
  }
  const result = startGeminiMinuteFinder(scanId, keys, user, 'start')
  if (!result.ok && result.error) {
    // "already complete for this trim" etc. — informational only.
    const fresh = getScan(scanId)
    if (fresh) {
      addLog(fresh, 'info', `Gemini Minute Finder auto-start skip: ${result.error}`)
      saveScan(fresh)
    }
  }
  return mode
}
