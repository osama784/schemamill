# Kit — masters: the locked mark, the row cuts, the lockups, `schemamill studio`

Twelve files, all standalone, flat-fill, outlines-only, light+dark, one deletable `sm-bg` ground
rect each. Default wordmark = **squarecut** (the recommended treatment; `finish` and `stock` ship
in `../wordmark/`). Geometry provenance is checked by `_tooling/check.mjs` on every run.

| file | viewBox | what it is |
| --- | --- | --- |
| `mark-light.svg`, `mark-dark.svg` | `0 0 64 64` | the locked 3+3 mark (A3 "material language") |
| `mark-small-light.svg`, `mark-small-dark.svg` | `0 0 64 64` | the ≤32 px cut: 2 in / 2 out, A3's dressing carried (see *The small cut* below) |
| `mark-16-light.svg`, `mark-16-dark.svg` | `0 0 64 64` | the 16 px cut: the same 2 in / 2 out composition with every row edge on the 16 px grid (see *The 16 px cut* below) |
| `lockup-horizontal-light/dark.svg` | `0 0 480 128` | mark + wordmark, v3's layout |
| `lockup-stacked-light/dark.svg` | `0 0 280 200` | mark over wordmark, v3's layout |
| `studio-lockup-light/dark.svg` | `0 0 672 128` | mark + `schemamill studio` |

## The mark masters — byte/geometry check vs `shapes/a3-material-language/`

Regenerated from the kit's own vendored copy of the A3 arm (`_tooling/mark.mjs`, taken verbatim
from `shapes/_tooling/{lib-a,rails}.mjs`, `SHIP.a3 = 'rods'`), not copied, so the kit builds
standalone. Result of the on-disk comparison (`check.mjs`):

* **every `<path d>` is byte-equal** to the adopted `mark-light.svg` / `mark-dark.svg`
  (gate, canonical rows, accent = v3's strings; raw rods = the A3 `rods` builder);
* the files are **858 B / 857 B — the same byte counts as the adopted files**;
* the whole-document diff is **exactly** the id/class prefix: `ml-…` → `sm-…`
  (proved by substituting the prefix and getting an identical file). Nothing else differs:
  same `<title>`, same `role`/`aria-label`, same ground rect, same group order.

The adopted rail files remain the archival record; these masters are the kit's copy of the same
geometry under the kit's vocabulary. **No change to the mark was made in this pass.**

## Lockup maths (v3 carried over, with one written refinement)

`_tooling/lockups.mjs` reuses `03-the-chute/_tooling/build.mjs` v3's numbers unchanged:

* **horizontal 480×128** — mark ink **88** tall (scale 1.6923), wordmark **60/1000 em**,
  mark↔wordmark ink gap **0.44 em (26.4)**, baseline at **H/2 + 0.325 em (83.5)**, both outer ink
  margins equal. With the stock wordmark the margins come out at exactly **26.000** — i.e. this
  build reproduces v3's shipped layout to the millimetre (checked in `check.mjs`).
* **stacked 280×200** — wordmark **46/1000 em**, **20** units of ground top and bottom,
  **30**-unit ink gap, mark centred on its ink box (scale 1.8313).

One refinement vs v3, documented: the mark is centred **directly on its ink box**
(`tx = (W − inkW·S)/2 − inkX0·S`) instead of centring the 64-box and shifting by the ink offset.
Algebraically identical (both give `tx = 140 − 32.25·S` on the 280-wide stacked canvas); the new
form states what it means. No visual change.

Because the treated wordmark is ~3.3 units narrower at lockup scale (316.14 → 312.84 units of ink
at 60/1000 em), the *computed* margins are:
stock **26.000** · finish **27.949** · squarecut **27.649** (horizontal, both tones). Equality
between the two outer margins — v3's rule — holds in every build; the canvas stays 480.

## `schemamill studio` — layout and the second-word study

Layout: the horizontal lockup's system exactly (same mark scale, same 0.44 em mark gap, same
baseline rule, same 60/1000 em), with the qualifier following at a **0.5 em (30)** word gap and a
canvas of **672×128** (round for exports; margins 26.72 with the recommended treatment —
finish 27.02, stock 25.07). The canvas is fixed, so a wordmark flag-flip never changes it.

**Second-word treatment: Regular weight (400), same size, same ink.** Decided by rendering three
modes side by side (`_proof/studio-modes.png`, order weight / tone / small):

