---
version: alpha
name: schemamill
description: Ink-on-paper studio for database schemas — monochrome ink, one warm accent on the mark's emitted row, hatch as the only attention device.
colors:
  # light colorway
  primary: '#1c1f23' # the ink — mark, wordmark, text
  paper: '#fbfaf6' # ground
  panel: '#efece4' # surface tint
  secondary: '#5f6469' # UI text
  faint: '#9b9fa4' # hairlines, disabled marks (never text)
  accent: '#a9522b' # the mark's emitted row (graphic value)
  # dark colorway
  primary-dark: '#fbfaf6' # the ink
  paper-dark: '#1c1f23' # ground
  secondary-dark: '#9b9fa4' # UI text
  faint-dark: '#5f6469' # hairlines, disabled marks (never text)
  accent-dark: '#c96a3b' # the mark's emitted row (graphic value)
omitted: [typography, components, spacing, rounded] # see Known Gaps
---

# schemamill — design conventions

## Overview

schemamill is a local-first studio for database schemas: one canonical model, a canvas to shape it,
import from DDL or a live database, semantic diffs, and hazard-annotated migration SQL. It never
writes to your database. The promise: **“schema change made boring.”**

The look is technical drafting, ink on paper: monochrome ink, emphasis by shape, weight and hatch —
never hue (`docs/design/README.md`) — with **one deliberate exception**: the mark's single warm rust
row. Temperament: **calm · precise · crafted**.

**How to use this file.** Read it before writing or reviewing any studio surface (UI code, assets,
visual docs). It is the source of truth for visual decisions: where another document, a tool default
or taste disagrees, this file wins — and a deliberate deviation is named where it happens (PR body,
review note), never silent. Terminology follows `CONTEXT.md`; this file never renames product
concepts. Where this file is silent, take the smallest decision consistent with calm · precise ·
crafted and record the rule here (see Iteration Guide). `AGENTS.md` points UI work here.

## Colors

The palette is exact and closed: a ground, an ink, an interface pair, and one accent that belongs to
the mark. No other hues. Token names: `primary` carries the one ink (the kit's `ink`); the `-dark`
tokens carry the dark colorway; never coin another name for the same value.

| token                | light     | dark      | use                                                   |
| -------------------- | --------- | --------- | ----------------------------------------------------- |
| `primary` — the ink  | `#1c1f23` | `#fbfaf6` | mark, wordmark, text                                  |
| `paper` — the ground | `#fbfaf6` | `#1c1f23` | sheets, README, documents / dark banners, dark covers |
| `accent`             | `#a9522b` | `#c96a3b` | the mark's emitted row only                           |
| `secondary`          | `#5f6469` | `#9b9fa4` | product UI text                                       |
| `faint`              | `#9b9fa4` | `#5f6469` | hairlines, disabled marks                             |
| `panel`              | `#efece4` | —         | UI surface tint (no dark value defined yet)           |

Measured contrasts — ink 15.84:1, both colorways; accent 5.12:1 / 4.42:1 (graphic values, not text);
secondary 5.72:1 / 6.21:1; faint 2.55:1 / 2.77:1 — below AA, **never text**; panel 14.01:1 against
ink. WCAG AA floor for normal text is 4.5:1.

- **One warm element per composition** — the emitted row; graphic only: never text, never a UI
  state or surface, never a second warm element. The wordmark and the `studio` qualifier are always
  pure ink.
- **Orthogonal to product semantics.** Rust never means “dangerous”, “added” or “error” — those
  meanings stay free for the product's own diff and hazard vocabulary. Diff add/remove and hazard
  annotation are carried by ink and hatch, never by color.
- The mark is a strict three-value system in both colorways: ground, ink, one warm row. Secondary,
  faint and panel belong to the interface; they never touch the mark.

## Logo & mark usage

The mark is locked: **A3 “material language”** — The Chute's composition with mill-finish round
leading ends on the raw bars. Material rule: **round rods in, square-cut stock out** — raw bars
arrive as stock (a 3.25-unit cap on the leading end, exactly half the 6.5-unit bar) and leave as
ruled rows, square and flush at the exit face.

- **The gate is one mass** (24 → 43 × 6 → 58, one closed outline). Never split it, outline it, or
  give it an inner seam; at 16 px that mass holds the composition together.
- The accent is the emitted row — the middle row in the 3+3 master, the lower row in the 2+2 cut
  (it pairs the short raw stub, exactly as the master pairs its own). Moving the accent into the
  gate was rendered and rejected twice.
- All cuts share the 64-unit canvas and the mark's ink box, so they interchange in a layout.

### Cuts — ship the right one at the right size

| rendered size | file                                             | cut                                                                           |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| exactly 16 px | `docs/brand/masters/mark-16-{light,dark}.svg`    | 2 in / 2 out, every row edge on the 16 px grid (bar 8 u = 2 px, tops 20 / 36) |
| 20–32 px      | `docs/brand/masters/mark-small-{light,dark}.svg` | 2 in / 2 out                                                                  |
| ≥ 40 px       | `docs/brand/masters/mark-{light,dark}.svg`       | 3 in / 3 out                                                                  |

Measured at true pixels (resvg, decoded): the 16 px cut halves the mush against the small cut at
16 px (0.769 vs 1.476, partial-only rows 7 → 0) and is tuned for exactly that size (at 20 px the
small cut measures better: 0.581 vs 0.947; at 32 px it beats the master: 0.407 vs 0.465). Rod caps
and row texture are a ≥ 64 px tell. The 32–40 px band is unassigned — record the choice when a
surface needs it (see Known Gaps).

### Placement

- **Favicon:** ship both tones and let the browser choose —
  `<link rel="icon" href="docs/brand/exports/favicon/favicon-32-light.png" media="(prefers-color-scheme: light)">` plus the
  `dark` file with `media="(prefers-color-scheme: dark)"`, and the 16 px pair for the tab strip.
  The 16 px file is the 16 px cut; 32 px renders the small cut.
- **Transparent is the recommended deployment form** — a tab bar, toolbar or README on a foreign
  background is not the kit's paper. Where a consumer cannot honour `prefers-color-scheme` (Windows
  shortcuts, some bookmark managers), ship the **baked** file as the safe single artifact.
