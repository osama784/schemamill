# Transaction groups — partition, render, verify

**Status:** built · **Last updated:** 2026-10-02

A migration plan now says what applies as one unit. `Plan` carries a deterministic partition of its steps into transaction groups, `renderSql` wraps each transactional group in `BEGIN;`/`COMMIT;`, `plan` labels a single-transaction migration `N steps in one transaction:`, and the gated live-PostgreSQL suite proves atomic rollback and its falsification. The settled decisions are on [#30](https://github.com/osama784/schemamill/issues/30) (design review rounds 1–2 and the approved brief), the slice's ledger. The durable decision — boundaries follow step semantics, never user configuration — is recorded in [ADR 0007](../adr/0007-transaction-boundaries-follow-step-semantics.md).

## Scope

**In:** `Plan.groups: readonly TransactionGroup[]`; `TransactionGroup = { start, end, transactional }` — half-open indices into `steps`, with non-empty groups tiling `0..steps.length` in order and `transactional: false` marking a standalone group that applies outside a transaction; the compile-time exhaustive `TRANSACTIONAL: Record<Step['kind'], boolean>` classification beside the step union; the coalescing function `groupSteps` and its predicate parameter as the test seam; `plan()` computing the groups once; `renderSql` walking the groups and wrapping each transactional one; the `plan` command's transaction-labeled header; and the always-on live rollback proof and stripped-wrappers falsification.

**Out, named — never silent:** multi-group display wording, so a plan that is not one covering group falls back to the plain `N steps:` header; group separators or any decoration beyond the wrappers; and the first real non-transactional step kind, which will name its own grouping needs when it arrives. The apply-side families are named under Non-goals.

**Deliberately shallow for now:** classification is one fixed boolean per step kind, not derived from the statement text and not PostgreSQL-version-aware; hazards, step order, and step indices are untouched, so the partition is metadata beside the steps, never an ordering input. No plan `plan()` produces today has more than one group.

## The rule

Transaction safety is a property of a step's kind, decided beside the step union. `TRANSACTIONAL` is a `Record<Step['kind'], boolean>` — compile-time exhaustive, so adding a kind to the union without classifying it fails the build — and all fifteen current kinds are transactional: `create-table`, `drop-table`, `add-column`, `drop-column`, `alter-column`, `add-identity`, `drop-identity`, `alter-identity`, `add-primary-key`, `drop-primary-key`, `add-foreign-key`, `drop-foreign-key`, `create-sequence`, `drop-sequence`, and `alter-sequence`.

`groupSteps` walks the steps in order and partitions them: consecutive transaction-safe steps coalesce into one group, while a non-transactional step becomes a group of its own, even beside another non-transactional step. Every group is non-empty, the groups tile `0..steps.length` in order, an empty step list yields no groups, and the result depends only on the step order and the classification. `plan()` computes the partition once, from the fixed classification, and returns it beside the steps. Because no kind is non-transactional yet, every non-empty plan is exactly one transactional group covering every step. The predicate parameter on `groupSteps` exists so tests can exercise the standalone and mixed paths with a synthetic classification before a real standalone kind exists.

## SQL format

`renderSql` walks `plan.groups` in order rather than `plan.steps`: a transactional group emits `BEGIN;` before and `COMMIT;` after its statements, and a standalone group renders its statements bare. One statement per line, one trailing newline, no blank lines anywhere — groups butt against each other, and separators are deferred until a real standalone kind exists. An empty plan still renders `''`, the `renderSql(plan)` signature is unchanged, and the plan is still the only input: the renderer invents no boundaries and reads no environment.

## CLI output

`formatPlan` labels the step list `N steps in one transaction:` when the plan's groups are exactly one transactional group covering every step — singular `1 step in one transaction:` — and keeps the plain `N steps:` header for any other plan; that fallback is unreachable from today's `plan()`, and it is the deferred multi-group wording. An empty plan stays `No changes.`. Step numbering, kind padding, and every step line are unchanged: only the header gained the transaction structure.

## Verification

Four levels pin the slice:

- **Unit tests** — `packages/core/src/plan.test.ts` pins the classification (all fifteen kinds listed and asserted `true`, their keys exactly `TRANSACTIONAL`'s), coalescing with a synthetic classification (`[T, T, F, T]` → `[{ 0, 2, true }, { 2, 3, false }, { 3, 4, true }]`), tiling and non-emptiness, an all-transactional step list as one group, an all-standalone classification as one group per step, an empty step list as no groups, and the plan-level partition; `assertPlan` computes the single expected group for every existing plan case.
- **Render tests and goldens** — `packages/postgres/src/render.test.ts` pins the empty plan as `''`, a non-empty plan as exactly one `BEGIN;`/`COMMIT;` pair, and a synthetic three-group plan whose standalone group renders bare between two wrapped groups with no blank lines; all six goldens in `packages/postgres/test/goldens/*.sql` gained their wrapper lines.
- **CLI tests and goldens** — `packages/cli/src/format.test.ts` pins the singular, plural, plain-header, and empty cases, and all five `packages/cli/test/goldens/*.plan.txt` were re-pinned to `N steps in one transaction:`.
- **Live harness** — the scene corpus stays green under wrapped SQL, and two always-on tests in the gated suite (`SCHEMAMILL_TEST_PG_URL`) carry the rollback proof:
  - **Rollback proof** — `primary-key-add`, the corpus's smallest corruptible shape at two steps (`alter-column` then `add-primary-key`), is rendered, its last statement retargeted at `public.t_missing` with exactly one rendered line changed, and applied with `psql` `ON_ERROR_STOP=1`; the failure must name the missing relation, and the re-dump after it must import to an exactly empty diff against the baseline — the statement that succeeded before the failure left no partial effect.
  - **Falsification** — the same corrupted SQL with every `BEGIN;`/`COMMIT;` line stripped (exactly one pair pinned) is applied to a freshly rebuilt baseline: the same relation must fail, and the earlier statement's effect must still be readable — `public.t.id` stays `NOT NULL`. The two runs differ only in the wrapper lines, so the rollback proof's empty diff is attributable to them and the wrappers stay load-bearing.
  - Both tests pin the scene's two-step shape and the exactly-one-line corruption first, so a planner or renderer change cannot quietly turn the proof into a no-op.

## Done means

- The classification test names all fifteen kinds, and every unit test above passes.
- Every rendered golden carries exactly one wrapper pair, and every CLI plan golden carries the transaction header.
- The live rollback proof and its falsification pass against live PostgreSQL on the gated suite, and the existing scenes still round-trip with an exactly empty diff.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Non-goals

The `--sql` flag; user-controllable commit points or transaction flags; PostgreSQL-version detection or conditional wrapping; DML; expand/contract orchestration; per-phase or per-step commit boundaries; `\set ON_ERROR_STOP`; and apply tooling — [ADR 0001](../adr/0001-generate-never-apply.md) stands, so the generated SQL keeps its wrappers, and whether and how to set `ON_ERROR_STOP` stays the user's call. Multi-group display wording, group separators, and the first real non-transactional step kind are deferred as named above: the first such kind is not invented here, and when it lands it brings its own ceremony. `compare` and `plan --verbose` are unchanged.