| mode | verdict |
| --- | --- |
| **weight** — Regular 400, same ink, same size | **shipped**: the qualifier reads lighter and subordinate without leaving the ink; survives at 240 px; keeps the lockup strictly ink + the mark's single warm accent |
| tone — Regular + secondary ink `#5f6469` / `#9b9fa4` | rejected: a third tonal value in a lockup whose whole discipline is one ink plus one warm accent; at small sizes the lighter grey starts to read as a disabled/link state |
| small — Medium at 0.88× | rejected: the qualifier loses its "second word" calm and starts to compete with the name |

Accent rule verified against the brief: **the only warm element in every lockup is the mark's
emitted row** (light `#a9522b`, dark `#c96a3b`); `studio` is pure ink — no accent anywhere in the
wordmark, in either colorway.

## Rendered behaviour (evidence, `_tooling/_proof/`)

* horizontal at 480 / 320 / 240 / 160 / 120 px, both tones (×2 nearest-neighbour strips:
  `truth-lockup-h-light/dark.png`) — **holds to 120 px wide**: the wordmark softens but reads,
  and the mark (chunky gate, three rods, one rust row) is untouched identity.
* stacked at 280 / 224 / 168 / 120 px wide (= 200 / 160 / 120 / 86 px tall):
  `truth-lockup-s-light/dark.png`.
* studio at 672 / 480 / 320 / 240 px: `truth-studio-light/dark.png`.
* mark at 512 · 256 · 64 · 40 · 32 · 16 px: `mark-<tone>-<size>.png`; the 16 px cut at 512 · 64 ·
  32 · 16 px: `mark-16-<tone>-<size>.png`; the two 2+2 cuts side by side at 16 · 20 · 24 · 32 · 40 px
  (decoded figures in `_proof/favicon-16.json`, strips `truth-favicon16-{light,dark}.png`).

**Known weakness carried over honestly:** the stacked lockup under-reads below ≈120 px of
rendered **height** (v3's recorded weakness #7) — visible in the 120-px-wide strip cell
(86 px tall), where the wordmark mushes. Use the horizontal lockup or the mark alone below that.
This pass did not change the stacked maths, so the weakness is unchanged.

## The small cut (2+2) — `mark-small-{light,dark}.svg`

The kit's second master, for sizes where six row strokes outrun the grid. Same 64-unit canvas, same
class vocabulary, same deletable ground rect; accent on the **lower** emitted row.

Row geometry is the variants round's `rows-2x2` table (`refinement/03-variants/_tooling/geometry.mjs`
→ `ROWSETS['rows-2x2']`), which was built to the shipped mark's own rules; the *dressing* is A3's,
carried by A3's own primitives:

| element | geometry |
| --- | --- |
| raw 1 | top 22.00 · x 7.0 → tip 22.5 · bar 6.5 · square ragged start, **round leading cap r 3.25** |
| raw 2 | top 35.50 · x 12.0 → tip 20.0 · bar 6.5 · same dressing (the short stub) |
| emitted upper | top 22.5 · x 42.5 → 57.5 (overlaps the metal 0.5 so no seam can appear) |
| emitted lower — **accent** | top 35.0 · x 43 → 57.5, flush at the exit face |
| gate | v3's path, byte-equal (`M24 6 H43 V58 …`) |
| accent row choice | the **lower** row: it pairs the short raw stub, exactly as the shipped mark pairs its own (master raw 28.0 ↔ accent 28.75; here raw 35.5 ↔ accent 35.0). The variants round decided this on rendered evidence; `accentRow 0` flips it in one place |
| dressing rule | A3 pulled its row 1 back from v3's square end (a cap there would have crowded the throat wall). No such pull-back is needed here — measured clearance 7.07 / 9.13 units — so the plain rule applies: **the rod's tip sits exactly where the square end sat; the arc junction is tip − 3.25** |

Provenance is machine-checked, not asserted (`check.mjs`, section 7): `rod()` reproduces A3's
adopted raw rows byte-for-byte (one code path for both cuts — the refactor changed no geometry);
the gate and the emitted rows are byte-equal to the v3/2+2 tables; zero numbers off the 0.25 grid;
raw clearance 7.07 / 9.13 u against the feature floor of 1.5 (the master's own tightest figure is
4.74); worst-case ink radius **28.23** of 32 u at (43, 6) — 3.77 u (11.8 %) of margin inside a
circle crop, against the master's 29.97.

### Dual-cut evidence — decoded true pixels, not eyeballed

Renders at 16 / 20 / 24 / 32 / 40 px, both cuts and both tones (`_tooling/_proof/duo-*.png`), decoded by
`_tooling/png.mjs`; `mush` = partial-coverage pixels per solid ink pixel (this build's definition —
nearest-palette-value classification with a 12-per-channel solidity tolerance); `components` =
connected ink masses; `raw column` = the vertical ink/ground run profile through the raw side.