- **Avatar:** `docs/brand/exports/avatar/avatar-512-{light,dark}.png` is circle-safe in both tones — worst-case ink radius
  29.97 of 32 units (93.4 %), so a 40 px circle crop cannot clip the mark.
- **Clear space:** one bar module (6.5 u = 12.5 % of the mark's 52 u ink height) on every side; two
  modules (13 u) beside type or another mark. The 64-unit canvas is a drawing box, not a clear-space
  guarantee.
- **Minimum sizes:** horizontal lockup 240 px wide (floor 120 — the wordmark softens but reads);
  stacked lockup 168 × 120 px, with the floor at 120 px of rendered height (below it the wordmark
  mushes); covers 1584 × 396.

### Wordmark

- All lowercase `schemamill`; `studio` lockups append the qualifier in Regular weight, pure ink.
- Shipped as **vector outlines only** — no font dependency, no `<text>`. Drawn from IBM Plex Sans
  Medium (SIL OFL 1.1) with edited letterforms (`squarecut`, user-confirmed Oct 13, 2026): never
  describe it as “IBM Plex unmodified”.
- Never re-set it in a font, recolour it, or place it inside the mark's clear space.
- The custom details are a large-size tell — below ≈ 120 px all treatments render effectively
  identically.

## Hatch

Hatch is an **annotation device, not a texture**: it means “this is a hazard / this changed”. It
carries meaning only next to the thing it annotates — a migration step, a diff hunk, an irreversible
operation — at 45°, ≥ 3-unit pitch, 1.25-unit strokes. A hatched triangle is a _hazard_; a hatched
bar, row or swatch is _selected_, _in progress_, or the stage in view.

- Never as decoration, never as a page or banner background (**no hatch on covers**).
- **Never on the mark.** Hatching the gate was built and rendered in two rounds; at 16 px it greys
  the hero and the device is spent on decoration.
- Emphasis is shape, weight and hatch — never hue. Sibling devices, from the wireframe doctrine: a
  heavier or doubled frame marks the active thing; a dashed line marks the unsettled or a seam.

## Elevation & Depth

Flat by doctrine: no shadows, no glows, no gradients (the banned list lives in Don'ts). Hierarchy is
carried by the panel tint (`#efece4` on paper), hairlines, frame weight and hatch. A drop shadow
never replaces any of them.

## Motion — draft, review with the canvas workstream

The motion system is not designed yet. Settled rows come from the brief and the kit's doctrine;
draft rows are checkable statements proposed here, to be confirmed or replaced by the canvas
workstream.

| statement                                                                                                                                | status              | source                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------- |
| Motion serves calm · precise · crafted; it is never a second attention device — the hatch stays the only thing that pulls the eye.       | settled             | brief (temperament); brand sheet §05                  |
| No looping, pulsing or celebratory motion.                                                                                               | draft               | this file                                             |
| Under `prefers-reduced-motion: reduce`, movement, scale and blur are removed; where continuity matters it becomes an opacity cross-fade. | settled — repo rule | `.agents/skills/better-ui`                            |
| State stays visible without its animation; motion may explain a change, never carry it.                                                  | settled — repo rule | `.agents/skills/better-ui`                            |
| Motion runs only on a state change or for spatial continuity (a thing that moved, moved); an unchanged screen is still.                  | draft               | this file                                             |
| Durations stay short — feedback ≤ ~150 ms, larger transitions ≤ ~300 ms, ease-out; no bounce or overshoot by default.                    | draft               | this file, consistent with `.agents/skills/better-ui` |
| Animate transform and opacity only; never hue, never decoration.                                                                         | draft               | this file                                             |

The canvas's own gestures (pan, zoom, drag) are the canvas workstream's to specify; they inherit
the settled rows.

## Do's and Don'ts

- Do read this file before UI work; check the surface against it and name deliberate deviations.
- Do keep exactly one warm element per composition — the mark's emitted row; everything else is ink
  and ground.
- Do use the 16 px cut at exactly 16 px, the small cut at 20–32 px, the master at ≥ 40 px.
- Do keep the gate as one mass; keep the rows square, flush and on the 0.25-unit grid.
- Do keep one bar (6.5 u) of clear space on every side.
- Do ship exact pixel sizes, both tones, from the kit's SVGs — never rescale a smaller master.
- Do use ink for the wordmark and the `studio` qualifier, in both colorways.
- Do keep hatch next to what it annotates; it is the product's only attention device.
- Do carry state and risk in shape, weight and hatch; keep WCAG AA (4.5:1) for normal text.
- Do gate movement, scale and blur behind `prefers-reduced-motion: no-preference`.
- Don't scale the 3+3 master down to 16 px — that is what the 2+2 and 16 px cuts are for.
- Don't use the 16 px cut above 16 px, or below it without re-checking: it is tuned for one grid.
- Don't hatch, texture, outline, gradient or shadow the mark; don't split the gate, rotate the mark,
  or box it in another shape.
- Don't colour the wordmark, the `studio` qualifier, or the accent itself (two hexes, two tones —
  nothing in between).
- Don't give the accent a status meaning (add / remove / error / hazard).
- Don't hue-code anything: no red/green diff colors, no amber warnings; diff add/remove and hazards
  are ink and hatch.
- Don't set body copy in faint (2.55:1 light / 2.77:1 dark).
- Don't reach for the banned aesthetics: gradients, glows or shadows; database cylinders or clouds;
  literal flour or windmill illustration; neon cyber / terminal / matrix; corporate SaaS blue;
  AI-sparkle or crypto.

## Known Gaps / Iteration Guide

### Known gaps

- **Landing:** this file lives at the repo root and is referenced from `AGENTS.md`; it landed with the
  identity integration, and its assets live under `docs/brand/`.
- **Not designed yet:** the studio's type scale, spacing, radius and component tokens — the reason
  the Typography, Layout, Shapes and Components sections are absent (frontmatter `omitted` for the
  token groups). The canvas workstream adds them.
- **Canvas conventions** — grid, selection beyond hatch/frame weight, handles, zoom behaviour,
  gesture set — are not designed; `docs/design/` holds structure sketches, not pixels.
- **Dark panel:** the panel tint has no dark value defined.
- **The 32–40 px band** is unassigned by the kit's cut copy (the kit's independent audit, nit 8; not shipped).
- **Icons not exported:** `.ico`, Apple touch icon (180 px), `mask-icon`, and a dedicated 16 px
  streaming favicon; the PNG pair is the shipped favicon wiring.
