export type ChunkStatus = 'pending' | 'scanning' | 'no_match' | 'match' | 'failed' | 'cancelled'

/** One parsed "Short X --> Movie Y" mapping line from the model's HISSA 2 output. */
export interface ChunkMatch {
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  /** ABSOLUTE seconds within the full movie (chunk offset + local chunk time) */
  movieStart: number
  movieEnd: number
  /** which movie chunk this match was found in */
  chunkIndex: number
  model: string
  /** verifier outcome: true = confirmed SAME at 24fps, false = kept but unverified (API errors) */
  verified?: boolean
  /** the confirmed window came from a rescan, not the original chunk mapping */
  viaRescan?: boolean
}

/** Full raw model output captured for a chunk request (for the UI expander). */
export interface ChunkRawOutput {
  model: string
  t: number
  text: string
}

export interface ChunkState {
  index: number
  status: ChunkStatus
  model?: string
  attempts: number
  /** legacy UI field — not set by the current pipeline */
  confidence?: number
  /** parsed HISSA 2 matches found inside THIS chunk (absolute movie seconds) */
  matches?: ChunkMatch[]
  /** automatic quality retries used (false-result detector) — max 1 */
  qualityRetries?: number
  /** full raw Gemini outputs produced for this chunk, oldest first */
  rawOutputs?: ChunkRawOutput[]
  /** cancelled by the EARLY-STOP system (all matches found + fast-confirmed) —
   *  not revived on Resume unless its minute's matches get rejected */
  skippedEarlyStop?: boolean
}

export type ShortSegmentStatus = 'pending' | 'scanning' | 'verifying' | 'done'

/** One 1-minute segment of the SHORT video. Long shorts are scanned
 *  minute-by-minute: segment N+1 only starts after segment N has been
 *  mapped against EVERY movie chunk AND its matches verified. */
export interface ShortSegmentState {
  /** minute number within the short video (0-based) */
  index: number
  /** ABSOLUTE seconds within the short video */
  start: number
  end: number
  status: ShortSegmentStatus
  /** per-movie-chunk states for THIS short segment (source of truth) */
  chunks: ChunkState[]
  /** user minute selection: false = skipped by the scheduler (default true) */
  selected?: boolean
  /** PER-MINUTE movie search range (ABSOLUTE original-movie seconds).
   *  When set, this minute is scanned ONLY against movie chunks overlapping
   *  this range — all other chunks are skipped (API quota saver).
   *  Unset = search the whole trim window. */
  movieRangeStart?: number
  movieRangeEnd?: number
  /** TWELVE LABS PRE-FILTER (optional): chunk indexes selected by embedding
   *  similarity for THIS minute (already includes ±1 buffer chunks).
   *  Unset = no pre-filter — scan every chunk (normal full scan). */
  prefilterChunks?: number[]
  /** TL confidence per selected chunk (chunkIndex -> best cosine similarity).
   *  Drives high→low confidence ordering for chunk scan + verification. */
  chunkConfidence?: Record<string, number>
  /** Expected short-video windows (ABSOLUTE short seconds) from TwelveLabs —
   *  EARLY-STOP: jab har window ka candidate mil jaye AUR har matched chunk ka
   *  1 segment verify ho jaye, to is minute ke bache chunks scan nahi hote. */
  tlWindows?: { start: number; end: number }[]
  /** chunks skipped by the early-stop system in the last run (quota saved) */
  earlyStopSavedChunks?: number
}

// ---------- Render / Export ----------

export type RenderResolution = '480p' | '720p' | '1080p' | '2k' | '4k'

export interface RenderSettings {
  resolution: RenderResolution
  /** output frames per second, 1-120 */
  fps: number
  /** video bitrate in kbps */
  videoBitrateKbps: number
  /** audio bitrate in kbps */
  audioBitrateKbps: number
}

export type RenderStatus = 'idle' | 'rendering' | 'done' | 'error'

