# Design integration

Status: planned · Last updated: 2026-10-22

Land the project's brand identity and design conventions in the repository. The brand kit is finished, internally audited and hash-verified, and has never been integrated. This slice is documentation and assets only: no product behavior, no studio surface, no code paths.

## Why now

The kit's only live host is the README. Live-database introspection, snapshots and the studio are unreleased, and `packages/server` serves no HTML, so the favicon and the studio brand surfaces have nothing to attach to yet. The README header, the root `DESIGN.md` and the asset record do have a home today.

## Source

The locked kit lives outside the repo at `/home/lenovo/projects/schemamill-designs`. `kit/exports/manifest.json` is the provenance record: byte count, sha256, pixel size, tone and source SVG per export. Copies are byte-identical; nothing is recoloured, re-cut or re-exported.

## Scope

1. **Assets into `docs/brand/`** — masters, the shipped `squarecut` wordmark, the export tree with its manifest, the brand sheet, and the font licence.
2. **`DESIGN.md` at the repo root** — the kit's conventions file, with every kit-relative path rewritten to its repository path. That includes bare paths written without the `kit/` prefix (`masters/…`, `exports/manifest.json`, `favicon-32-light.png`, `avatar-512-…`). `kit/README.md` names a file that is not shipped: point it at the new `docs/brand/README.md`. `_tooling` and `_verify` pointers become plain text. Content is otherwise unchanged, including the Known Gaps section.
3. **README header** — a centered `<picture>`: dark and light sources at 1x and 2x, transparent PNGs, a light `img` fallback, `alt="schemamill"`. The `# schemamill` H1 is replaced by the lockup; the wordmark carries the name.
4. **`AGENTS.md` pointer** — one sentence after the `CONTEXT.md` paragraph: read `DESIGN.md` before writing or reviewing any studio surface; brand assets live in `docs/brand/`.
5. **`docs/brand/README.md`** — a short index: what each folder holds, the provenance rule, the OFL note, and the recorded gaps.
6. **`docs/design/README.md`** — one cross-link line to `docs/brand/`.
7. **`CHANGELOG.md`** — an `[Unreleased]` → `Added` entry for the identity.

## Layout

```
DESIGN.md
docs/brand/README.md
docs/brand/OFL.txt
docs/brand/masters/{mark,mark-small,mark-16}-{light,dark}.svg
docs/brand/masters/lockup-{horizontal,stacked}-{light,dark}.svg
docs/brand/masters/studio-lockup-{light,dark}.svg
docs/brand/masters/notes.md
docs/brand/wordmark/wordmark-squarecut-{light,dark}.svg
docs/brand/wordmark/notes.md
docs/brand/exports/manifest.json
docs/brand/exports/readme/     (8 PNGs: 480/960 × light/dark × baked/transparent)
docs/brand/exports/favicon/    (8 PNGs: 16/32 × light/dark × baked/transparent)
docs/brand/exports/avatar/     (2 PNGs: 512 light/dark)
docs/brand/exports/linkedin/   (4 PNG + 4 SVG covers)
docs/brand/brand-sheet/brand-sheet.html
docs/brand/brand-sheet/brand-sheet@2x.png
```

## Decisions

- **`docs/brand/`** rather than a root `brand/`: the repo keeps recorded material under `docs/`, and `docs/` is excluded from Prettier, so the brand sheet HTML is not reformatted.
- **Transparent PNGs for the README.** The kit recommends the transparent form where the background is not controlled; the baked files ship beside them.
- **The H1 is replaced by the lockup.** The wordmark already spells the name, and the `alt` text carries it for screen readers.
- **Wordmark provenance.** Outlines derived from IBM Plex Sans Medium, edited into the `squarecut` treatment. It must never be described as "IBM Plex unmodified". `OFL.txt` ships next to it.

## Out of scope

- Favicon `<link>` wiring: no served HTML page exists (`packages/server` has no controllers and no static assets).
- `.ico`, `.icns`, Apple touch 180 and `mask-icon`: never exported by the kit.
- Studio typography, spacing, radius, component tokens, the dark panel value and the 32–40 px cut band: named as Known Gaps in `DESIGN.md`.
- Motion: `DESIGN.md` §Motion is a draft for the canvas workstream.
- Recolouring, re-cutting or re-exporting any asset.

## Acceptance

- Every `docs/brand/exports/**` file matches `manifest.json` byte count and sha256.
- No kit-relative path survives in `DESIGN.md`: every `masters/`, `exports/`, `wordmark/`, `brand-sheet/`, `favicon-*` and `avatar-512-*` occurrence is prefixed `docs/brand/`, or is prose naming the external kit. Check the rendered file, not just `rg 'kit/'`.
- The README `<picture>` declares dark and light `source` elements at 1x and 2x, each pointing at an existing PNG, with a light `img` fallback and `alt`.
- `AGENTS.md` names `DESIGN.md` and `docs/brand/`.
- All five gates green; an `[Unreleased]` entry is present.
- The PR body records both deviations: favicons copied but not wired; no app icon.

## Deferred

- **Favicon wiring** — when a served HTML surface exists (the studio shell or a docs site), add `<link rel="icon" media="(prefers-color-scheme: …)">` for the 16 and 32 px cuts.
- **App icon bundle** — `.ico`, `.icns`, 180 px Apple touch, `mask-icon`.
- **Studio tokens** — type scale, spacing, radius, elevation, dark panel value, and the 32–40 px cut band; owned by the canvas/UI workstream.
- **Motion** — review `DESIGN.md` §Motion with that workstream before any surface animates.