- **Format:** `DESIGN.md` is `version: alpha`; re-run `npx @google/design.md lint DESIGN.md` after
  structural edits.

### Iteration guide

- Change art at its source, never by hand: in the kit's build tooling (not shipped), run
  `node build.mjs`, then `node check.mjs` and `node verify-ondisk.mjs`; the kit's export set and
  manifest follow the build.
- A rule change lands in this file with its source (brand sheet or kit notes) in the same change;
  never restate a rule in a second document — point here.
- Keep the file readable in one pass (~200 lines); measurements and rationale live in the kit's
  notes.
- If a skill is ever wanted, it is only a thin loader that reads this file and never restates it —
  duplicated conventions drift.

## Pointers

- `docs/brand/brand-sheet/brand-sheet.html` + `docs/brand/brand-sheet/brand-sheet@2x.png` — the compact brand sheet: palette with
  measured contrast, the dual cut, accent usage, the hatch device, clear space, minimum sizes,
  do/don't.
- `docs/brand/README.md` — the in-repo index: folder map, provenance, naming and recorded gaps.
- `docs/brand/masters/notes.md`, `docs/brand/wordmark/notes.md` — measurements, decisions, weaknesses, honestly.
- `docs/brand/exports/manifest.json` — sha256 per export; the provenance check when copying assets.
- `CONTEXT.md` — the vocabulary law; `docs/design/README.md` — the wireframe doctrine.
- `AGENTS.md` — how to build the repo; its UI pointer leads here.

Paths in this file are repository paths; the source kit keeps its own layout.