| size | cut | mush | ink px | components | raw column |
| --- | --- | --- | --- | --- | --- |
| 16 px | 3+3 master | 1.500 | 42 | 3 | `.4 #2 .1 #2 .1 #2 .4` |
| 16 px | **2+2 small cut** | **1.476** | **39** | 3 | `.5 #3 .1 #2 .5` |
| 20 px | 3+3 master | **0.520** | 90 | 4 | `.5 #2 .1 #3 .2 #2 .5` |
| 20 px | 2+2 small cut | 0.581 | 78 | 3 | `.7 #2 .2 #3 .6` |
| 24 px | 3+3 master | **0.686** | 129 | 4 | `.6 #3 .1 #3 .2 #3 .6` |
| 24 px | 2+2 small cut | 0.779 | 109 | 3 | `.8 #3 .2 #3 .8` |
| 32 px | 3+3 master | 0.465 | 242 | 4 | `.8 #4 .2 #4 .3 #4 .7` |
| 32 px | **2+2 small cut** | **0.407** | 219 | 3 | `.11 #4 .2 #4 .11` |
| 40 px | 3+3 master | 0.284 | 411 | 4 | `.9 #5 .3 #5 .4 #5 .9` |
| 40 px | **2+2 small cut** | **0.224** | 370 | 3 | `.13 #5 .4 #5 .13` |

Both tones measure identically at every size (the geometry and the palette are symmetric), so the
table is one story, not two. Strips: `python3 strip.py duo` (`_proof/truth-duo-*-{16,20,24,32,40}.png`, ×6); the raw JSON is
`_proof/dual-cut.json`.

**Verdict — measured, not assumed, and reported against the metric.**

*Structural, and consistent across every size:* the small cut puts four row strokes on the grid
instead of six (7 % less inked area at 16 px), keeps more air between the raw stubs (1.75 u of gap
against the master's 1.44 / 1.81), and fuses into one fewer ink mass (3 components instead of 4 from
24 px up). That is the dual cut's case, and it does not depend on the pixel grid.

*Per-pixel, and not consistent:* the mush score is a wash at 16 px (1.476 vs 1.500), **worse** at
20 and 24 px (0.581 vs 0.520; 0.779 vs 0.686) and clearly better at 32 and 40 px (0.407 vs 0.465;
0.224 vs 0.284). It oscillates because it is dominated by where the 6.5-unit rows land on the pixel
grid — at 20/24 px the master's rows happen to straddle boundaries more kindly. So the mush metric
cannot carry the claim on its own, and this kit does not quote it as if it could.

What that means for the rule: **≤ 32 px → the small cut, ≥ 40 px → the master** stands on structure
below 40 px and on richness at ≥ 64 px, not on a crispness win at 16 px — and, since this pass,
**exactly 16 px has its own cut** (*The 16 px cut*, below), which is where the crispness claim can
honestly be made. What the measurements do
**not** support is the stronger claim that the master is broken at 16 px: it was always a reduction.
(`shapes/_verify/` recorded the same independently for A3 at 16 px: “parity” with the baseline; the
variants round's “genuinely cleaner at 16 px” is a *structural* reading, and that is what the
decoded figures here confirm.)

### Known weaknesses of the small cut (honest)

1. **The 16 px gain is structural and modest** — four row strokes instead of six, wider raw gaps,
   one fewer fused mass — and the per-pixel mush metric is a wash at 16 px and *against* the cut at
   20–24 px. Anyone quoting this cut as “sharper at 16 px” is quoting something the pixels do not
   say; the honest claim is “fewer, better-separated strokes on the same grid”.
2. **At 16 px the emitted pair can lose its gap**: the two emitted rows are 1.5 px apart, and at that
   size no *whole* pixel of ground survives between them (measured `emitGaps 0`), so the warm row is
   distinguished by colour rather than by air. The master's equivalent 1.5 px emitted gaps happen to
   keep half a ground pixel at 16 px — grid luck, identical geometry, not a design difference.
   **Since this pass the kit does not ship the small cut at 16 px** (the 16 px cut below is the
   favicon at that size, and it restores `emitGaps 1` there); the figure stands as the small cut's
   own 16 px behaviour.
3. **More than one cut is drift risk.** Mitigated: all three cuts come from one code path, `check.mjs`
   fails on any path drift, and they all carry the same gate bytes and the same 64-unit ink box, so
   they interchange in a layout.
