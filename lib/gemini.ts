import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { SCAN_FPS, MAX_OUTPUT_TOKENS } from './models'
import type { ChunkMatch } from './types'

/** Shared generation config for EVERY request:
 * thinking level HIGH + max output tokens, always. */
const GEN_CONFIG = {
  temperature: 0,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
  // DEFAULT media resolution only (~65 tok/frame, measured). Never set
  // mediaResolution: LOW/MEDIUM behave the same as default, and HIGH
  // quadruples cost to ~257 tok/frame.
} as const

export type GeminiErrorKind = 'rpd' | 'rate' | 'unavailable' | 'other'

export class GeminiError extends Error {
  kind: GeminiErrorKind
  constructor(kind: GeminiErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export function getClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey })
}

/** Upload a local video file to the Gemini Files API and wait until it is ACTIVE. */
export async function uploadVideo(ai: GoogleGenAI, filePath: string): Promise<{ uri: string; name: string }> {
  const file = await ai.files.upload({ file: filePath, config: { mimeType: 'video/mp4' } })
  let f = file
  const deadline = Date.now() + 5 * 60_000
  // FAST POLLING: check every 2s so the pipeline moves the moment the file is ACTIVE.
  while (f.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new GeminiError('other', 'File processing timed out')
    await new Promise((r) => setTimeout(r, 2000))
    f = await ai.files.get({ name: f.name! })
  }
  if (f.state !== 'ACTIVE') throw new GeminiError('other', `File upload failed (state=${f.state})`)
  return { uri: f.uri!, name: f.name! }
}

export async function deleteFileQuiet(ai: GoogleGenAI, name: string) {
  try {
    await ai.files.delete({ name })
  } catch {
    // best effort
  }
}

export function classifyError(err: unknown): GeminiError {
  if (err instanceof GeminiError) return err
  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  // Model retired / not accessible for this API key — permanently remove from pool for the day.
  if (
    lower.includes('no longer available') ||
    (lower.includes('404') && (lower.includes('not found') || lower.includes('models/')))
  ) {
    return new GeminiError('unavailable', msg)
  }
  const is429 =
    lower.includes('429') || lower.includes('resource_exhausted') || lower.includes('quota') || lower.includes('rate limit')
  if (is429) {
    // Distinguish daily quota (RPD) from per-minute (RPM/TPM) limits from the message.
    if (
      lower.includes('perday') ||
      lower.includes('per day') ||
      lower.includes('daily') ||
      lower.includes('requests per day') ||
      lower.includes('generaterequestsperday')
    ) {
      return new GeminiError('rpd', msg)
    }
    return new GeminiError('rate', msg)
  }
  return new GeminiError('other', msg)
}

/** The ONE prompt sent for EVERY movie chunk (word-for-word from data/experiment-prompt.md). */
export const CHUNK_MAP_PROMPT = `You are a forensic video analyst. You are given TWO videos:
- Video 1: a SHORT VIDEO that was edited together from clips of a movie.
- Video 2: a ONE-MINUTE CHUNK cut from the original movie.

Both videos are exactly 24 fps. Analyze them frame by frame at 24 fps precision.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly TWO parts:

=====================
HISSA 1 — SHORT VIDEO TIME MAP
=====================
Watch Video 1 from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar segments 1 second ya usse kam ke hone chahiye. Ek lambi continuous shot ko bhi chhote sub-segments me todo taaki mapping precise rahe.
- Segments contiguous hone chahiye: har segment ka start = pichle segment ka end. Pehla segment 00:00.000 se shuru ho, aakhri segment video ki total duration par khatam ho. Koi gap nahi, koi overlap nahi.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames): <SHORT description, max 10-12 words — kaun kya kar raha hai; agar koi bolta hai to sirf exact quoted words>
- Description LAMBA MAT karo — output token budget limited hai. Sirf identify karne layak minimum detail + exact dialogue quote.
- Frame numbers = timestamp x 24 (24 fps). Timestamps millisecond precision me, frame boundaries 1/24s (0.0417s) steps par aligned.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

=====================
HISSA 2 — MOVIE MAP TIME
=====================
Ab HISSA 1 ke HAR EK segment ke liye Video 2 (movie chunk) me EXACT wahi footage dhundho (same recording, frame for frame — sirf similar scene nahi).

STRICT RULES:
1. 1:1 SAME-DURATION MAPPING (sabse important rule): Har short segment ka movie me matched window EXACTLY utni hi duration ka hona chahiye. Agar short segment 0.417s ka hai, to movie window bhi 0.417s ka hoga — na kam, na zyada. (movie_end - movie_start) MUST equal (short_end - short_start). Kabhi bhi ek chhote short segment ko movie ke bade 5-10 second block par map mat karo.
2. HAR SEGMENT KI APNI LINE: Har short segment ke liye alag mapping line likho. Kai segments ko ek saath ek badi range me merge mat karo (consecutive NOT FOUND segments ko ek line me group karna allowed hai).
3. Movie timestamps Video 2 ki APNI clock se aane chahiye (00:00.000 se ~01:00.000) — frames ko actually dekh kar. Short video ke timestamps copy karke movie column me daalna FORBIDDEN hai jab tak tumne wahi frames Video 2 me us position par khud verify na kiye hon.
4. NO EXTRAPOLATION (CRITICAL): Ek baar offset mil jane ke baad "short_time + offset" formula se aage ke segments AUTOMATICALLY map karna STRICTLY FORBIDDEN hai. Ye sabse common galti hai. Har naye segment ke liye Video 2 ke actual frames FIR SE dekho aur independently verify karo. Agar tum notice karo ki tumhare consecutive mappings ek fixed offset follow kar rahe hain (e.g. har match exactly +3.000s par), to RUK JAO aur har ek ko dobara verify karo — ye extrapolation drift ka signal hai, real matching ka nahi.
5. DIALOGUE AUDIO VERIFICATION: Agar short segment me koi dialogue hai, to matched movie window me WAHI EXACT dialogue Video 2 ke audio me us position par actually SUNAI dena chahiye. Agar us movie window me wo words sunai nahi dete, to match INVALID hai — NOT FOUND likho. Bina dialogue verify kiye dialogue-wale segment ko map karna FORBIDDEN hai.
6. CHUNK KA END = FOOTAGE KA END: Ye chunk poori movie ka sirf ek 1-minute tukda hai. Short video ka content is chunk ke END par cut ho sakta hai — uske baad ke short segments AGLE chunk me hain, is chunk me NAHI. Agar tumhara matched footage Video 2 ke end ke paas khatam ho raha hai, to baaki bache short segments ko zabardasti aakhri seconds me squeeze mat karo — unhe NOT FOUND likho. Suspicious sign: agar tumhara last match exactly Video 2 ke end (~01:00.000) par khatam hota hai, to bahut dhyan se verify karo.
7. NOT FOUND: Agar koi short segment is movie chunk ke andar NAHI milta, to clearly likho "NOT FOUND — ye scene is movie chunk ke andar nahi hai". Bahut se segments milenge hi nahi — ye NORMAL aur EXPECTED hai. Zabardasti match banana false positive hai, jo miss karne se bahut zyada bura hai. SIMILAR IS NOT SAME — same actors/location par different moment = NOT FOUND. Ek naya scene short me shuru hua hai iska matlab ye NAHI ki wo is chunk me continue hota hai.
8. Movie ke andar segments ka order short video ke order se alag ho sakta hai (short video edited hai) — har segment independently dhundho.
9. FINAL SELF-CHECK: Answer dene se pehle apne saare matches dobara scan karo. Jo bhi match sirf "pichle match ke baad aata hai isliye" bana hai (frame evidence ke bina), use NOT FOUND me badlo.

Har matched line ka format:
  Short mm:ss.mmm - mm:ss.mmm --> Movie mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames)

Na milne par:
  Short mm:ss.mmm - mm:ss.mmm --> NOT FOUND — <chhota reason>

Poore answer me sirf HISSA 1 aur HISSA 2 do, aur kuch nahi.`

// ---------- Gemini Minute Finder (20-minute window pre-scan) ----------

/** Model ids allowed for the minute finder — exactly the three chunk-map models. */
export const MINUTE_FINDER_SHORT_FPS = 5

/** Window version of the chunk-map prompt. `{{WINDOW_START}}` / `{{WINDOW_END}}`
 * are replaced per window (movie-copy clock, mm:ss). Goal: RECALL — which MINUTES
 * of the movie hold the short's footage; the 24 fps chunk scan verifies later. */
