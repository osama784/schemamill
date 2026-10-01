# Plan hazards — definite and state-dependent annotations

**Status:** built · **Last updated:** 2026-10-01

Hazards as annotations on a migration plan: `plan` now reads the baseline and target models beside the plan and reports what PostgreSQL would reject at apply — the five definite checks on self-inconsistent sequence and identity targets — and what may fail because a sequence's stored value is not modeled — the state-dependent `bound-tightened`. The analysis never changes a step or the SQL; hazards sit beside the plan as facts. `@schemamill/core` owns the `Hazard` union and the widened `HazardAnalyzer<Model, Plan, Hazard>` seam, `@schemamill/postgres` binds `hazardAnalyzer`, and the CLI formats the prose. The settled decisions are on [#24](https://github.com/osama784/schemamill/issues/24) (design review rounds 1–3 and the approved brief), the slice's ledger, which also carries the reviewer's live PostgreSQL evidence.

## Scope

**In:** the hazard channel and exactly the state-edge families — the five definite checks and the state-dependent `bound-tightened`; sequences matched by schema-qualified name and identity columns by table and column; the `plan` command surface, which prints a `Hazards:` section between the step list and the SQL; analysis only — `compare`, the rendered SQL, and exit codes are untouched.

**Out, named — never silent:** relation-level families — rewrites, locks, and downtime — which need type semantics the model deliberately lacks; transaction grouping; SQL comments; compare-side hazards; sequence state (`last_value`, `is_called`, `RESTART`, `setval`); and auto-remediation — the analyzer never repairs a target or emits a clause.

**Deliberately shallow for now:** the analyzer is a pure read of the two models and the plan — no catalog, no execution, no version detection; a definite hazard is reported, never fixed.

## Rules

**Entities and matching.** Sequences match by schema and name, identity columns by table and column name; each side's options are read as stored, already effective from import. A baseline-only entity is a drop with nothing to apply and reports nothing; a target-only entity reports its definite hazards only; an entity on both sides reports definite hazards and, when it has none, its state-dependent ones. An entity the plan carries no carrying step for reports nothing — the plan is the only source of step indices.

**The five definite checks**, every violation reported, in PostgreSQL's fixed check order:

1. `increment-zero` — the target `INCREMENT BY 0`.
2. `bound-out-of-type-range` — the target `MAXVALUE`, then the `MINVALUE`, each falling outside the type's range: below the type's minimum or above its maximum. A sequence reads its own `dataType`; an identity column its canonical integer type, and a column outside that family skips this check and no other.
3. `bounds-inverted` — `MINVALUE >= MAXVALUE`; the engine requires strictly less.
4. `start-out-of-bounds` — `START` outside `[MINVALUE, MAXVALUE]`, both edges inclusive.
5. `cache-nonpositive` — the target `CACHE` zero or negative, reachable from a hand-written dump with no import diagnostic.

Every comparison is a `bigint` over the stored decimal strings, never a JavaScript `number`.

**`bound-tightened`**, the one state-dependent kind, is emitted per field: a target `MINVALUE` above the baseline's, or a target `MAXVALUE` below it, carrying the actual effective values (`min` before `max` when both tightened). A type narrowing that resets a default bound therefore reports the tightening, while a type change that preserves custom bounds reports nothing. It is suppressed when the entity has any definite hazard — the definite failure happens first — and a recreated identity reports none, because its old sequence is dropped rather than cross-checked.

**Step association.** A target-only sequence attaches to its `create-sequence` step; a matched sequence to the first `alter-sequence` step carrying a non-ownership option — the step whose bounds PostgreSQL applies; an ownership-only alter applies no options, so it carries no hazard and a matched sequence whose plan carries only ownership alters reports nothing. A target-only identity attaches to its `add-identity` step; a matched identity to its `alter-identity` step — or, when the plan carries no identity step and the column converts within the integer family, to the `alter-column` step carrying the `type` change, the statement whose conversion PostgreSQL validates — while a definite hazard on a recreated identity falls back to the `add-identity` step, the statement that would fail. A tightening the type conversion moves attaches to that `alter-column` type step unless the `alter-identity` step restates the bound as its own field: the restatement is the statement that applies the final bound, so it keeps the hazard.

**Determinism and ordering.** Hazards come back in plan order — step index ascending, and within one step the entity's check order — with entities iterated in sorted identity order, so neither model's array order can affect the result. Returned hazards are fresh objects; the models and the plan are never mutated.

