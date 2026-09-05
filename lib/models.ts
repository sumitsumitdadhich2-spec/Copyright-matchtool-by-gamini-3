// Locked model pool: ONLY models with 250K TPM on the free tier.
// Real measured token rate at DEFAULT media resolution is ~65 tokens/frame
// (NOT the 258 in the docs — that figure only applies to MEDIA_RESOLUTION_HIGH).
// Each chunk-map request (short ~60-90s + 60s chunk @ 24 fps) is ~190K-234K tokens,
// so every model is effectively limited to 1 request per minute by TPM regardless of RPM.
export interface ModelSpec {
  id: string
  rpm: number
  rpd: number
}

/** CHUNK-MAP models (locked): gemini-3.6-flash, gemini-3.7-flash, and
 * gemini-3.8-flash are allowed to run chunk-time mapping requests. Every other
 * model is BANNED from this phase. All API keys run all three models in
 * parallel on the shared chunk queue. */
export const CHUNK_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3.6-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.7-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.8-flash', rpm: 5, rpd: 20 },
]

/** VERIFY models (locked): gemini-3.5-flash-lite + gemini-3.1-flash-lite ONLY.
 * Dono ki daily limit bahut high hai (500 RPD each) — 10 API keys ke saath
 * dono models ek saath parallel me verify karte hain. NEVER for chunk mapping. */
export const VERIFY_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
]

/** RESCAN models (primary): gemini-3-flash-preview and gemini-3.5-flash run
 * rescan requests (full-chunk segment hunt). Thinking level HIGH and max
 * output tokens apply globally to every request (see GEN_CONFIG). */
export const RESCAN_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3-flash-preview', rpm: 5, rpd: 20 },
  { id: 'gemini-3.5-flash', rpm: 5, rpd: 20 },
]

/** RESCAN BACKUP models: jab primary rescan models (3-flash-preview / 3.5-flash)
 * ki daily limit khatam ho jaye, to rescan in HIGH-LIMIT lite models par
 * fallback karta hai (500 RPD each) — rescan kabhi ruke nahi. */
export const RESCAN_BACKUP_POOL: ModelSpec[] = [
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500 },
  { id: 'gemini-3.1-flash-lite', rpm: 15, rpd: 500 },
]

/** Is this model one of the primary rescan models? */
export function isRescanModel(id: string): boolean {
  return RESCAN_MODEL_POOL.some((m) => m.id === id)
}

/** PADDED-VERIFY models (locked): when a short segment is PADDED (segment < 1.5s),
 * ALL its verify / re-verify requests must run ONLY on these three models —
 * gemini-3-flash-preview, gemini-3.5-flash, gemini-3.5-flash-lite. Other verify
 * models are BANNED for padded clips. Thinking HIGH + max output tokens apply
 * globally (see GEN_CONFIG). Non-padded verifies keep using the full verify pool. */
export const PADDED_VERIFY_MODEL_POOL: ModelSpec[] = [
  { id: 'gemini-3-flash-preview', rpm: 5, rpd: 20 },
  { id: 'gemini-3.5-flash', rpm: 5, rpd: 20 },
  { id: 'gemini-3.5-flash-lite', rpm: 15, rpd: 500 },
]

/** Is this model allowed to verify PADDED clips? */
export function isPaddedVerifyModel(id: string): boolean {
  return PADDED_VERIFY_MODEL_POOL.some((m) => m.id === id)
}

/** UI-ONLY display name: strips the vendor prefix and shows "flash" as "shiva".
 * NEVER use this for API calls — real model ids stay unchanged in the backend. */
export function displayModelName(id: string): string {
  return id.replace('gemini-', '').replace(/flash/gi, 'shiva')
}

/** Full pool (chunk + verify + rescan + backups, de-duplicated) — used by the
 * UI model board and reports. */
export const MODEL_POOL: ModelSpec[] = [
  ...CHUNK_MODEL_POOL,
  ...VERIFY_MODEL_POOL,
  ...RESCAN_MODEL_POOL,
  ...RESCAN_BACKUP_POOL,
  ...PADDED_VERIFY_MODEL_POOL,
].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)

/** Is this model one of the three locked chunk-map models? */
export function isChunkModel(id: string): boolean {
  return CHUNK_MODEL_POOL.some((m) => m.id === id)
}

/** Max AUTOMATIC quality retries per chunk when the output looks like a false
 * result (extrapolated A-to-Z mapping / zero NOT FOUND lines). After this many
 * auto-retries the result is accepted as-is — quota is precious. */
export const MAX_QUALITY_RETRIES = 1

/** Thinking level for EVERY Gemini request (chunk map, verify, rescan). */
export const THINKING_LEVEL = 'high'

/** Max output tokens for EVERY Gemini request — always the maximum. */
export const MAX_OUTPUT_TOKENS = 65_536

/** Minimum spacing between requests per model (ms). TPM 250K vs ~190K tokens/request
 * (short + chunk @ 24 fps × 65 tok/frame at default resolution) => 1 req/min. */
export const MODEL_MIN_INTERVAL_MS = 60_000

/** Cooldown applied on RPM/TPM-type 429s (ms). */
export const RATE_COOLDOWN_MS = 60_000

/** fps used for every chunk-map request (locked).
 * Short + 60s chunk together @ 24 fps × 65 tok/frame ≈ ~190K tokens — fits under the 250K TPM cap at default resolution. */
export const SCAN_FPS = 24

export const CHUNK_SECONDS = 60

/** Free-tier TPM cap shared by every model in the pool. */
export const TPM_LIMIT = 250_000

/** Measured token cost per video frame at DEFAULT media resolution. */
export const TOKENS_PER_FRAME = 65

/** Estimate the token cost of a request from its total video seconds (all clips combined, 24 fps). */
export function estimateRequestTokens(totalVideoSeconds: number): number {
  return Math.ceil(totalVideoSeconds * SCAN_FPS * TOKENS_PER_FRAME) + 2_000
}

/** Minimum spacing (ms) between requests of this size on one (key × model) lane
 * so the model runs at FULL TPM capacity — small verify clips wait seconds,
 * full chunk-map requests wait the whole minute. */
export function pacingIntervalMs(totalVideoSeconds: number): number {
  const tokens = estimateRequestTokens(totalVideoSeconds)
  const ms = Math.ceil((tokens / TPM_LIMIT) * 60_000)
  return Math.min(MODEL_MIN_INTERVAL_MS, Math.max(3_000, ms))
}