export const MINUTE_FINDER_PROMPT = `You are a forensic video analyst. You are given TWO videos:
- Video 1: a SHORT VIDEO that was edited together from clips of a movie (sampled at 5 fps).
- Video 2: a 20-MINUTE WINDOW of the original movie, covering movie time {{WINDOW_START}} to {{WINDOW_END}} (sampled at 1 fps).

Tumhara kaam frame-perfect mapping NAHI hai. Tumhara kaam ye batana hai ki Video 1 ke kaun se scenes Video 2 ke andar hain, aur movie ke KAUN SE MINUTE(S) par hain — taaki agla step un minutes ko 24 fps par frame-by-frame check kar sake.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly THREE parts:

=====================
HISSA 1 — SHORT VIDEO SCENE MAP
=====================
Watch Video 1 from start to finish and break it into SCENES (shot/scene changes par cut karo):
- Har scene 1 se ~10 second ka ho. Jab bhi location, camera setup, ya action clearly badle to naya scene shuru karo. Ek lambi continuous shot ko bhi 5-6 second ke tukdon me todo.
- Scenes contiguous hone chahiye: har scene ka start = pichle scene ka end. Pehla scene 00:00 se shuru ho, aakhri scene video ki total duration par khatam ho. Koi gap nahi, koi overlap nahi.
- Har line ka format:
  S<n>: mm:ss - mm:ss | <location + kaun kya kar raha hai, max 15 words> | DIALOGUE: "<exact quoted words>" ya NONE
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo. Agar audio mute/music se daba hua hai to DIALOGUE: MUTED likho.
- Description lambi mat karo — output token budget limited hai.

=====================
HISSA 2 — MOVIE LOCATION HUNT
=====================
Ab HISSA 1 ke HAR EK scene ke liye Video 2 (movie window) me EXACT wahi footage dhundho (same recording — sirf similar scene nahi).

Search method (har scene ke liye follow karo):
- PASS 1 (AUDIO LOCATE): Agar scene me dialogue hai, to sabse pehle Video 2 ke audio me wahi exact words dhundho. Dialogue sabse tez aur sabse reliable locator hai. Jahan words mile, us position ke frames dekho.
- PASS 2 (VISUAL LOCATE): Dialogue na ho (ya MUTED ho) to Video 2 ko shuru se aakhir tak scan karo aur wo jagah dhundho jahan same location + same actors + same costume + same action ho. Mile to +-5 second ke frames dekh kar confirm karo ki action ka ORDER bhi same hai.
- PASS 3 (CONFIRM): Match tab hi hai jab (a) dialogue words same hain YA (b) actions ka sequence same hai. Sirf "same actor, same location" MATCH nahi hai — wo alag moment ho sakta hai.

STRICT RULES:
1. Movie timestamps Video 2 ki APNI clock se aane chahiye — frames/audio ko actually dekh-sun kar. Short video ke timestamps copy karke movie column me daalna FORBIDDEN hai.
2. NO EXTRAPOLATION (CRITICAL): Ek scene ka offset mil jane ke baad "short_time + offset" formula se baaki scenes AUTOMATICALLY map karna STRICTLY FORBIDDEN hai. Short video EDITED hai — uske scenes movie me alag-alag jagah se, alag order me aa sakte hain. Har scene ko independently dhundho aur independently verify karo. Agar tumhare consecutive matches ek fixed offset follow kar rahe hain, RUK JAO aur har ek dobara verify karo.
3. DIALOGUE VERIFICATION: Dialogue wale scene ka match tab hi valid hai jab WAHI words Video 2 ke audio me us position par actually SUNAI dein. Words alag = NOT FOUND (ya POSSIBLE agar audio unclear ho).
4. QUALITY DIFFERENCE IS NOT DIFFERENT: crop, zoom, letterbox, aspect-ratio change, compression, blur, color-grade, brightness, watermark, text overlay, subtitles, added music, original audio replaced/muted, mirrored image, thoda speed-up/slow-down — ye sab IGNORE karo. Underlying footage same hai to wo MATCH hai. In wajahon se match reject karna FORBIDDEN hai.
5. WINDOW KA END = FOOTAGE KA END: Ye window poori movie ka sirf 20-minute tukda hai. Short ke bahut se scenes is window me honge hi NAHI — wo movie ke doosre hisse me hain. Ye NORMAL aur EXPECTED hai. Agar POORA short is window me na mile to saaf likho — zabardasti match banana FORBIDDEN hai.
6. SIMILAR IS NOT SAME: same actors, same location, same costume par DIFFERENT moment (alag dialogue, alag action) = NOT FOUND. Lekin agar tumhe strong shak hai ki footage yahi minute ke aas-paas hai par tum confirm nahi kar paaye (audio unclear, fast cuts, low fps), to use NOT FOUND mat likho — POSSIBLE likho with reason. POSSIBLE minutes agle step me 24 fps par check ho jayenge, isliye miss karne se behtar hai POSSIBLE dena.
7. Har scene ke liye movie ka minute do tarah likho:
   - WINDOW time: Video 2 ki apni clock (00:00 se 20:00)
   - MOVIE time: WINDOW time + {{WINDOW_START}} (absolute movie time)
   Agar Video 2 ka player/clock already absolute movie time dikha raha hai (e.g. {{WINDOW_START}} se shuru), to WINDOW aur MOVIE dono me wahi absolute time likho aur ek line me note karo: "CLOCK: absolute".
8. Ek short scene movie me EK jagah hi hoti hai. Agar tumhe do jagah lag rahi hain, to jo dialogue/action se zyada confirm hai use MATCH aur doosri ko POSSIBLE likho.
9. FINAL SELF-CHECK: Answer dene se pehle har MATCH dobara dekho — (a) kya dialogue ya action sequence sach me same hai? (b) kya movie timestamp Video 2 ki apni clock se aaya hai, formula se nahi? Jo match sirf "pichle match ke baad aata hai isliye" bana hai, use POSSIBLE ya NOT FOUND me badlo.

Har scene ki line ka format (teen me se ek):
  S<n> --> MATCH | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | EVIDENCE: <dialogue words jo sune / action jo dikha, max 15 words>
  S<n> --> POSSIBLE | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | REASON: <kya same laga, kya confirm nahi hua>
  S<n> --> NOT FOUND — <chhota reason: is window me ye scene nahi hai / alag moment hai>

=====================
HISSA 3 — MINUTE LIST (FINAL)
=====================
HISSA 2 ke saare MATCH aur POSSIBLE se movie ke minutes nikaalo (MOVIE time ke hisaab se, absolute). Har wo minute jisme matched footage ka koi bhi hissa aata hai, list me aayega (e.g. MOVIE 23:50 - 24:10 => minute 23 aur 24 dono).

Exact format, aur kuch nahi:
MATCH MINUTES: <comma separated minute numbers, ascending, e.g. 23, 24, 31> (ya NONE)
POSSIBLE MINUTES: <comma separated minute numbers> (ya NONE)
WINDOW VERDICT: FOUND (agar kam se kam ek MATCH) / POSSIBLE ONLY / NOT IN THIS WINDOW

Poore answer me sirf HISSA 1, HISSA 2 aur HISSA 3 do, aur kuch nahi.`

/** mm:ss (or h:mm:ss) for the prompt's window clock. */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** Fill the window placeholders (movie-copy clock, seconds). */
export function buildMinuteFinderPrompt(startOffsetSec: number, endOffsetSec: number): string {
  return MINUTE_FINDER_PROMPT.replaceAll('{{WINDOW_START}}', fmtClock(startOffsetSec)).replaceAll(
    '{{WINDOW_END}}',
    fmtClock(endOffsetSec),
  )
}

/** One minute-finder request: whole short @ 5 fps + one 20-minute movie window
 * (default 1 fps, selected with startOffset/endOffset on the SAME uploaded movie
 * copy). Same GEN_CONFIG as the chunk scan (thinking HIGH, max output tokens). */
export async function runMinuteFinderWindow(
  ai: GoogleGenAI,
  model: string,
  shortUri: string,
  movieUri: string,
  startOffsetSec: number,
  endOffsetSec: number,
): Promise<{ text: string; tokens: number | null }> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: MINUTE_FINDER_SHORT_FPS } },
            {
              fileData: { fileUri: movieUri, mimeType: 'video/mp4' },
              // NO fps here — default 1 fps for the movie window.
              videoMetadata: { startOffset: `${Math.floor(startOffsetSec)}s`, endOffset: `${Math.ceil(endOffsetSec)}s` },
            },
            { text: buildMinuteFinderPrompt(startOffsetSec, endOffsetSec) },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty minute-finder response')
    const tokens = resp.usageMetadata?.totalTokenCount ?? null
    return { text, tokens }
  } catch (err) {
    throw classifyError(err)
  }
}

// ---------------------------------------------------------------------------
// BACKUP MINUTE FINDER — second, focused pass (word-for-word from
// data/gemini-backup-minute-finder-prompt.md). Video 1 = concatenated clip of
// the short parts NO normal window matched, sampled at a HIGH fps; Video 2 =
// the same 20-minute movie window @ 1 fps.
// ---------------------------------------------------------------------------