## The PostgreSQL checks

The rules mirror the engine, pinned by a live matrix on PostgreSQL 16.15: validation runs in the order `INCREMENT` (a stated zero rejected) → the `MAXVALUE` then the `MINVALUE` against both ends of the type's range → `MINVALUE < MAXVALUE` (strict) → `START` within `[min, max]` → the stored `last_value` within `[min, max]` (reported as `RESTART value`) → `CACHE` (a stated non-positive rejected), and every semantic failure is SQLSTATE 22023 and leaves the sequence and its state untouched. Equality edges are legal — `start == max` and `last_value == max` both pass. Increment changes, sign flips included, never cross-check a bound. `ALTER SEQUENCE … AS` resets default bounds to the new type's, then runs the same checks; identity applies the same checks, and an identity column's type change moves its sequence's type and bounds with it — a sequence-side failure aborts the whole statement.

## The state edge

Sequence and identity state are not modeled: `last_value`, `is_called`, `RESTART`, and `setval` stay outside the model, skip-and-named on import. That is exactly why `bound-tightened` cannot be resolved — PostgreSQL cross-checks the sequence's current value against the tightened bound at apply, and the model cannot say whether the migration fails. The two earlier plans name the same edge in [sequences](./sequences.md#the-state-edge) and [identity](./identity.md#the-state-edge); state-aware planning stays out of scope, and the analyzer annotates without emitting `RESTART` or touching the target. The slice's live evidence lives on [#24](https://github.com/osama784/schemamill/issues/24).

## Output shape

`plan` prints the numbered step list, then the `Hazards:` section, then the migration SQL — the section only when the analysis finds anything, so a clean plan's stdout is unchanged. Each hazard is one two-space-indented `step <n> <kind>: <clause>` line, numbered 1-based by the step it belongs to; a definite clause states the failure PostgreSQL will raise at apply, and the `bound-tightened` clause says it may fail and names the unmodeled state. There is no flag and no change to `compare`, the SQL, or exit codes. The `hazards` golden scene pins all six kinds across `create-sequence`, `alter-sequence`, and `add-identity`; `identity.plan.txt` is re-pinned to carry its one conditional line.

## Verification

Two levels and the live evidence pin the slice:

- **Unit tests** — `packages/postgres/src/hazards.test.ts` pins every kind and its boundaries: all five definite violations in check order for target-only and matched sequences and for added and altered identities; each bound out of range in both directions; `start` equal to either bound passing; equality, widening, and increment sign flips reporting nothing; an `AS` conversion that preserves custom bounds passing while a reset default reports its tightening; the `alter-column` attachment for a narrowed identity and for a converted custom bound — definite when outside the new type's range, clean when inside — beside an `alter-identity` option alter, with an explicit restatement keeping its tightening there; an ownership-only `alter-sequence` reporting nothing; a recreated identity falling back to `add-identity` and reporting no conditional; suppression by a definite hazard; a non-integer identity skipping only the type-range check; the canonical type in the hazard; and determinism under reversed model array order.
- **CLI goldens** — a new `hazards` fixture pair with `hazards.compare.txt` and `hazards.plan.txt` pins all six kinds byte-for-byte; `identity.plan.txt` is re-pinned for its conditional line; `sequences.plan.txt` stays clean.
- **Live PostgreSQL evidence** — the reviewer's positive and negative apply runs (a self-inconsistent target fails; a tightened max below the current value fails and above it succeeds; an identity narrowing with a current value beyond the new type fails and within it succeeds; `CACHE 0` create fails; safe plans still apply and re-dump clean) are recorded on [#24](https://github.com/osama784/schemamill/issues/24). No harness scenes and no dogfood: nothing apply-facing changed, so the existing round-trip suite already covers the slice.

## Done means

- Every analyzer unit test and CLI golden passes, and `plan` prints the `Hazards:` section exactly as pinned.
- The reviewer's live evidence is recorded on [#24](https://github.com/osama784/schemamill/issues/24).
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Non-goals

Relation-level hazard families — rewrites, locks, and downtime — are named non-goals for later slices: truthful rewrite analysis needs type semantics the model deliberately lacks. Transaction grouping, SQL comments, compare-side hazards, sequence-state modeling, and auto-remediation stay out; the analyzer never changes a step, emits no new SQL clause, and adds no flag.