4. **The accent moves.** In the 2+2 cut the warm row is the lower emitted row, not the middle one;
   any asset that mixes the two cuts must not imply the accent is "the middle row".
5. **Favicon-first is not pixel-snapped.** The cut is a *geometry* answer to 16 px, not a hinting
   pass: rows are still 6.5 u with quarter-unit coordinates, so at 16 px the edges remain soft by
   construction (the round's recorded framing finding). *This pass built the pixel-snapped exercise
   as a separate 16 px art — see The 16 px cut below; the small cut itself is unchanged and still
   holds 20–32 px.*

## The 16 px cut (16 px rows) — `mark-16-{light,dark}.svg`

**The finding this answers.** The visual review's weakest surface was the true 16 px favicon: the
small cut's rows are 6.5 u = 1.625 px there, so both row edges land on half-pixels and the light-tone
raster renders as partial / solid / partial striped rows (legible — the gate edge stays crisp — but
not pristine). 32 px was fine.

**The fix, kept.** A third row table over the same primitives (`_tooling/small.mjs` → `SMALL16`,
built by `rod()` + `rectPath()`, the same gate string): the same 2 in / 2 out composition, the same
64-unit canvas, the same ink box, the same dressing — with every row edge on a multiple of 4 units,
which is exactly a pixel boundary at 16 px (1 u = 0.25 px).

| element | geometry | small cut (for comparison) |
| --- | --- | --- |
| raw 1 | top 20 · x 7.0 → tip 22.5 · bar 8 · square ragged start, round leading cap r 4 | top 22.0 · bar 6.5 · r 3.25 |
| raw 2 | top 36 · x 12.0 → tip 20.0 · bar 8 · same dressing (the short stub) | top 35.5 |
| emitted upper | top 20 · x 42.5 → 57.5 (overlaps the metal 0.5 so no seam can appear) · bar 8 | top 22.5 · bar 6.5 |
| emitted lower — **accent** | top 36 · x 43 → 57.5, flush at the exit face · bar 8 | top 35.0 |
| gate | v3's path, byte-equal | same |
| accent row choice | the **lower** row, exactly on the short raw stub's top line (36 ↔ 36) | lower row, 0.5 above the stub (35.0 ↔ 35.5) |
| dropped from the small cut | the raw band's +1.0 height and the 0.5 off-canonical-grid offset — 0.125 px at 16 px, invisible, and they would break the grid | — |

Machine-checked like the other two cuts (`check.mjs` §7b): 0 numbers off the 0.25 grid; raw-bar
clearance to the gate contour **6.23 / 8.28 u** (floor 1.5; the small cut's 7.07 / 9.13); worst-case
ink radius **28.23** of 32 u at (43, 6) — the small cut's figure exactly; same ink box as the master
(7 → 57.5 × 6 → 58), so all three cuts interchange in a layout.

### The measurement, before and after (decoded true pixels)

`_tooling/_proof/favicon-16.json` (build §5b), strips `python3 strip.py favicon16` →
`truth-favicon16-{light,dark}.png` (before over after, true 16 px, ×8). Row bands are read in units
(raw side 12 → 20, emitted side 44 → 56) so the gate's own anti-aliased edges cannot flatter the
figure; a *partial-only* row is a row in the band that holds no solid pixel.

| true size | cut | mush | partial px | ink px | partial-only rows (raw / emitted) | emitted-pair gap | coverage px |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16 px | small cut (shipped before) | 1.476 | 62 | 39 | 3 / 4 | 0 | 65.92 |
| 16 px | **16 px cut (shipped now)** | **0.769** | **40** | **46** | **0 / 0** | **1** | 69.95 |
| 20 px | small cut | **0.581** | 50 | 78 | 1 / 0 | 1 | 104.01 |
| 20 px | 16 px cut | 0.947 | 72 | 72 | 4 / 4 | 1 | 109.81 |
| 24 px | small cut | 0.779 | 88 | 109 | 4 / 3 | 0.67 | 151.20 |
| 24 px | 16 px cut | **0.758** | 94 | 116 | 4 / 4 | 0.67 | 158.93 |
| 32 px | small cut | 0.407 | 94 | 219 | 2 / 4 | 0.67 | 264.81 |
| 32 px | 16 px cut | **0.254** | 66 | 236 | **0 / 0** | 1 | 279.27 |
| 40 px | small cut | **0.224** | 91 | 370 | 4 / 1 | 1 | 419.78 |
| 40 px | 16 px cut | 0.292 | 122 | 382 | 4 / 4 | 1 | 441.96 |

Every tone-visible figure (mush, partial px, ink px, row patterns, column runs, gaps) is identical in
both tones — the geometry and the palette are symmetric, so the table is one story, not two. The
coverage figure is the light tone's: the accent hexes differ between colorways (#a9522b / #c96a3b),
so the ink↔ground projection moves about 4 % between tones even on identical geometry. The raw
column at 16 px reads `.5 #3 .1 #2 .5` before and `.5 #2 .2 #2 .5` now; the emitted column's four
partial-only rows are replaced by four solid rows.

**Why it was kept, against the stated criterion** (“clearly better at 16 px, no regression at 32 px”):
at true 16 px the mush score is halved (1.476 → 0.769), partial-coverage pixels drop 62 → 40, and
the **7 partial-only rows in the two row bands go to zero**; the emitted pair also regains a whole
ground pixel between the rows (`emitGaps` 0 → 1), so the warm row is separated by air and not only
by colour. At 32 px nothing regressed — the shipped favicon-32 is untouched (`masters/mark-small-*`
as before) and the new cut measures *better* there too (0.254 vs 0.407); it just is not used there.

**The price, stated:** the rows go from 1.625 px to 2 px, i.e. **+6.1 % ink coverage** at 16 px
(69.95 vs 65.92 coverage px; 46 vs 39 solid ink px) — a slightly bolder tile, and the measured cost
of landing on the grid. **20 px is the one size where the small cut measures crisper** (0.581 vs
0.947), and 40 px likewise (0.224 vs 0.292): the art is tuned for exactly one size and the kit uses
it at exactly one size. This is a *third* master, which the small cut's weakness #3 already flags as
drift risk — mitigated the same way: one code path over three row tables, `check.mjs` fails on any
drift between the builder and the shipped files, and the favicon's declared source is asserted
(`favicon-16` ← `mark-16`, `favicon-32` ← `mark-small`).

**Where it ships:** `exports/favicon/favicon-16-{light,dark}.png` and its `-transparent-` sibling;
the brand sheet §02/§07 and `review.html` §02 carry the before/after evidence.

### Known weakness of the 16 px cut (honest)

1. **Two ghost pixels in the transparent sibling.** `exports/favicon/favicon-16-transparent-{light,dark}.png`
   each carry exactly two pixels that are neither ground nor ink — at **(7,6) and (7,9)**, alpha 16/255,
   reading (32,32,48) in the light file and (255,255,255) in the dark. They are leftovers of the gate-taper
   anti-aliasing at the notch corners, invisible at any composite (the dot moves its background by at most
   16 of 255). Left as-is on purpose: the transparent exports are byte-asserted (manifest hashes, and the
   re-render equality in `check.mjs` / `verify-ondisk.mjs`), so touching the export geometry to erase two
   pixels nobody can see would invalidate verified byte claims for a zero visual gain.

## Build notes for this pass (both masters)

* **`toPathData` bug fixed at the source.** opentype.js 2.0.0 emits `NaN` for coordinates whose
  fractional part is a float epsilon (its rounding cache concatenates `"6.8e-14e+2"`). The tagline
  outlines hit it immediately (`LNaN 12`). `lib.mjs` now snaps every coordinate to the 2 decimals we
  ship before serialising (`snapPath`/`pathData`), which removes the epsilon and makes the emitted
  numbers the ones the geometry was measured with. Verified bit-for-bit: the 3+3 master, both
  horizontal lockups, the studio lockups and all six wordmark files are unchanged.
* **One measurement changed, and one transform with it.** The stacked lockup's mark scale is derived
  from the wordmark's ink height; measuring the *snapped* outlines (the bytes actually shipped)
  instead of the unsnapped ones moves that height by 0.006 u and the scale from 1.831231 to
  **1.831346** — a 0.0001 shift, invisible at any size, and the only shipped file whose bytes moved.
  The notes' quoted 1.8313 hold either way. `lockup-stacked-*.svg` was regenerated; nothing else.

## Rebuilding and verifying

```bash
cd _tooling
node build.mjs                    # masters (all three cuts) + wordmark + exports + pages + _proof renders
node build.mjs --wordmark finish  # rebuild with the conservative wordmark instead
node build.mjs --no-proof         # deliverables only (no _proof renders, no measurements json)
node check.mjs                    # 429 checks: builders, v3/A3 provenance, all three cuts' geometry,
                                  # exports ↔ manifest ↔ disk (incl. the transparent pairs), pages, determinism
node verify-ondisk.mjs            # re-render the shipped files and re-hash every export
python3 strip.py lockups          # magnified truth strips (also: duo | favicon16 | small | wordmark | comp)
```