/** Frame budget per request for the backup clip: fps = clamp(floor(900 / sec), 5, 24). */
export const BACKUP_FRAME_BUDGET = 900
export const BACKUP_MIN_FPS = 5
export const BACKUP_MAX_FPS = 24

export function backupClipFps(clipSeconds: number): number {
  const f = Math.floor(BACKUP_FRAME_BUDGET / Math.max(1, clipSeconds))
  return Math.min(BACKUP_MAX_FPS, Math.max(BACKUP_MIN_FPS, f))
}

export const BACKUP_MINUTE_FINDER_PROMPT = `You are a forensic video analyst doing a SECOND, FOCUSED search. You are given TWO videos:
- Video 1: a SHORT CLIP cut out of a short video. Ye short video movie ke clips se edit karke banaya gaya tha. Is clip me sirf wo hisse hain jo PEHLI search me movie ke KISI BHI hisse me nahi mile. Clip is sampled at {{CLIP_FPS}} fps (high), so you have many frames per second.
- Video 2: a 20-MINUTE WINDOW of the original movie, covering movie time {{WINDOW_START}} to {{WINDOW_END}} (sampled at 1 fps).

CLIP PART MAP (Video 1 ki apni clock 00:00 se shuru hoti hai; har PART short video ke asli time se aata hai; PARTS ke beech 1 second black + silence hai):
{{PART_MAP}}

CONTEXT FROM FIRST SEARCH (short ke baaki hisse movie me yahan mile the — ye sirf hint hai, is se koi timestamp CALCULATE mat karna):
{{FOUND_SUMMARY}}

Tumhara kaam frame-perfect mapping NAHI hai. Tumhara kaam ye batana hai ki Video 1 ke PARTS Video 2 ke andar hain ya nahi, aur hain to movie ke KAUN SE MINUTE(S) par — taaki agla step un minutes ko 24 fps par frame-by-frame check kar sake.

Ye clip pehli baar MISS hua tha. Iska matlab ye ho sakta hai: (a) footage movie me hai lekin fast cuts / chhote shots / dark scene / heavy crop ki wajah se pehli baar pakda nahi gaya, YA (b) ye footage movie ka hai hi nahi (text card, channel intro/outro, logo, doosri film ka footage). Dono possibilities kholi rakho. Zabardasti match banana FORBIDDEN hai, lekin genuine shak ho to POSSIBLE dena ZAROORI hai.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly THREE parts:

=====================
HISSA 1 — CLIP PART MAP (LIGHT)
=====================
Video 1 ko dekho. Har PART ke liye:
- PART ko 1 se max 3 scenes me todo. Agar poora PART ek hi continuous shot/scene hai to ek hi line likho. Chhote-chhote tukde banana ZAROORI NAHI hai.
- Do alag PARTS ko kabhi ek scene me merge mat karo — black frame par hamesha naya PART shuru hota hai.
- Har scene me clip time aur SHORT time (PART MAP se) dono likho.
- Har PART ka TYPE tag do: MOVIE-FOOTAGE (asli film ka shot dikh raha hai) / TEXT-CARD (sirf text/graphics) / LOGO-INTRO-OUTRO (channel branding) / NON-MOVIE (koi aur footage, vlog, reaction, etc.).
- Har line ka format:
  P<part>-S<n>: clip mm:ss - mm:ss | short mm:ss - mm:ss | TYPE: <tag> | <location + kaun kya kar raha hai, max 15 words> | DIALOGUE: "<exact quoted words>" ya NONE ya MUTED
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, exact words quote karo. Background music/SFX bhi note karo agar distinctive ho (e.g. "gunshot", "specific song").
- High fps hai isliye chhote details bhi note karo jo pehli baar miss ho sakte the: props, text on screen, costume detail, camera move, background objects.

=====================
HISSA 2 — DEEP MOVIE HUNT
=====================
HISSA 1 ke HAR EK scene ke liye Video 2 (movie window) me EXACT wahi footage dhundho (same recording — sirf similar scene nahi).

Search method (har scene ke liye follow karo, order me):
- PASS 1 (AUDIO LOCATE — primary): Video 2 ka audio 1 fps frames se ZYADA reliable hai kyunki audio poora hota hai. Dialogue ho to exact words dhundho. Dialogue na ho to distinctive music cue, SFX, ambient sound (crowd, rain, engine) dhundho. Jahan mile, us position ke +-10 second ke frames dekho.
- PASS 2 (VISUAL LOCATE): Video 2 ko shuru se aakhir tak scan karo — same location + same actors + same costume + same props. High-fps clip ke details (HISSA 1 me note kiye) ko movie frames me dhundho. Ye clip pehle miss hua tha, isliye DARK scenes, FAST-CUT sequences, CLOSE-UPS, aur heavily CROPPED shots ko extra dhyan se dekho — wahi sabse zyada miss hote hain.
- PASS 3 (CONFIRM): MATCH tab hi jab (a) dialogue words same hain YA (b) actions ka sequence same hai YA (c) distinctive audio cue + same visual setup dono milte hain. Sirf "same actor, same location" MATCH nahi — POSSIBLE ho sakta hai.

STRICT RULES:
1. Movie timestamps Video 2 ki APNI clock se — frames/audio actually dekh-sun kar. Clip time ya short time ko movie column me copy karna FORBIDDEN.
2. NO EXTRAPOLATION (CRITICAL): CONTEXT FROM FIRST SEARCH se ya kisi offset formula se movie time CALCULATE karna STRICTLY FORBIDDEN. Context sirf ye batata hai ki short ke aas-paas ke hisse kahan mile the — missing hissa kahin bhi ho sakta hai (short EDITED hai, order alag ho sakta hai). Agar context ke hint wali jagah check karo, to actually frames/audio dekh kar confirm karo — assume mat karo.
3. DIALOGUE VERIFICATION: Dialogue wale scene ka MATCH tab hi jab WAHI words Video 2 ke audio me us position par SUNAI dein. Words alag = NOT FOUND (ya POSSIBLE agar audio unclear).
4. QUALITY DIFFERENCE IS NOT DIFFERENT: crop, zoom, letterbox, aspect-ratio, compression, blur, color-grade, brightness, watermark, text overlay, subtitles, added music, original audio replaced/muted, mirrored image, speed change — IGNORE. Underlying footage same = MATCH. In wajahon se reject karna FORBIDDEN.
5. LOW-FPS MOVIE SIDE: Video 2 me 1 fps hai. Agar clip ka scene movie me sirf 1-3 frames me dikh raha hai lekin location + costume + audio cue match karte hain, to use NOT FOUND mat karo — POSSIBLE likho with reason "1fps par kam frames, audio/setup match". Agla step 24 fps par verify karega.
6. WINDOW KA END = FOOTAGE KA END: Ye poori movie ka sirf 20-minute tukda hai. Clip is window me na ho ye NORMAL aur EXPECTED hai — saaf likho NOT FOUND. Pehli baar miss hone ka matlab ye NAHI ki isi window me hona chahiye.
7. TEXT-CARD / LOGO / NON-MOVIE type PARTS ke liye movie me dhundhne ki koshish karo lekin agar clearly movie footage nahi hai to seedha NOT FOUND — "NON-MOVIE" reason ke saath. Zabardasti match mat banao.
8. SIMILAR IS NOT SAME: same actors, same location, same costume par DIFFERENT moment = NOT FOUND. Lekin strong shak + confirm nahi kar paaye = POSSIBLE with reason. Backup search me miss karna sabse bura hai — POSSIBLE dene me generous raho, MATCH dene me strict.
9. Har scene ke liye movie ka minute do tarah:
   - WINDOW time: Video 2 ki apni clock (00:00 se 20:00)
   - MOVIE time: WINDOW time + {{WINDOW_START}} (absolute)
   Agar Video 2 ka clock already absolute movie time dikha raha hai, to dono me wahi absolute time likho aur ek line me note karo: "CLOCK: absolute".
10. Ek clip scene movie me EK jagah hi hoti hai. Do jagah lage to zyada confirm wali MATCH, doosri POSSIBLE.
11. FINAL SELF-CHECK: har MATCH dobara dekho — (a) dialogue/action/audio-cue sach me same? (b) timestamp Video 2 ki clock se aaya, formula ya context-hint se nahi? Jo match sirf "context me aas-paas mila tha isliye" bana hai, use POSSIBLE ya NOT FOUND me badlo.

Har scene ki line ka format (teen me se ek) — SHORT time ZAROOR likho (clip time nahi):
  P<part>-S<n> --> MATCH | SHORT mm:ss - mm:ss | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | EVIDENCE: <dialogue words / action / audio cue, max 15 words>
  P<part>-S<n> --> POSSIBLE | SHORT mm:ss - mm:ss | WINDOW mm:ss - mm:ss | MOVIE mm:ss - mm:ss | REASON: <kya same laga, kya confirm nahi hua>
  P<part>-S<n> --> NOT FOUND — <chhota reason: is window me nahi / alag moment / NON-MOVIE>

=====================
HISSA 3 — MINUTE LIST (FINAL)
=====================
HISSA 2 ke saare MATCH aur POSSIBLE se movie ke minutes nikaalo (MOVIE time, absolute). Har wo minute jisme matched footage ka koi bhi hissa aata hai, list me aayega (e.g. MOVIE 23:50 - 24:10 => 23 aur 24 dono).

Exact format, aur kuch nahi:
  MATCH MINUTES: <comma separated minute numbers, ascending> (ya NONE)
  POSSIBLE MINUTES: <comma separated minute numbers> (ya NONE)
  PART STATUS: P1=<FOUND/POSSIBLE/NOT-HERE/NON-MOVIE>, P2=<...>, ...
  WINDOW VERDICT: FOUND (kam se kam ek MATCH) / POSSIBLE ONLY / NOT IN THIS WINDOW

Poore answer me sirf HISSA 1, HISSA 2 aur HISSA 3 do, aur kuch nahi.`

