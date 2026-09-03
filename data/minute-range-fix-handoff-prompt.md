# HANDOFF PROMPT — Minute Finder chunk selection bug (min..max range → exact minute list)

Ye prompt agle AI ke liye hai. Sirf EK problem fix karni hai. Koi aur cheez mat chhedo.

---

## 1. Problem kya hai (real run se proof)

Gemini Minute Finder ne 20-minute windows scan karke ye movie minutes bataye:
`7, 8, 9, 10, 11, 12, 13, 21, 22, 23, 24, 33, 34, 35, 38, 39, 40, 41, 66, 67, 68, 69, 70, 71, 72, 73, 74` (27 minutes).

UI ne bola: "chunk scan sirf inhi par". Lekin actual chunk scan **83 chunks** par chala (chunk 6 se 74 tak lagataar, sab).

Log se count:
- Short Minute 1 (0:00–1:00) → chunks 65–74 scan hue (10 chunks) — theek.
- Short Minute 2 (1:00–2:00) → chunks **6 se 74 tak SAB** scan hue (69 chunks). Isme 42 chunks (6, 14–20, 25–32, 36, 37, 42–65) minute finder ki list me the hi nahi. Un 42 me se 39 me "no segments found", 2 (chunk 56, 62) ne false positive diye jo verifier ne reject kiya. Sirf chunk 16 me ek asli match mila.
- Result: ~72 bekaar Gemini calls + unke false positives ke verifier calls → poora daily quota (RPD) khatam, 51 minute scan time, 429/503 storm.

## 2. Root cause (exact code)

File: `lib/minute-ranges.ts`, function `applyApprovedMinutes()`:

```ts
// Range = min..max of approved minutes for this short minute, clamped to trim.
const rawStart = Math.min(...relevantMinutes) * 60
const rawEnd = (Math.max(...relevantMinutes) + 1) * 60
seg.movieRangeStart = start
seg.movieRangeEnd = end
```

Ye har short-minute ke liye approved movie-minutes ki **list** save nahi karta — sirf **sabse chhota aur sabse bada minute** leke unke beech ka **ek continuous range** bana deta hai.

Short Minute 2 ke liye relevant minutes the `[7..13, 21..24, 33..35, 38..41, 66..74]` → code ne `min=7-1=6, max=74` → range **6:00 → 75:00** → scheduler ne is range ke andar ke **saare 69 chunks** pending kar diye.

Scheduler side (`lib/scheduler.ts` line ~195, ~651, ~719) `chunkOverlapsSegRange(scan, seg, c.index)` use karta hai jo `lib/segment-range.ts` me sirf `movieRangeStart/End` ka continuous overlap check karta hai. Isliye gap wale chunks (14–65) bhi "in range" gine gaye.

## 3. Fix kya karna hai

**Goal:** Har short-minute ke liye chunk scan SIRF un movie chunks par chale jinka minute us short-minute ke liye minute-finder list me hai (±1 buffer already list me included hai). Beech ke gap wale chunks skip (status `cancelled`) hone chahiye.

### Step A — `lib/types.ts` (`ShortSegmentState`)

Ek naya optional field add karo, `movieRangeStart/End` ke paas:

```ts
/** PER-MINUTE exact movie-minute allow-list (ABSOLUTE original-movie minute
 *  numbers, e.g. [7,8,9,66,67]). When set, this short minute is scanned ONLY
 *  against chunks whose absolute minute is in this list — gaps between
 *  minutes are skipped. Takes priority over movieRangeStart/End. */
movieMinutes?: number[]
```

Note: `prefilterChunks?: number[]` already exist karta hai lekin wo TwelveLabs-only hai aur `lib/scheduler.ts` line ~193 me `if (!tlApiKey) delete seg.prefilterChunks` se hat jata hai — isliye use reuse MAT karo. Naya field banao.

### Step B — `lib/minute-ranges.ts` (`applyApprovedMinutes`)

`relevantMinutes` mil jaane ke baad:

1. `seg.movieMinutes = [...new Set(relevantMinutes)].sort((a,b)=>a-b)` save karo.
2. `movieRangeStart/End` ko **bhi** min..max se set rehne do (UI/backward-compat ke liye), lekin chunk selection ab `movieMinutes` se hogi.
3. Jab `relevantMinutes.length === 0` ho to `delete seg.movieMinutes` bhi karo (jaise `movieRangeStart/End` delete hote hain).
4. `rangeNotes` me minute list bhi likho, e.g. `minute 2 → movie minutes [7-13, 21-24, 33-35, 38-41, 66-74] (27 chunks)` — taaki log me saaf dikhe kitne chunks chalenge.