export interface RenderJob {
  status: RenderStatus
  settings: RenderSettings | null
  /** 0-100 */
  pct: number
  /** estimated seconds remaining (from ffmpeg speed=) */
  etaSeconds: number | null
  /** total duration of the stitched output in seconds */
  totalOutputSeconds: number
  /** number of scene segments being stitched */
  segmentCount: number
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  /** final rendered file size in bytes */
  fileSize: number | null
}

export interface LogEntry {
  t: number
  level: 'info' | 'warn' | 'error' | 'success'
  msg: string
}

export type ScanStatus =
  | 'created'
  | 'uploading'
  | 'chunking'
  | 'ready'
  | 'scanning'
  /** candidate-verification phase: verifier + rescan requests in flight */
  | 'verifying'
  | 'done'
  | 'stopped'
  | 'error'

// ---------- Candidate + Verifier system ----------

export type CandidateVerdict = 'pending' | 'verifying' | 'same' | 'different' | 'error'
export type RescanState = 'none' | 'pending' | 'rescanning' | 'found' | 'not_found' | 'error'

/** One movie-window candidate for a short segment (one parsed chunk match). */
export interface CandidateEntry {
  /** ABSOLUTE movie seconds */
  movieStart: number
  movieEnd: number
  chunkIndex: number
  /** model that produced this candidate during the chunk phase */
  model: string
  /** verifier verdict for this exact window */
  verdict: CandidateVerdict
  verifierModel?: string
  verifierReason?: string
  /** rescan of this candidate's full 1-minute chunk (runs only if verify said different) */
  rescan: RescanState
  /** window found by the rescan (ABSOLUTE movie seconds), if any */
  rescanMovieStart?: number
  rescanMovieEnd?: number
  /** verifier verdict for the rescan-found window */
  rescanVerdict?: CandidateVerdict
  rescanReason?: string
}

export type CandidateGroupStatus =
  | 'pending' // waiting for a verifier worker
  | 'verifying' // verifier requests in flight
  | 'rescanning' // all candidates failed verify — rescanning their chunks
  | 'confirmed' // a candidate (or rescan window) was verified SAME
  | 'rejected' // every candidate + every rescan failed — final decision: not a match
  | 'unverified' // could not verify due to repeated API errors — original match kept, flagged

/** All candidates that claim the SAME short-video segment, verified as one unit. */
export interface CandidateGroup {
  id: string
  /** seconds within the short video */
  shortStart: number
  shortEnd: number
  status: CandidateGroupStatus
  candidates: CandidateEntry[]
  /** index into candidates[] of the confirmed window (rescan window if confirmedViaRescan) */
  confirmedIndex: number | null
  confirmedViaRescan: boolean
  attempts: number
}

// ---------- Twelve Labs pre-filter (optional) ----------

export type TwelveLabsIndexStatus = 'none' | 'indexing' | 'ready' | 'error'

/** Movie indexing state on Twelve Labs (Marengo embeddings). Fully optional —
 *  when absent, the app behaves exactly as before (normal full scan). */
export interface TwelveLabsState {
  status: TwelveLabsIndexStatus
  indexId?: string
  taskId?: string
  videoId?: string
  /** number of 6-second segment embeddings saved locally */
  segmentCount?: number
  indexedAt?: number
  /** human-readable indexing progress note */
  progress?: string
  /** indexing start time — UI elapsed/estimate tracking */
  startedAt?: number
  /** total time the whole indexing job took (upload → ready → embeddings), ms */
  totalMs?: number
  error?: string | null
}

/** Result of the pre-filter decision for the LAST scan run. */
export interface PrefilterInfo {
  /** 'prefiltered' = Twelve Labs selected the chunks; 'full' = normal full scan */
  mode: 'prefiltered' | 'full'
  /** chunks sent to Gemini (pending ones) vs total chunk count */
  selectedChunks: number
  totalChunks: number
  /** why the scan fell back to full (only when mode = 'full' and TL was attempted) */
  reason?: string
  at: number
}