export interface BackupPartSpec {
  index: number
  clipStart: number
  clipEnd: number
  shortStart: number
  shortEnd: number
}

/** "PART 1: clip 00:00 - 00:30  =  short 01:00 - 01:30" lines for {{PART_MAP}}. */
export function buildPartMap(parts: BackupPartSpec[]): string {
  return parts
    .map((p) => `PART ${p.index}: clip ${fmtClock(p.clipStart)} - ${fmtClock(p.clipEnd)}  =  short ${fmtClock(p.shortStart)} - ${fmtClock(p.shortEnd)}`)
    .join('\n')
}

export function buildBackupMinuteFinderPrompt(
  startOffsetSec: number,
  endOffsetSec: number,
  clipFps: number,
  parts: BackupPartSpec[],
  foundSummary: string,
): string {
  return BACKUP_MINUTE_FINDER_PROMPT.replaceAll('{{WINDOW_START}}', fmtClock(startOffsetSec))
    .replaceAll('{{WINDOW_END}}', fmtClock(endOffsetSec))
    .replaceAll('{{CLIP_FPS}}', String(clipFps))
    .replaceAll('{{PART_MAP}}', buildPartMap(parts))
    .replaceAll('{{FOUND_SUMMARY}}', foundSummary.trim() || 'NONE')
}

/** One BACKUP request: concatenated missing-parts clip @ clipFps + one 20-minute
 * movie window (default 1 fps, startOffset/endOffset on the SAME movie upload). */
export async function runBackupMinuteFinderWindow(
  ai: GoogleGenAI,
  model: string,
  clipUri: string,
  movieUri: string,
  startOffsetSec: number,
  endOffsetSec: number,
  clipFps: number,
  parts: BackupPartSpec[],
  foundSummary: string,
): Promise<{ text: string; tokens: number | null }> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: clipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: clipFps } },
            {
              fileData: { fileUri: movieUri, mimeType: 'video/mp4' },
              videoMetadata: { startOffset: `${Math.floor(startOffsetSec)}s`, endOffset: `${Math.ceil(endOffsetSec)}s` },
            },
            { text: buildBackupMinuteFinderPrompt(startOffsetSec, endOffsetSec, clipFps, parts, foundSummary) },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty backup minute-finder response')
    const tokens = resp.usageMetadata?.totalTokenCount ?? null
    return { text, tokens }
  } catch (err) {
    throw classifyError(err)
  }
}

/** Parse "h:mm:ss(.mmm)" / "mm:ss(.mmm)" / "m:ss" into seconds. */
function parseTsFlexible(ts: string): number | null {
  const t = ts.trim()
  const m3 = t.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/)
  if (m3) return Number(m3[1]) * 3600 + Number(m3[2]) * 60 + Number(m3[3])
  const m2 = t.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (m2) return Number(m2[1]) * 60 + Number(m2[2])
  return null
}

export interface MinuteFinderHit {
  /** S number (normal) / S number within the part (backup) */
  scene: number
  /** "S3" (normal) or "P1-S2" (backup) */
  sceneId: string
  /** backup pass only: PART number this hit belongs to */
  part?: number
  kind: 'match' | 'possible'
  /** seconds within the SHORT video (from HISSA 1 / SHORT column), if resolvable */
  shortStart: number | null
  shortEnd: number | null
  /** seconds within the MOVIE COPY file (window offset already resolved) */
  fileStart: number
  fileEnd: number
  evidence: string
}

export interface MinuteFinderParse {
  hits: MinuteFinderHit[]
  matchMinutes: number[]
  possibleMinutes: number[]
  clockAbsolute: boolean
  /** backup pass only: TYPE tag per PART from HISSA 1 (P1 → "MOVIE-FOOTAGE" etc.) */
  partTypes?: Record<number, string>
  /** backup pass only: PART STATUS line from HISSA 3 (P1 → "FOUND" / "NOT-HERE" / "NON-MOVIE" ...) */
  partStatus?: Record<number, string>
}

/** Parse a BACKUP minute-finder response. Scene lines are `P<part>-S<n>`; the
 * short range comes from the SHORT column (HISSA 2), else the HISSA 1 `short`
 * column, else the clip time mapped through the part map. */
export function parseBackupMinuteFinderOutput(
  raw: string,
  startOffset: number,
  endOffset: number,
  assumeRelative: boolean,
  parts: BackupPartSpec[],
): MinuteFinderParse {
  return parseFinderGeneric(raw, startOffset, endOffset, assumeRelative, parts)
}

/**
 * Parse one minute-finder response into hits with MOVIE-COPY-file times.
 *
 * CLOCK RESOLUTION (relative vs absolute): the prompt asks for both a WINDOW
 * time (Video 2's own clock) and a MOVIE time (WINDOW + window start).
 *  - "CLOCK: absolute" in the output => WINDOW column is already file time.
 *  - WINDOW value inside [0, windowLen] => relative: file = startOffset + t.
 *  - WINDOW value inside [startOffset, endOffset] (beyond the window length)
 *    => the model reported file-absolute times despite the clip range.
 *  - Otherwise fall back to the MOVIE column when it lands inside the window.
 * `assumeRelative` is the default when the two readings are ambiguous
 * (window 0 — both are identical anyway).
 */
export function parseMinuteFinderOutput(
  raw: string,
  startOffset: number,
  endOffset: number,
  assumeRelative: boolean,
): MinuteFinderParse {
  return parseFinderGeneric(raw, startOffset, endOffset, assumeRelative, null)
}

/** Map a clip-clock range onto short time through the part map (backup pass). */
function clipToShort(parts: BackupPartSpec[], clipStart: number, clipEnd: number, preferPart?: number): { start: number; end: number } | null {
  const mid = (clipStart + clipEnd) / 2
  const p =
    (preferPart !== undefined ? parts.find((x) => x.index === preferPart) : undefined) ||
    parts.find((x) => mid >= x.clipStart - 0.5 && mid <= x.clipEnd + 0.5)
  if (!p) return null
  const off = p.shortStart - p.clipStart
  const s = Math.max(p.shortStart, clipStart + off)
  const e = Math.min(p.shortEnd, clipEnd + off)
  return e > s ? { start: s, end: e } : { start: p.shortStart, end: p.shortEnd }
}

