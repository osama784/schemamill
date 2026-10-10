# Render refusal — hardening the unsatisfiable-name boundaries

**Status:** planned · **Last updated:** 2026-10-08

[ADR 0009](../adr/0009-render-refuses-duplicate-conventional-names.md) decided that `renderSql` validates a plan before rendering and throws the exported `RenderRefusalError` when two index statements of one table and polarity resolve to one name — the explicit name, or the conventional `<table>_<cols>_idx` an unnamed index will take at apply. `@schemamill/cli`'s `plan` catches exactly that class, keeps the plan display on stdout, writes `schemamill: refusing to render: …` to stderr, and exits 1; `compare` never renders, so it cannot hit the refusal today. The frozen brief's residual list on [#48](https://github.com/osama784/schemamill/issues/48) (§D4) named the boundaries this slice closes; the same residuals are recorded in [constraints and indexes](./constraints-indexes.md) §Deferred and ADR 0009's consequences.

## Goal

Every plan either renders SQL PostgreSQL accepts or is refused by name before any statement is produced — no same-name pair reaches apply from a plan schemamill can see, and a refusal is visible wherever a plan or diff is reported, not only as a stderr line from one command.

## Scope

**In:**

- Constraint twins, same-kind and cross-kind: an unnamed constraint beside an explicit twin bearing its conventional name on one table — a constraint name is table-scoped, so a check twin colliding with a unique twin's name counts too — is refused like the index case.
- Explicit-vs-explicit constraint-name collisions on one table.
- Cross-table same-schema index-name collisions: an index name's uniqueness spans its schema, so two tables' same-named index creates in one schema are refused even though today's guard is same-table only.
- Truncation and collision-suffix canonicalization: a generated name that equals the 63-byte truncation of its structure's formula canonicalizes back to unnamed (deterministic, unlike suffixes); collision-suffixed names (`_idx1`, `_key1`, …) stay named because they are not predictable offline.
- Truncation-collapsed unnamed predictions: two unnamed members whose synthesized names differ above 63 bytes but truncate to one server name — the guard must see the collapse and refuse.
- A baseline-materialized unnamed index a target's explicit twin create would collide with: `renderSql` today sees one plan and no baseline, so the slice passes the baseline (or an equivalent fact) to the guard.
- The unnamed foreign key declared without a referenced-column list: the dump states what the declaration omitted, so the model reads changed on `referencedColumns` after apply; the slice pins the canonicalization or round-trip rule (explicit referenced columns already round-trip).
- Refusal surfacing through the hazard channel: today the refusal is stderr + exit 1 in `plan` only; the slice makes it a reported hazard-class fact — `compare` included — with the brief settling the wording and whether the stderr line stays.
- The check-heuristic fail-safe class: the check-name formula is a lexical best-effort scan, so an expression it misreads keeps its server name; the slice pins the class and decides whether the scan tightens.

**Out, named — never silent:** PostgreSQL 18 named `NOT NULL` constraints, now carried by the [constraint-attributes slice](./constraint-attributes.md) ([#74](https://github.com/osama784/schemamill/issues/74)); constraint validation against populated tables, which stays data-dependent and named in [hazards](./hazards.md); exclusion constraints; and collision suffixes actually assigned by the server, which need catalog knowledge the guard deliberately lacks.

**Deliberately shallow for now:** the guard refuses only what a plan and the baseline it is given can see; a fact that needs the live catalog is named, never guessed.

## Acceptance

- Every residual above has a pinned outcome — refuse, canonicalize, or stay named — with unit tests and, where the CLI surface changes, goldens.
- Refusals are pinned by exact message and by CLI streams and exit codes, and the cross-kind, cross-table, and baseline-materialized cases carry live-PostgreSQL evidence: the refused plan fails at apply, the accepted one applies.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- The live suite is green with the new refusal and canonicalization scenes; ADR 0009's consequences are updated (or a new ADR records a changed surfacing contract).
- Mutation checks are recorded on the slice's tracker issue; the five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Slice size** — the list spans import canonicalization, a guard signature change, and hazard-channel surfacing; the brief may split it into a canonicalization slice and a refusal-surfacing slice rather than one change, and this plan is the record of the whole boundary either way.
- **Catalog-dependent suffix recovery** — knowing which suffix the server actually assigned needs a live catalog read; introspection parity is the [introspection follow-ups](./introspection-attributes.md).
- **Version gating** — differences across PostgreSQL majors stay with the version-aware slice, so the guard's formulas keep the PG 13 floor.
