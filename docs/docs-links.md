# Docs links

**Status:** built 2026-11-06 · living document

Relative links in `docs/**/*.md` and `README.md` are checked; a broken link fails `pnpm test`. The checker is `.github/scripts/link-check.mjs`, a zero-dependency script with `node:test` coverage, and the root test chain runs it after the docs count check. The count-side gate is documented in [the counts guide](docs-counts.md).

## Scope

Checked: every Markdown file under `docs/` — accepted ADRs included — plus the root `README.md`.

Not checked: `CHANGELOG.md`, `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, `.agents/**`, and external URLs. Those root files are outside the link surface today; see Deferred.

## What is checked

- Inline Markdown links and images. An optional `<…>` wrapper and a `"…"`/`'…'` title are stripped, and the target path is percent-decoded.
- HTML `src`, `href`, and `srcset` attributes. A `srcset` value is split on commas, and each candidate's URL is checked after its `1x`/`2x` descriptor is dropped.
- Fenced code blocks are skipped, so a link example inside one is never resolved.
- Empty targets, targets with a scheme (`https:`, `mailto:`, …), and protocol-relative `//` targets are skipped.
- A fragment-only target (`#section`) resolves against the source file.
- Paths resolve POSIX-style against the source file's directory, and an exact file or a directory is accepted — directory links exist in the docs.
- A target that resolves outside the repository root is broken.
- For a `.md` target, the fragment is checked against the target's heading slugs; a fragment on any other file type is ignored.

## Anchors

Heading slugs approximate GitHub's: the text is lowercased, HTML tags and inline Markdown are stripped, punctuation is removed except `-` and `_`, spaces become `-`, and duplicate headings get `-1`, `-2`, … in document order. Matching is case-sensitive.

Named limits: HTML `<a id>`/`name` anchors are not recognized; emoji and other Unicode slug edge cases are not replicated; the slugger is an approximation of GitHub's, pinned by the docs' real anchors and the unit tests.

## Output and exit

Each broken link prints as `link-check: <file>:<line> <target> (<reason>)`, followed by a `link-check: N links checked, M broken` summary. Any broken link or read error exits 1; a clean tree exits 0. The count check and the link check share the root test chain via `&&`, so a stale count is reported before the link check runs — one failure at a time.

## Running it

`pnpm docs:links` runs the check alone; no build is needed. `pnpm test` runs it as the final step. It is part of the existing `verify` job (Node 24 and Node 26) through the root test chain — no separate workflow or job exists.

## Accepted ADRs

Links inside accepted ADRs are checked: the counts exemption is about immutability, not link integrity. Because an accepted ADR is never edited, a moved target is handled by a documented per-file exemption with a reason (the primary policy) or, only as a named exception, a non-`NNNN-` forwarding file that links to the new location. Never edit an accepted ADR to repair a link.

## Deferred

- Link coverage for `CHANGELOG.md`, `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, and `.agents/**`.
- External URL checking.
- Reference-style links.
- HTML `<a id>`/`name` anchors.
- HTML inside inline code, which the extraction does not skip.
- Symlink and case-insensitive path semantics.
- Anchors on non-`.md` targets.
- A report mode for the link checker.