function parseFinderGeneric(
  raw: string,
  startOffset: number,
  endOffset: number,
  assumeRelative: boolean,
  parts: BackupPartSpec[] | null,
): MinuteFinderParse {
  const windowLen = endOffset - startOffset
  const clockAbsolute = /CLOCK\s*:\s*absolute/i.test(raw)
  const backup = parts !== null
  const TSX = String.raw`(\d+:\d{1,2}(?::\d{1,2})?(?:\.\d+)?)`

  // HISSA 1 (normal): S<n>: mm:ss - mm:ss | ...
  // HISSA 1 (backup): P<p>-S<n>: clip mm:ss - mm:ss | short mm:ss - mm:ss | TYPE: <tag> | ...
  const shortMap = new Map<string, { start: number; end: number }>()
  const partTypes: Record<number, string> = {}
  const sceneRe = backup
    ? new RegExp(String.raw`^\s*P(\d+)\s*-\s*S(\d+)\s*:\s*(?:clip\s*)?${TSX}\s*-\s*${TSX}([^\n]*)`, 'gim')
    : new RegExp(String.raw`^\s*S(\d+)\s*:\s*${TSX}\s*-\s*${TSX}`, 'gim')
  let sm: RegExpExecArray | null
  while ((sm = sceneRe.exec(raw)) !== null) {
    if (backup) {
      const part = Number(sm[1])
      const id = `P${part}-S${sm[2]}`
      const rest = sm[5] || ''
      const shortCol = rest.match(new RegExp(String.raw`short\s*:?\s*${TSX}\s*-\s*${TSX}`, 'i'))
      let sw: { start: number; end: number } | null = null
      if (shortCol) {
        const s = parseTsFlexible(shortCol[1])
        const e = parseTsFlexible(shortCol[2])
        if (s !== null && e !== null && e > s) sw = { start: s, end: e }
      }
      if (!sw) {
        const cs = parseTsFlexible(sm[3])
        const ce = parseTsFlexible(sm[4])
        if (cs !== null && ce !== null && ce > cs) sw = clipToShort(parts!, cs, ce, part)
      }
      if (sw && !shortMap.has(id)) shortMap.set(id, sw)
      const type = rest.match(/TYPE\s*:\s*([A-Z][A-Z\-\s]*?)(?=\s*\||$)/i)?.[1]?.trim().toUpperCase()
      if (type && !partTypes[part]) partTypes[part] = type.replace(/\s+/g, '-')
    } else {
      const s = parseTsFlexible(sm[2])
      const e = parseTsFlexible(sm[3])
      if (s === null || e === null || e <= s) continue
      const id = `S${sm[1]}`
      if (!shortMap.has(id)) shortMap.set(id, { start: s, end: e })
    }
  }

  const inWindow = (t: number) => t >= startOffset - 5 && t <= endOffset + 5
  const inRelative = (t: number) => t >= -1 && t <= windowLen + 5
  const resolve = (win: number | null, mov: number | null): number | null => {
    if (win !== null) {
      if (clockAbsolute) return inWindow(win) ? win : inRelative(win) ? startOffset + win : null
      if (inRelative(win) && (assumeRelative || !inWindow(win) || startOffset === 0)) return startOffset + win
      if (inWindow(win)) return win
      if (inRelative(win)) return startOffset + win
    }
    if (mov !== null) {
      if (inWindow(mov)) return mov
      if (inRelative(mov)) return startOffset + mov
    }
    return null
  }

  // HISSA 2: S<n> --> MATCH | WINDOW a - b[, c - d, ...] | MOVIE e - f[, g - h, ...] | EVIDENCE: ...
  // The model may list SEVERAL ranges per scene (comma separated) when the same
  // short scene appears at multiple movie moments — every range becomes a hit.
  const hits: MinuteFinderHit[] = []
  const TS = TSX
  // Normal: "S3 --> MATCH | ..."; backup: "P1-S2 --> MATCH | SHORT a - b | ...".
  const hitRe = backup
    ? new RegExp(String.raw`P(\d+)\s*-\s*S(\d+)\s*-->\s*(MATCH|POSSIBLE)\b([^\n]*)`, 'gi')
    : new RegExp(String.raw`(?<![A-Z0-9-])S(\d+)\s*-->\s*(MATCH|POSSIBLE)\b([^\n]*)`, 'gi')
  // Whole column text up to the next "|" (so all comma-separated ranges are included).
  const winColRe = /WINDOW\s*:?\s*([^|\n]+)/i
  const movColRe = /MOVIE\s*:?\s*([^|\n]+)/i
  const shortColRe = /SHORT\s*:?\s*([^|\n]+)/i
  const rangeRe = new RegExp(String.raw`${TS}\s*(?:-|–|—|to)\s*${TS}`, 'gi')
  const evRe = /(?:EVIDENCE|REASON)\s*:\s*(.+)$/i
  const rangesIn = (col: string | undefined): Array<{ s: number | null; e: number | null }> => {
    if (!col) return []
    const out: Array<{ s: number | null; e: number | null }> = []
    for (const m of col.matchAll(rangeRe)) out.push({ s: parseTsFlexible(m[1]), e: parseTsFlexible(m[2]) })
    return out
  }
  let hm: RegExpExecArray | null
  while ((hm = hitRe.exec(raw)) !== null) {
    const part = backup ? Number(hm[1]) : undefined
    const scene = Number(backup ? hm[2] : hm[1])
    const kindStr = backup ? hm[3] : hm[2]
    const kind = kindStr.toUpperCase() === 'MATCH' ? 'match' : 'possible'
    const rest = (backup ? hm[4] : hm[3]) || ''
    const sceneId = backup ? `P${part}-S${scene}` : `S${scene}`
    const winRanges = rangesIn(rest.match(winColRe)?.[1])
    const movRanges = rangesIn(rest.match(movColRe)?.[1])
    const n = Math.max(winRanges.length, movRanges.length)
    if (n === 0) continue
    const evidence = (rest.match(evRe)?.[1] || '').trim().slice(0, 160)
    // Short range: SHORT column (backup) → HISSA 1 map → whole PART (backup).
    let sw: { start: number; end: number } | null = null
    if (backup) {
      const sr = rangesIn(rest.match(shortColRe)?.[1])[0]
      if (sr && sr.s !== null && sr.e !== null && sr.e > sr.s) sw = { start: sr.s, end: sr.e }
    }
    if (!sw) sw = shortMap.get(sceneId) || null
    if (!sw && backup) {
      const p = parts!.find((x) => x.index === part)
      if (p) sw = { start: p.shortStart, end: p.shortEnd }
    }
    for (let i = 0; i < n; i++) {
      // Pair WINDOW[i] with MOVIE[i]; if one column has fewer ranges, resolve from the other alone.
      const wr = winRanges[i]
      const mr = movRanges[i]
      const fs0 = resolve(wr?.s ?? null, mr?.s ?? null)
      const fe0 = resolve(wr?.e ?? null, mr?.e ?? null)
      if (fs0 === null || fe0 === null) continue
      const fileStart = Math.min(Math.max(startOffset, fs0), endOffset)
      const fileEnd = Math.min(Math.max(startOffset, fe0), endOffset)
      if (fileEnd < fileStart) continue
      hits.push({
        scene,
        sceneId,
        part,
        kind,
        shortStart: sw?.start ?? null,
        shortEnd: sw?.end ?? null,
        fileStart,
        fileEnd: Math.max(fileEnd, fileStart + 0.5),
        evidence,
      })
    }
  }

  // HISSA 3 fallback lists (movie-copy minutes as the model understood them).
  const listOf = (label: string): number[] => {
    const m = raw.match(new RegExp(String.raw`${label}\s*MINUTES\s*:\s*([^\n]+)`, 'i'))
    if (!m || /NONE/i.test(m[1])) return []
    return [...m[1].matchAll(/\d+/g)].map((x) => Number(x[0])).filter((n) => Number.isFinite(n))
  }
  const out: MinuteFinderParse = { hits, matchMinutes: listOf('MATCH'), possibleMinutes: listOf('POSSIBLE'), clockAbsolute }
  if (backup) {
    out.partTypes = partTypes
    // PART STATUS: P1=FOUND, P2=NOT-HERE, ...
    const ps = raw.match(/PART\s*STATUS\s*:\s*([^\n]+)/i)?.[1]
    if (ps) {
      const status: Record<number, string> = {}
      for (const m of ps.matchAll(/P(\d+)\s*=\s*<?([A-Z][A-Z\-]*)/gi)) status[Number(m[1])] = m[2].toUpperCase()
      out.partStatus = status
    }
  }
  return out
}

/** One chunk-map request: whole short video + one movie chunk, the SAME prompt every time.
 * Returns the raw model text (HISSA 1 + HISSA 2) — parsing happens separately. */
export async function mapChunkRequest(
  ai: GoogleGenAI,
  model: string,
  shortUri: string,
  chunkUri: string,
): Promise<string> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { text: CHUNK_MAP_PROMPT },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty model response')
    return text
  } catch (err) {
    throw classifyError(err)
  }
}

// ---------- Manual missing-scene finder ----------

export interface GapFinderPartSpec {
  id: number
  shortStart: number
  shortEnd: number
  clipStart: number
  clipEnd: number
}