// ---------- Auto Merge → Index → Pegasus Segmentation pipeline ----------

export type MergePipelineStatus =
  | 'idle'
  | 'checking' // ffprobe both files → target = movie resolution/fps
  | 'merging' // precise re-encode merge (short + movie normalized, parallel parts, one join)
  | 'uploading' // merged video → TwelveLabs asset
  | 'indexing' // Marengo index via indexed-assets + embeddings download
  | 'splitting' // time-split embeddings at short-end into short/movie sets
  | 'segmenting' // Pegasus 1.5 segmentation (analyze/tasks)
  | 'suggesting' // building the minute list from segment_4
  | 'awaiting_approval' // minute list shown — waiting for the user
  | 'approved' // user approved — Gemini scan kicked off
  | 'error'

/** One suggested movie minute to check (built from Pegasus segment_4). */
export interface MinuteSuggestion {
  /** ORIGINAL-movie minute number (0-based: minute 30 = 30:00–31:00) */
  minute: number
  /** how many segment_4 scenes pointed at this minute */
  sceneCount: number
  /** confidence strings straight from segment_4 metadata */
  confidences: string[]
  /** PART A (short) windows these scenes came from (ABSOLUTE short seconds) */
  shortWindows: { start: number; end: number }[]
}

/** One raw Pegasus segment (for UI/debug display). */
export interface PegasusSegment {
  start: number
  end: number
  metadata: Record<string, unknown>
}