### Step C — `lib/segment-range.ts`

`chunkOverlapsSegRange()` ko update karo:

```ts
export function chunkOverlapsSegRange(scan, seg, chunkIndex): boolean {
  const w = chunkAbsWindow(scan, chunkIndex)
  // EXACT MINUTE LIST (Minute Finder) — takes priority over continuous range.
  if (Array.isArray(seg.movieMinutes) && seg.movieMinutes.length > 0) {
    const firstMin = Math.floor(w.start / 60)
    const lastMin = Math.floor((w.end - 0.001) / 60)
    for (let m = firstMin; m <= lastMin; m++) if (seg.movieMinutes.includes(m)) return true
    return false
  }
  const r = segMovieRange(scan, seg)
  return w.start < r.end && w.end > r.start
}
```

- `seg` ka type `Pick<ShortSegmentState, 'movieRangeStart' | 'movieRangeEnd' | 'movieMinutes'>` karo.
- Dhyan do: chunk absolute start = `trimStart + index*60`; agar trimStart 0 nahi hai to chunk do minutes ko touch kar sakta hai — isliye upar firstMin..lastMin loop hai.

### Step D — Callers check karo (koi change nahi chahiye agar Step C sahi hai, lekin verify karo)

- `lib/scheduler.ts` ~195, ~651, ~719: `chunkOverlapsSegRange(scan, seg, c.index)` — ab automatically list-based hoga. Confirm karo ki `seg` object poora `ShortSegmentState` pass ho raha hai (hai).
- `lib/scheduler.ts` ~820: `segMovieRange(scan, seg)` — sirf display/log ke liye hai; agar `movieMinutes` set hai to log me minute list dikhao, range nahi.
- `components/cmt/minute-select-panel.tsx` ~172, ~204 aur `app/api/scans/[id]/segments/route.ts` ~44–65, ~80: ye manual range edit karte hain. Jab user manually range set/clear kare to `delete seg.movieMinutes` bhi karo, warna manual range ignore ho jayega.
- Scan `save/persist` jahan bhi `shortSegments` serialize hota hai — `movieMinutes` plain number[] hai, JSON me seedha chala jayega, extra kaam nahi.

### Step E — UI text

`components/cmt/` me jo Auto Pipeline panel "chunk scan sirf inhi par" likhta hai, uske niche actual count dikhao: `Chunk scan: N chunks (list-based)` jahan N = union of all segs' movieMinutes ka size. Pehle ye jhooth bol raha tha.

## 4. Expected result after fix (same input par)

- Short Minute 1: chunks 65–74 → 10 chunks (same as before).
- Short Minute 2: chunks `6–13, 20–24, 32–35, 37–41, 65–74` → **~27 chunks** (69 nahi).
- Total chunk calls ≈ 37 instead of 83. Chunk 14–19, 25–31, 42–64 par ek bhi Gemini call nahi jaani chahiye.
- Log me `Minute 2 · Chunk 45: no segments found` jaisi lines bilkul nahi dikhni chahiye.

## 5. Test kaise karo

1. `applyApprovedMinutes` par ek unit-style check: `suggestions` me minutes `[7,8,66,67]` do, ek hi short window ke saath → `seg.movieMinutes` = `[7,8,66,67]`, aur `chunkOverlapsSegRange` chunk 30 ke liye `false`, chunk 7 aur 66 ke liye `true` return kare (trimStart = 0 maan ke).
2. Existing scan par Resume karke log check karo ki gap chunks `cancelled` status me hain aur scan nahi hote.
3. `pnpm exec tsc --noEmit` clean ho.

## 6. Kya NAHI karna

- Minute finder prompt / window logic mat chhedo.
- Verifier, rescan, render/export, duplicate-match handling — kuch mat chhedo. Ye sab alag issues hain, is task ka hissa nahi.
- `prefilterChunks` (TwelveLabs) ko touch mat karo.
- ±1 buffer minute finder me already add hota hai (`minutesFromWindow`) — dobara buffer mat lagao.
