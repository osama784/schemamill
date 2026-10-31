# Docs counts

**Status:** built 2026-10-24 · living document

Counts repeated across the plans drift every time the plan or the live suite grows. `pnpm docs:counts` derives the four count classes from code, scans the docs that state them with a small set of literal patterns, and prints every mismatch as `file:line claimed vs actual`. It is **report-only** for now; `--check` is implemented and unit-tested but not wired into CI.

## Count classes and sources

| Class | Source |
| --- | --- |
| Step kinds, transactional, non-transactional | `TRANSACTIONAL` imported from `packages/core/src/plan.ts` |
| Table phases | the numbered `1.`–`N.` list inside plan phase 6 in `plan.ts`; the list must be contiguous from 1 |
| Live scenes | `scenes` imported from `packages/postgres/src/live-scenes.ts` |
| Scenes skipped on PostgreSQL 16 | scenes whose `minServerMajor` is above 16 (absent means 13) |
| Postgres tests | line-anchored top-level `test(` calls across `packages/postgres/src/*.test.ts` |
| Always-on live subtests | `t.test(` calls after the `for (const scene of scenes)` loop in `live-pg.test.ts` |

The **live-suite tests** figure is a repo convention, not a runner fact: it is the postgres package total under a live URL, `postgres tests + scenes + always-on live subtests`. The report prints the three components beside the total so the convention stays visible. At this slice it is 353 + 50 + 3 = 406 on PostgreSQL 16.15; the three PostgreSQL 18 scenes skip there and all 50 run in CI.

`live-scenes.ts` resolves `@schemamill/core` through the workspace link to `packages/core/dist`, so run `pnpm build` first. A failed import or parse is reported as `docs-counts: error …`; report mode still exits 0.

## Claims and patterns

Claims are extracted line by line from `docs/**/*.md`. Parenthesized spans are stripped before live and table-phase matching, so a historical aside such as `(34 scenes at the time)` stays out. The step-kind and transactional patterns read the full line, because `transactions.md` states its classification claims inside a parenthetical list.

A line is a **live** claim only when it relates tests and scenes (`tests.*scenes` or `scenes.*tests`). From it the tool reads:

- `N tests`
- `N scenes`, and `grown to N scenes`
- `N skipped`
- `the <word> PostgreSQL 18 scenes`
- `all N run`

The other classes use these literal forms:

- **Table phases** — `<word> table phases`, `table phases are now <word>`, `<word>-phase order`.
- **Step kinds** — `step union is <word> kinds`, `all <word> [current] kinds`.
- **Transactional** — `the other <word> are transactional`, `the <word> transactional asserted`.

A number token may be digits or an English word from 0 through 99, hyphen compounds included (`twenty-six`, `twenty-four`). A matched token that is neither a number nor a stopword (`the`, `these`, `those`, `all`, `current`, `first`, `last`, and the connective `in`) is a claim error, never a silent skip. Only matching lines produce claims; slice deltas such as "five new scenes" or "nine more than the first slice's nine" are not claims.

## Exemptions

- **`CHANGELOG.md`** — every entry is a per-item snapshot of the counts at release or merge time.
- **`docs/adr/**`** — accepted ADRs are immutable per the ADR README. ADR 0016's 315 is the accept-time snapshot; the fix for a changed count is a new ADR, never an edit to an accepted one.
- **Code comments** — `plan.ts`'s phase prose and the like are not scanned; the phase count is parsed from the numbered list, not from the "eighteen table phases" sentence.
- **`CONTEXT.md`, `README.md`, `AGENTS.md`** — no count claims today; add them to the surface if one appears.

## Running it

From the repo root, after a build:

```
pnpm build
pnpm docs:counts
```

The report prints one line per actual component, one line per stale claim (`docs-counts: <file>:<line> <class> claimed <x> actual <y>`), any claim errors, and a summary (`docs-counts: <claims> claims checked, <stale> stale`). It exits 0 in report mode even when a claim is stale or a derivation fails.

`pnpm docs:counts --check` exits 1 on any stale claim or claim/derivation error and 0 on a clean tree. It is deliberately not wired yet: the surface needs a false-positive-free run first. The companion unit tests in `.github/scripts/docs-counts.test.mjs` pin the patterns against real doc lines copied verbatim, the number-word parser, the phase-list contiguity check, the total formula, the report format, and the `--check` exit codes; the root `pnpm test` runs them and then the report.

## Residuals

- **Under-reporting by design** — the patterns are literal. A reworded claim that no pattern matches is silently missed until the pattern is extended; the guide and the tests are the contract.
- **Phase list is a comment** — the count is parsed from `plan.ts`'s numbered list. Replacing it with a runtime phase constant is a production change, deferred.
- **Always-on subtests** — derived from `t.test(` calls after the scene loop; reshaping that loop requires the derivation to move with it.
- **Parenthesized claims** — live and phase claims inside parentheses are not checked (that is what keeps historical asides out); classification claims are, because their patterns read the full line.
- **Unscanned surfaces** — `CHANGELOG.md`, `docs/adr/**`, and code comments stay exempt as above.
- **`--check` in CI** — deferred until the report has run clean long enough to trust; flipping it is the follow-up, not a silent change.