function gapFinderPrompt(parts: GapFinderPartSpec[], chunkStart: number, chunkEnd: number): string {
  const partMap = parts.map((part) =>
    `P${part.id}: Video 1 clip ${formatPromptTs(part.clipStart)}-${formatPromptTs(part.clipEnd)} = short ${formatPromptTs(part.shortStart)}-${formatPromptTs(part.shortEnd)} = exact duration ${(part.shortEnd - part.shortStart).toFixed(3)}s`,
  ).join('\n')
  const chunkDuration = chunkEnd - chunkStart
  return `Tum ek strict forensic video matcher ho. Dono videos exact 24 fps par diye gaye hain. Tumhara kaam Video 1 ke HAR listed unresolved part ko Video 2 me independently aur exhaustively dhundhna hai.

VIDEO STRUCTURE
- Video 1 ek concatenated clip hai: short video ke sirf unresolved parts original order me jode gaye hain.
- Parts ke beech black/silent separator ho sakta hai. Separator footage ka hissa NAHI hai.
- Video 2 original movie ka ek cut chunk hai. Is uploaded file ki local clock 00:00.000 se ${formatPromptTs(chunkDuration)} tak hai.
- Original movie me is chunk ki location ${formatPromptTs(chunkStart)}-${formatPromptTs(chunkEnd)} hai, lekin output me MOVIE column ke liye SIRF uploaded Video 2 ki LOCAL clock likhni hai. Absolute time calculate mat karo; application baad me offset add karegi.

PART MAP
${partMap}

HAR PART KE LIYE YE SEARCH METHOD FOLLOW KARO
PASS 1 — PART FINGERPRINT:
- Exact spoken dialogue ko verbatim quote karo; summarize ya translate mat karo.
- Speaker order, pauses, distinctive music/SFX/ambient audio note karo.
- Action sequence, cuts, camera movement, framing, costume, props, readable text aur stable background objects note karo.

PASS 2 — EXHAUSTIVE MOVIE HUNT:
- Video 2 ko beginning se end tak scan karo. Har part ko alag search karo; ek part ka result doosre par assume mat karo.
- Pehle exact dialogue/audio cue locate karo, phir uske aas-paas frames confirm karo.
- Audio absent/replaced ho to exact action order aur stable visual fingerprints se locate karo.
- Dark scenes, fast cuts, close-ups, tiny inserts aur heavily cropped shots ko extra attention do; missing footage aksar yahin hoti hai.

PASS 3 — SAME-RECORDING CONFIRMATION:
MATCH tabhi hai jab underlying recording aur exact moment same ho. Strong proof me kam se kam ek ho:
(a) wahi verbatim dialogue/audio cue at that position;
(b) wahi distinctive actions same order me;
(c) multiple stable visual fingerprints plus same shot progression.
Sirf same actor, location, costume, generic action ya story moment MATCH nahi hai.

TRANSFORM TOLERANCE — IN WAJAHON SE TRUE MATCH REJECT MAT KARO
Crop, zoom, reframing, letterbox/aspect ratio, resolution, compression, blur, brightness/color grade, watermark, subtitles/text overlay, mirrored image, muted/replaced audio, added music, ya chhota speed change ignore karo jab underlying footage clearly same ho.

STRICT RULES
1. NO OFFSET EXTRAPOLATION: short time, part position, previous match, chunk location ya kisi formula se Video 2 timestamp guess/calculate karna forbidden hai. Frames/audio dekh kar Video 2 ki local clock read karo.
2. ONE-TO-ONE WINDOW: MATCH window ka duration PART MAP ki exact duration ke barabar rakho. Sirf matching sub-shot mat do; listed part ka poora corresponding movie window do.
3. DIALOGUE CHECK: Dialogue clear ho to same words Video 2 par sunai dene chahiye. Alag words = NOT_FOUND.
4. SIMILAR IS NOT SAME: same people/place ka different take ya nearby moment = NOT_FOUND.
5. NO FORCED MATCH: Is chunk me footage na hona normal hai. Vague, partial, coincidental ya uncertain evidence par NOT_FOUND do.
6. ONE RESULT PER PART: Har listed P id ke liye exactly ek final line do. Koi part omit ya duplicate mat karo.
7. FINAL SELF-CHECK: Har MATCH ko dobara verify karo: same recording? concrete evidence? local timestamp actually Video 2 se read kiya? duration exact? Inme se koi fail ho to NOT_FOUND me badlo.

Pehle analysis kar sakte ho, lekin response ke end me machine-readable FINAL RESULTS block zaroor do. Har part ke liye exactly one line:
MATCH P<id> | SHORT mm:ss.mmm-mm:ss.mmm | MOVIE mm:ss.mmm-mm:ss.mmm | EVIDENCE: <verbatim dialogue/audio/action/frame proof>
ya
NOT_FOUND P<id> | REASON: <concrete reason>

MOVIE values strictly Video 2 local range 00:00.000-${formatPromptTs(chunkDuration)} me honi chahiye. SHORT values PART MAP ke short range ko exactly repeat karein.`
}

function formatPromptTs(sec: number): string {
  const value = Math.max(0, sec)
  const minutes = Math.floor(value / 60)
  const rest = value - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`
}

export async function runGapFinderChunk(
  ai: GoogleGenAI,
  model: string,
  shortClipUri: string,
  movieChunkUri: string,
  parts: GapFinderPartSpec[],
  chunkStart: number,
  chunkEnd: number,
): Promise<{ text: string; tokens: number | null }> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [
          { fileData: { fileUri: shortClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
          { fileData: { fileUri: movieChunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
          { text: gapFinderPrompt(parts, chunkStart, chunkEnd) },
        ] as never,
      }],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty missing-scene finder response')
    return { text, tokens: resp.usageMetadata?.totalTokenCount ?? null }
  } catch (err) {
    throw classifyError(err)
  }
}

export function parseGapFinderOutput(raw: string, parts: GapFinderPartSpec[], chunkStart: number, chunkEnd: number) {
  const hits: Array<{ part: number; shortStart: number; shortEnd: number; movieStart: number; movieEnd: number; evidence: string }> = []
  const specs = new Map(parts.map((part) => [part.id, part]))
  const acceptedParts = new Set<number>()
  const chunkDuration = chunkEnd - chunkStart
  const finalResultsAt = raw.toUpperCase().lastIndexOf('FINAL RESULTS')
  const resultText = finalResultsAt >= 0 ? raw.slice(finalResultsAt) : raw
  const pattern = /MATCH\s+P(\d+)\s*\|\s*SHORT\s+([\d:.]+)\s*(?:-|–|—|to)\s*([\d:.]+)\s*\|\s*MOVIE\s+([\d:.]+)\s*(?:-|–|—|to)\s*([\d:.]+)\s*\|\s*EVIDENCE:\s*(.+)/gi
  for (const match of resultText.matchAll(pattern)) {
    const part = Number(match[1])
    const spec = specs.get(part)
    const reportedShortStart = parseTs(match[2])
    const reportedShortEnd = parseTs(match[3])
    const localMovieStart = parseTs(match[4])
    const localMovieEnd = parseTs(match[5])
    const evidence = match[6].trim().slice(0, 600)
    if (!spec || acceptedParts.has(part) || reportedShortStart === null || reportedShortEnd === null || localMovieStart === null || localMovieEnd === null) continue

    const targetDuration = spec.shortEnd - spec.shortStart
    const reportedMovieDuration = localMovieEnd - localMovieStart
    const durationTolerance = Math.max(0.25, targetDuration * 0.2)
    const shortClockMatches = Math.abs(reportedShortStart - spec.shortStart) <= 0.25 && Math.abs(reportedShortEnd - spec.shortEnd) <= 0.25
    const localClockValid = localMovieStart >= -0.05 && localMovieStart < chunkDuration && localMovieEnd <= chunkDuration + 0.25
    if (!shortClockMatches || targetDuration <= 0 || reportedMovieDuration <= 0 || !localClockValid) continue
    if (Math.abs(reportedMovieDuration - targetDuration) > durationTolerance) continue
    if (evidence.length < 16 || /\b(?:vague|similar scene|maybe|possibly|uncertain|appears to)\b/i.test(evidence)) continue

    const movieStart = chunkStart + Math.max(0, localMovieStart)
    const movieEnd = movieStart + targetDuration
    if (movieStart < chunkStart - 0.05 || movieEnd > chunkEnd + 0.05) continue
    acceptedParts.add(part)
    hits.push({
      part,
      shortStart: spec.shortStart,
      shortEnd: spec.shortEnd,
      movieStart,
      movieEnd,
      evidence,
    })
  }
  return hits
}

// ---------- Verifier (candidate confirmation) ----------

/** Special prompt for the VERIFIER: two tiny clips, decide SAME vs DIFFERENT.
 * Forces the model to WRITE EVIDENCE from both clips BEFORE giving a verdict,
 * so it cannot answer from a vague first impression (main source of false results). */
export const VERIFY_PROMPT = `You are a forensic video verifier. You are given TWO very short clips. Both are exactly 24 fps — compare them frame by frame at 24 fps precision.

- Video 1: ek segment jo ek SHORT VIDEO se kata gaya hai.
- Video 2: ek segment jo ek MOVIE se kata gaya hai.

SAWAL: Kya ye dono clips EXACT SAME footage hain — same recording, same moment, frame-for-frame?

Respond in Hinglish (Hindi written in Latin script). Dialogue hamesha VERBATIM quote karo, original language me.

Tumhara answer TEEN parts me hoga. Pehle EVIDENCE, phir COMPARE, phir VERDICT. Bina evidence likhe seedha verdict dena FORBIDDEN hai — yahi sabse badi galti hai jo false results deti hai.

=====================
STEP 1 — EVIDENCE (dono clips ko alag-alag dhyan se dekho)
=====================
CLIP 1 ke liye 2-4 short lines likho:
- Kya action ho raha hai (kaun kya karta hai, kis order me)
- Agar koi bolta hai: EXACT quoted words
- Shot/camera: close-up ya wide, camera static ya moving, koi cut hai to kahan
CLIP 2 ke liye bhi EXACTLY yahi 2-4 lines likho, independently — Clip 1 ki lines copy karke mat likho.

=====================
STEP 2 — COMPARE (point by point)
=====================
In anchors par dono clips ko compare karo, har ek ke aage MATCH / MISMATCH / N.A. likho:
- DIALOGUE: exact words + voice same? (sabse strong fingerprint — words alag = DIFFERENT, pakka. LEKIN: agar kisi clip me audio mute hai, music se dab gaya hai, ya words clearly sunai NAHI dete — to MISMATCH mat likho, N.A. likho aur ACTION/SHOT par judge karo)
- ACTION: same movements, same order, same timing?
- SHOT: same framing, same camera angle, same cuts on same beats? (crop/zoom ki wajah se framing tight/loose dikhna MISMATCH nahi hai — sirf ALAG camera angle/alag shot MISMATCH hai)
- BACKGROUND/DETAILS: same background elements, props, costume, lighting continuity?

=====================
STEP 3 — VERDICT (rules apply karo)
=====================
RULES:
1. SAME ka matlab: same RECORDING, same MOMENT — sirf same scene nahi. Visuals AUR audio dono se confirm karo.
2. SIMILAR IS NOT SAME: same actors, same location, same costume — lekin different take ya different moment (alag action, alag words, alag shot) = DIFFERENT.
3. QUALITY DIFFERENCE IS NOT DIFFERENT: crop, resize, zoom, letterbox/black bars, aspect-ratio change, compression artifacts, blur, color-grade, brightness, saturation/BW filter, watermark, text-overlay, subtitles, audio quality/background music added, original audio replaced ya muted, frame-rate wobble, duplicate/dropped frames, mirrored/flipped image — ye sab IGNORE karo. Underlying footage same ho to VERDICT SAME hi hoga, chahe quality kitni bhi alag ho. In cheezon ko DIFFERENT ka reason banana FORBIDDEN hai.
4. BOUNDARY TOLERANCE: dono clips ke start/end par misalignment ho sakta hai (ek clip doosri se ~0.5-1s aage/piche shifted, ya ek clip me thoda extra footage aage/piche). Sirf OVERLAPPING hisse ko judge karo. Agar overlap frame-for-frame same footage hai, to VERDICT SAME — "Clip 2 me shuru/end me extra frames hain" DIFFERENT ka reason NAHI hai.
5. DIFFERENT ke liye CONCRETE EVIDENCE zaroori hai: DIFFERENT sirf tab bolo jab tum kam se kam EK concrete, nameable difference de sako jo Step 2 ke kisi MISMATCH se aata ho (e.g. "dialogue words alag: 'X' vs 'Y'", "Clip 1 me wo uthta hai, Clip 2 me baitha rehta hai", "bilkul alag scene"). Vague feeling ("lag raha hai alag hai", "timing thodi off lagti hai") valid reason NAHI hai.
6. SAME ke liye bhi POSITIVE EVIDENCE zaroori hai: SAME sirf tab bolo jab Step 2 me DIALOGUE ya ACTION me se kam se kam ek clear MATCH ho + koi real MISMATCH na ho. "Koi difference nahi dikha" akela kaafi nahi hai agar tumne clips theek se dekhi hi nahi.
7. SPEED/PLAYBACK TOLERANCE: short video me footage thoda speed-up/slow-down, re-encoded, ya duplicate/dropped frames wala ho sakta hai. Isse action ki timing me chhota sa antar (~10-15%) aa sakta hai — ye DIFFERENT ka reason NAHI hai jab tak actions ka ORDER aur CONTENT same hai.
8. DECISION PROCEDURE (isi order me socho, yahi final hai):
   a) Step 2 me koi CONCRETE MISMATCH hai jo overlapping target window ke ANDAR hai (dialogue words alag, action alag, bilkul alag moment/scene)? → DIFFERENT.
   b) Koi mismatch nahi + DIALOGUE ya ACTION me kam se kam ek clear MATCH? → SAME.
   c) Poore Step 2 ke baad bhi tum EK BHI concrete, nameable mismatch NAHI likh paye? → verdict SAME hai. "Pakka nahi hun", "thoda alag lag raha hai", "quality kharab hai isliye confirm nahi kar sakta" jaise vague doubts DIFFERENT ka reason NAHI hain — DIFFERENT SIRF concrete evidence par milta hai. Ek SAHI match ko galti se DIFFERENT bolna utna hi bura hai jitna galat match ko SAME bolna.