export interface MergePipelineState {
  status: MergePipelineStatus
  /** live human-readable progress note for the current step */
  progress?: string
  /** PART A boundary = short duration in seconds */
  shortEnd?: number
  mergedDuration?: number
  assetId?: string
  segTaskId?: string
  /** merged > 2h — Pegasus segmentation was skipped (index still completed) */
  segmentationSkipped?: boolean
  minuteSuggestions?: MinuteSuggestion[]
  /** raw Pegasus segmentation output per definition id (debug/UI) */
  segments?: Record<string, PegasusSegment[]>
  approvedMinutes?: number[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

// ---------- Gemini Minute Finder (TwelveLabs/Pegasus alternative) ----------

/** Which minute finder runs after upload + trim confirm.
 *  'gemini' (default) = Gemini Minute Finder (20-min windows @ 5fps/1fps),
 *  'twelvelabs' = old merge → Marengo → Pegasus → approval flow (unchanged),
 *  'off' = no finder; user presses Start for a normal full scan. */
export type MinuteFinderMode = 'gemini' | 'twelvelabs' | 'off'

export type GeminiPrescanStatus =
  | 'idle'
  | 'preparing' // ffmpeg upload-copy of the trimmed movie
  | 'uploading' // short + movie copy → Gemini Files API (per key)
  | 'scanning' // 20-minute windows in flight
  | 'starting_scan' // minutes found — kicking off the chunk scan
  | 'done'
  | 'error'

export type GeminiPrescanWindowStatus = 'pending' | 'running' | 'done' | 'failed'

export interface GeminiPrescanWindow {
  index: number
  /** seconds within the MOVIE COPY (trim-relative) */
  startOffset: number
  endOffset: number
  status: GeminiPrescanWindowStatus
  /** "key N · model" lane that produced the result */
  lane?: string
  /** usageMetadata.totalTokenCount of the last response */
  tokens?: number
  /** parsed MATCH + POSSIBLE lines */
  matches?: number
  /** ABSOLUTE original-movie minutes this window contributed */
  minutes?: number[]
  raw?: string
  error?: string
  attempts?: number
}

export interface GeminiPrescanUpload {
  shortUri: string
  shortName: string
  movieUri: string
  movieName: string
  uploadedAt: number
}

export interface GeminiPrescanState {
  status: GeminiPrescanStatus
  progress?: string
  windowLen: number
  movieCopy?: {
    path: string
    durationSec: number
    sizeBytes: number
    reencoded: boolean
    /** trim range the copy was cut from — a different trim invalidates the copy + movie uploads */
    trimStart: number
    trimEnd: number
  }
  /** keyed by apiKeyHash — Gemini files are project-scoped, so one upload per key */
  uploads: Record<string, GeminiPrescanUpload>
  windows: GeminiPrescanWindow[]
  minuteSuggestions?: MinuteSuggestion[]
  /** minutes handed to the chunk scan (absolute original-movie minutes, 0-based) */
  appliedMinutes?: number[]
  error?: string | null
  startedAt?: number | null
  finishedAt?: number | null
}

export interface ModelLiveState {
  state: 'idle' | 'active' | 'cooling' | 'exhausted' | 'waiting'
  currentChunk: number | null
  cooldownUntil: number | null
  usedToday: number
}

export interface ScanReport {
  totalScanTimeMs: number
  chunksScanned: number
  chunksFailed: number
  modelsUsed: string[]
  /** all parsed matches across all chunks (absolute movie seconds) */
  matches: ChunkMatch[]
  /** verifier pipeline stats (present when the verification phase ran) */
  groupsTotal?: number
  groupsConfirmed?: number
  groupsRejected?: number
  groupsUnverified?: number
  /** how the chunk set was chosen: 'twelvelabs' pre-filter, 'gemini' minute finder, or normal 'full' scan */
  prefilterMode?: 'twelvelabs' | 'full' | 'gemini'
  prefilterSelected?: number
  prefilterTotal?: number
}

export interface Scan {
  id: string
  createdAt: number
  /** Last save timestamp — used to pick the freshest copy across serverless instances. */
  updatedAt?: number
  status: ScanStatus
  shortName: string | null
  movieName: string | null
  shortSize: number | null
  movieSize: number | null
  shortDuration: number | null
  movieDuration: number | null
  chunkCount: number
  chunkingProgress: number
  /** movie uploaded but the trim window is not confirmed yet — chunking waits */
  awaitingTrim?: boolean
  /** confirmed trim window (ABSOLUTE movie seconds) — chunks cover ONLY this range.
   *  All reported movie timestamps stay absolute to the ORIGINAL movie. */
  movieTrimStart?: number
  movieTrimEnd?: number
  /** MIRROR of the current/active short segment's chunks (kept for UI compat).
   *  Source of truth per segment lives in shortSegments[i].chunks. */
  chunks: ChunkState[]
  /** 1-minute segments of the short video, scanned sequentially (minute-by-minute) */
  shortSegments?: ShortSegmentState[]
  /** index of the short segment currently being scanned/verified */
  currentShortSegment?: number
  /** background cutting of the short into 1-minute segment files (0-100) */
  shortSegmentingProgress?: number
  /** render/export job state (present after a render is started) */
  renderJob?: RenderJob
  /** all parsed matches across all chunks, sorted by shortStart (absolute movie seconds) */
  matches: ChunkMatch[]
  /** Candidate + verifier pipeline: one group per claimed short segment */
  candidateGroups?: CandidateGroup[]
  /** OPTIONAL Twelve Labs pre-filter: movie indexing state (absent = feature unused) */
  twelveLabs?: TwelveLabsState
  /** pre-filter decision of the LAST scan run (for the UI) */
  prefilter?: PrefilterInfo
  /** AUTO pipeline: merge → TL asset → Marengo index → Pegasus segmentation → minute approval */
  mergePipeline?: MergePipelineState
  /** GEMINI MINUTE FINDER: 20-minute window pre-scan → minute list → auto chunk scan */
  geminiPrescan?: GeminiPrescanState
  logs: LogEntry[]
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  report: ScanReport | null
  modelStates: Record<string, ModelLiveState>
}

export interface ScanSummary {
  id: string
  createdAt: number
  status: ScanStatus
  movieName: string | null
  shortName: string | null
  movieDuration: number | null
  matchCount: number
  finishedAt: number | null
}
