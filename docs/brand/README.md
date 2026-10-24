# Brand kit

The project's visual identity, copied from the locked design kit. Every file here is byte-identical to its source; nothing is recoloured, re-cut or re-exported.

## What is here

- `masters/` — the mark masters: the 3+3 mark, the 2+2 small cut and the 16 px cut, each light and dark, plus the horizontal, stacked and `schemamill studio` lockups. `notes.md` records the measurements, evidence and known weaknesses.
- `wordmark/` — the shipped `squarecut` wordmark, light and dark, with `notes.md` for the custom-details record and licence context.
- `exports/` — the export set (PNGs plus the four LinkedIn cover SVGs) and `manifest.json`, which records byte count, sha256, pixel size, tone and source per export. The favicon and README lockup exports each ship a `-transparent-` sibling of every baked PNG; the avatar, cover and brand-sheet exports are baked only.
- `brand-sheet/` — the brand sheet as a standalone HTML page and as a @2x PNG. The HTML has no network or font dependencies; open it locally.
- `OFL.txt` — the SIL Open Font License 1.1 text for the IBM Plex Sans Medium skeleton the wordmark outlines derive from.

## Provenance

`exports/manifest.json` is the record. Each entry names a `file` relative to `exports/`, with its byte count and sha256; a copy is correct when both match. One entry resolves outside `exports/` to `brand-sheet/brand-sheet@2x.png`.

The wordmark ships as vector outlines only — no `<text>`, no font references, no embedded font software. Only the licence text ships from the kit's font tooling; the fonts themselves stay in the kit. The wordmark is edited IBM Plex Sans Medium; never describe it as "IBM Plex unmodified".

## Recorded gaps

- Favicon assets are copied but not wired: no served HTML page exists yet.
- No app icon bundle: `.ico`, `.icns`, the Apple touch size and `mask-icon` were never exported.
- Studio type scale, spacing, radius, component tokens, the dark panel value and the 32–40 px cut band are not defined; see `../../DESIGN.md` (Known Gaps).
- Not shipped from the kit: `review.html`, the alternate `finish` and `stock` wordmarks, the build tooling and the audit suite. The kit source keeps them.
- The copied `notes.md` files are the kit's own record: they still reference kit-only paths and the `finish`/`stock` wordmarks, which do not ship here.