9. SELF-CHECK: Verdict likhne se pehle apne Step 1 ke notes dobara padho. Kya tumhara verdict tumhare khud ke likhe evidence se consistent hai? Agar Step 2 me sab MATCH/N.A. hai lekin tum DIFFERENT likh rahe ho (ya koi real MISMATCH hai aur tum SAME likh rahe ho), to verdict galat hai — use theek karo. Ye bhi check karo ki tumhara har MISMATCH target window ke ANDAR ka hai — padding/boundary area ka mismatch count NAHI hota.

Answer ke END me EXACTLY ye do lines do (yahi format, aur kuch nahi in lines me):
VERDICT: SAME
ya
VERDICT: DIFFERENT
REASON: <ek chhoti line Hinglish me — Step 2 ke concrete evidence ke saath>`

/** Special prompt for a RESCAN: one failed short segment + the full 1-minute chunk it was claimed in.
 * Structured like the chunk-map prompt (HISSA 1 time map + HISSA 2 hunt) for maximum accuracy. */
export const RESCAN_PROMPT = `You are a forensic video analyst. You are given TWO videos:
- Video 1: ek chhota TARGET SEGMENT jo ek SHORT VIDEO se kata gaya hai.
- Video 2: ek ONE-MINUTE CHUNK jo original movie se kata gaya hai.

Both videos are exactly 24 fps. Analyze them frame by frame at 24 fps precision.

Respond in Hinglish (Hindi written in Latin script). Spoken dialogue must always be QUOTED VERBATIM in its original language.

Your answer has exactly TWO parts:

=====================
HISSA 1 — TARGET SEGMENT TIME MAP
=====================
Watch Video 1 from start to finish and break it into small, fine-grained segments:
- Har segment chhota hona chahiye — zyada tar 1 second ya usse kam. Ek continuous shot ko bhi chhote sub-segments me todo.
- Har line ka format:
  mm:ss.mmm - mm:ss.mmm (startFrame-endFrame frames): <SHORT description, max 10-12 words; agar koi bolta hai to sirf exact quoted words>
- Frame numbers = timestamp x 24 (24 fps). Timestamps millisecond precision me.
- Dialogue sabse strong fingerprint hai — kabhi summarize mat karo, hamesha exact words quote karo.

=====================
HISSA 2 — MOVIE CHUNK ME HUNT
=====================
Ab poora Video 2 shuru se aakhir tak frame-by-frame scan karke EXACT wahi footage dhundho jo Video 1 ka target hai (same recording, frame for frame — sirf similar scene nahi).

SEARCH STRATEGY (do-pass method — isi tarah dhundho):
- PASS 1 (LOCATE): Poora Video 2 shuru se aakhir tak scan karo aur har wo jagah note karo jahan target se milta-julta kuch dikhe — same location, same actors, ya (sabse strong) Video 1 ka DIALOGUE audio me sunai de. Dialogue sabse tez locator hai: pehle audio me exact words dhundho, phir us position ke frames dekho. Agar prompt me HINT diya gaya hai to sabse pehle HINT region check karo, phir bhi poora video scan karo.
- PASS 2 (CONFIRM + ALIGN): Har candidate location par frames ko Video 1 ke frames se side-by-side compare karo. Jo location confirm ho, wahan EXACT start/end boundaries frame-by-frame precision se set karo — START-FRAME ANCHOR method use karo: Video 1 ke TARGET ka sabse pehla distinct frame/visual event pehchano (e.g. "haath uthta hai", "cut to close-up", "pehla word bolna shuru"), Video 2 me EXACTLY wahi frame dhundho aur window ka start wahan set karo. End boundary bhi isi tarah aakhri distinct frame se align karo. Window ka pehla frame Video 1 ke pehle frame se align ho, aakhri frame aakhri se.

STRICT RULES:
1. Poora Video 2 shuru se aakhir tak scan karo. Koi shortcut nahi. Ek match milne ke baad bhi baaki video check karo — agar wahi footage do jagah ho to BEST frame-aligned window choose karo.
2. Matched window ki duration EXACTLY Video 1 ke target ki duration ke barabar honi chahiye — na kam, na zyada. EK EXCEPTION: agar target ka footage Video 2 ke bilkul START ya END par CUT ho jata hai (chunk boundary), to jitna hissa Video 2 me maujood hai wahi report karo — window chhoti hogi, ye valid hai.
3. Movie timestamps Video 2 ki APNI clock se aane chahiye (00:00.000 se ~01:00.000) — frames ko actually dekh kar. Video 1 ke timestamps copy karke daalna FORBIDDEN hai.
4. NO EXTRAPOLATION / NO GUESSING (CRITICAL): Kisi bhi formula, offset, ya andaze se timestamp banana STRICTLY FORBIDDEN hai. Sirf wahi window report karo jiske frames tumne Video 2 me khud dekhe aur verify kiye hain.
5. DIALOGUE AUDIO VERIFICATION: Agar Video 1 me koi dialogue hai, to matched window me WAHI EXACT dialogue Video 2 ke audio me us position par actually SUNAI dena chahiye. Words sunai nahi dete = match INVALID — NOT FOUND likho.
6. SIMILAR IS NOT SAME: same actors, same location, same costume par different moment ya different take = NOT FOUND.
7. QUALITY DIFFERENCE IS NOT DIFFERENT: crop, resize, zoom, letterbox/black bars, aspect-ratio change, compression, blur, color-grade, brightness, watermark, text-overlay, subtitles, added music, original audio replaced/muted, duplicate/dropped frames, mirrored image — ye sab IGNORE karo. Underlying footage same hai to wo MATCH hai. In wajahon se match reject karna FORBIDDEN hai.
7b. SPEED TOLERANCE: short video ka footage thoda speed-up/slow-down ho sakta hai (~10-15%) — isliye Video 2 me matched window ki duration target se thodi alag ho sakti hai. Actions ka ORDER aur CONTENT same hai to wo MATCH hai; boundaries frames se align karo, duration ke chhote antar se reject mat karo.
8. NOT FOUND: Agar target Video 2 me sach me NAHI hai, to saaf mana kar do. Zabardasti match banana false positive hai, jo miss karne se bahut zyada bura hai. Lekin NOT FOUND likhne se PEHLE confirm karo ki tumne PASS 1 me poora video (audio samet) scan kiya hai — jaldi me aadha video dekh kar NOT FOUND dena bhi utni hi badi galti hai.
9. FINAL SELF-CHECK: Answer dene se pehle apna MATCH dobara verify karo — (a) kya window ke frames aur audio sach me Video 1 ke target se frame-for-frame match karte hain? (b) kya start/end boundaries frame-accurate hain (aage-piche shift to nahi)? Agar frame evidence nahi hai, to NOT FOUND me badlo.

HISSA 2 ke end me aakhri line EXACTLY is format me do (Video 2 ki apni clock par):
MATCH: mm:ss.mmm - mm:ss.mmm
ya
NOT FOUND — <chhota reason>

Poore answer me sirf HISSA 1 aur HISSA 2 do, aur kuch nahi.`

/** One verifier request: short-segment clip + movie-window clip, both @ 24 fps.
 * `paddingNote` (optional) is appended to the prompt when the clips were padded,
 * telling the model EXACTLY where the real target window sits inside each clip. */
export async function verifyRequest(
  ai: GoogleGenAI,
  model: string,
  shortClipUri: string,
  movieClipUri: string,
  paddingNote?: string,
): Promise<string> {
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: shortClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { fileData: { fileUri: movieClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { text: paddingNote ? `${VERIFY_PROMPT}\n${paddingNote}` : VERIFY_PROMPT },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty verifier response')
    return text
  } catch (err) {
    throw classifyError(err)
  }
}

/** One rescan request: failed short-segment clip + the full 1-minute chunk, both @ 24 fps.
 * `paddingNote` (optional) is appended when the segment clip was padded, telling the
 * model EXACTLY where the real target window sits inside Video 1.
 * `hintNote` (optional) points the model at the region the chunk-mapping originally
 * claimed — checked FIRST, but the full-video scan still always runs. */
export async function rescanRequest(
  ai: GoogleGenAI,
  model: string,
  segmentClipUri: string,
  chunkUri: string,
  paddingNote?: string,
  hintNote?: string,
): Promise<string> {
  try {
    const extras = [paddingNote, hintNote].filter(Boolean).join('\n')
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: segmentClipUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { fileData: { fileUri: chunkUri, mimeType: 'video/mp4' }, videoMetadata: { fps: SCAN_FPS } },
            { text: extras ? `${RESCAN_PROMPT}\n${extras}` : RESCAN_PROMPT },
          ] as never,
        },
      ],
      config: GEN_CONFIG,
    })
    const text = resp.text
    if (!text) throw new Error('Empty rescan response')
    return text
  } catch (err) {
    throw classifyError(err)
  }
}

/** Parse the verifier's answer. Returns null when no clear verdict was given.
 * The verdict/reason lines come at the END of the response (after the evidence
 * steps), so always take the LAST occurrence of each. */
export function parseVerdict(raw: string): { same: boolean; reason: string } | null {
  const verdicts = [...raw.matchAll(/VERDICT\s*:\s*(SAME|DIFFERENT)/gi)]
  if (verdicts.length === 0) return null
  const m = verdicts[verdicts.length - 1]
  const reasons = [...raw.matchAll(/REASON\s*:\s*(.+)/gi)]
  const r = reasons.length > 0 ? reasons[reasons.length - 1] : null
  return { same: m[1].toUpperCase() === 'SAME', reason: (r?.[1] || '').trim().slice(0, 300) }
}

/** Parse a rescan answer into a chunk-local window, or null for NOT FOUND / unparseable. */
export function parseRescanMatch(raw: string): { start: number; end: number } | null {
  if (/NOT\s*FOUND/i.test(raw) && !/MATCH\s*:/i.test(raw)) return null
  const m = raw.match(/MATCH\s*:\s*(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)/i)
  if (!m) return null
  const start = parseTs(m[1])
  const end = parseTs(m[2])
  if (start === null || end === null || end <= start) return null
  return { start, end }
}

/** Parse "mm:ss.mmm" (also tolerates "m:ss.mm" / "mm:ss") into seconds. */
function parseTs(ts: string): number | null {
  const m = ts.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/)
  if (!m) return null
  const sec = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(sec) ? sec : null
}

/** FALSE-RESULT DETECTOR for chunk-map outputs. Returns a reason string when
 * the output looks like a fabricated "same-2-same" A-to-Z mapping, else null.
 *
 * Signal 1 — NO "NOT FOUND" ANYWHERE: a real chunk-map answer almost always has
 * NOT FOUND lines (the chunk is only 1 minute of the whole movie). If Gemini's
 * output does not contain "NOT FOUND" even once, it mapped everything = false result.
 *
 * Signal 2 — FIXED-OFFSET EXTRAPOLATION: if every matched line follows the same
 * constant offset (movieStart - shortStart), the model broke prompt rule 4
 * (NO EXTRAPOLATION) and just applied "short_time + offset" A to Z. */
export function isSuspiciousChunkOutput(raw: string, matches: ChunkMatch[]): string | null {
  // Signal 1: not a single NOT FOUND line in the whole output.
  if (!/NOT\s*FOUND/i.test(raw)) {
    return 'output me kahin bhi NOT FOUND nahi hai — model ne sab kuch map kar diya (false result)'
  }
  // Signal 2: all matches share one fixed offset (extrapolation drift).
  if (matches.length >= 4) {
    const offsets = matches.map((m) => m.movieStart - m.shortStart)
    const min = Math.min(...offsets)
    const max = Math.max(...offsets)
    if (max - min < 0.25) {
      return `saare ${matches.length} matches ek hi fixed offset (+${min.toFixed(3)}s) par hain — extrapolated A-to-Z mapping (prompt rule 4 break)`
    }
  }
  return null
}

/** Parse the HISSA 2 lines of a chunk-map response into matches.
 * NOT FOUND lines are skipped; movie timestamps (chunk-local) are converted to
 * ABSOLUTE movie time using the chunk's start offset. */
export function parseChunkMatches(raw: string, chunkIndex: number, chunkOffsetSeconds: number, model: string): ChunkMatch[] {
  const out: ChunkMatch[] = []
  const re = /Short\s+(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)\s*-->\s*Movie\s+(\d+:\d+(?:\.\d+)?)\s*-\s*(\d+:\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const shortStart = parseTs(m[1])
    const shortEnd = parseTs(m[2])
    const movieLocalStart = parseTs(m[3])
    const movieLocalEnd = parseTs(m[4])
    if (shortStart === null || shortEnd === null || movieLocalStart === null || movieLocalEnd === null) continue
    if (shortEnd <= shortStart || movieLocalEnd <= movieLocalStart) continue
    out.push({
      shortStart,
      shortEnd,
      movieStart: chunkOffsetSeconds + movieLocalStart,
      movieEnd: chunkOffsetSeconds + movieLocalEnd,
      chunkIndex,
      model,
    })
  }
  return out
}
