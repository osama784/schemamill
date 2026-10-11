# Render refusal — hardening the unsatisfiable-name boundaries

**Status:** partially built — slice A built, slice B deferred · **Last updated:** 2026-10-11

[ADR 0009](../adr/0009-render-refuses-duplicate-conventional-names.md) decided that `renderSql` validates a plan before rendering and throws the exported `RenderRefusalError` when two index statements of one table and polarity resolve to one name — the explicit name, or the conventional `<table>_<cols>_idx` an unnamed index will take at apply. `@schemamill/cli`'s `plan` catches exactly that class, keeps the plan display on stdout, writes `schemamill: refusing to render: …` to stderr, and exits 1; `compare` never renders, so it cannot hit the refusal today. Slice A ([#75](https://github.com/osama784/schemamill/issues/75)) shipped the name-fidelity and omitted-declaration half: generated names longer than 63 bytes predict PostgreSQL's stored server form, canonicalize back to unnamed on import, render as server-form drops, and the guard refuses truncation collapses; a foreign key that omits `referencedColumns` compares equal to the primary key its own model resolves; and the check heuristic's fail-safe class is pinned. The decisions are recorded in [ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md). Slice B — the remaining guard namespaces, baseline occupancy, the PostgreSQL 18 unnamed-not-null occupancy question, and refusal surfacing through the hazard channel — is deferred as its own slice; the plan remains the record of the whole boundary. The frozen brief's residual list on [#48](https://github.com/osama784/schemamill/issues/48) (§D4) named the boundaries this slice closes; the same residuals are recorded in [constraints and indexes](./constraints-indexes.md) §Deferred and ADR 0009's consequences.

## Goal

Every plan either renders SQL PostgreSQL accepts or is refused by name before any statement is produced — no same-name pair reaches apply from a plan schemamill can see, and a refusal is visible wherever a plan or diff is reported, not only as a stderr line from one command.

## Scope

**In — slice A (built, [#75](https://github.com/osama784/schemamill/issues/75)):**

- Truncation and collision-suffix canonicalization: a generated name that equals the server form of its structure's formula — PostgreSQL's 63-byte truncation included — canonicalizes back to unnamed (deterministic, unlike suffixes); collision-suffixed names (`_idx1`, `_key1`, …) stay named because they are not predictable offline.
- Truncation-collapsed unnamed predictions: two unnamed indexes whose synthesized names differ above 63 bytes but truncate to one server name refuse with `RenderRefusalError` before any SQL renders.
- The unnamed foreign key declared without a referenced-column list: the diff treats the omission as equal to the omitting side's own model's referenced-table primary key, in primary-key order, so the dump's explicit list round-trips to an empty diff; an absent referenced table, a table without a primary key, and an explicit list matching a unique constraint rather than the primary key stay named residuals.
- The check-heuristic fail-safe class: the check-name formula stays a lexical best-effort scan — an expression it misreads keeps its server name — and the class is pinned without tightening.

**In — slice B (deferred):**

- Constraint twins, same-kind and cross-kind: an unnamed constraint beside an explicit twin bearing its conventional name on one table — a constraint name is table-scoped, so a check twin colliding with a unique twin's name counts too — is refused like the index case.
- Explicit-vs-explicit constraint-name collisions on one table.
- Cross-table same-schema index-name collisions: an index name's uniqueness spans its schema, so two tables' same-named index creates in one schema are refused even though today's guard is same-table only.
- A baseline-materialized unnamed index a target's explicit twin create would collide with: `renderSql` today sees one plan and no baseline, so the slice passes the baseline (or an equivalent fact) to the guard.
- Refusal surfacing through the hazard channel: today the refusal is stderr + exit 1 in `plan` only; the slice makes it a reported hazard-class fact — `compare` included — with the brief settling the wording and whether the stderr line stays.

**Out, named — never silent:** PostgreSQL 18 named `NOT NULL` constraints, now carried by the [constraint-attributes slice](./constraint-attributes.md) ([#74](https://github.com/osama784/schemamill/issues/74)); constraint validation against populated tables, which stays data-dependent and named in [hazards](./hazards.md); exclusion constraints; and collision suffixes actually assigned by the server, which need catalog knowledge the guard deliberately lacks.

**Deliberately shallow for now:** the guard refuses only what a plan and the baseline it is given can see; a fact that needs the live catalog is named, never guessed.

## Acceptance

- Slice A (met): truncated generated names round-trip to an empty diff (unit and live), a long-named unnamed drop applies (live), omitted referenced columns round-trip (unit and live), truncation collapses refuse with pinned messages, and existing tests and goldens stay byte-identical apart from the intended omitted-referenced-columns re-pin.
- Every residual above has a pinned outcome — refuse, canonicalize, or stay named — with unit tests and, where the CLI surface changes, goldens.
- Refusals are pinned by exact message and by CLI streams and exit codes, and the cross-kind, cross-table, and baseline-materialized cases carry live-PostgreSQL evidence: the refused plan fails at apply, the accepted one applies.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- Slice A: the live suite is green with `truncated-name-round-trip` and `unnamed-fk-round-trip`, and the durable decisions are recorded in [ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md).
- Slice B: the live suite is green with its new refusal scenes, and the refusal's surfacing contract is recorded in its own ADR — ADR 0009 stays as written, since accepted ADRs are immutable.
- Mutation checks are recorded on the slice's tracker issue; the five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Slice B — the remaining guard boundaries** — constraint twins (same-kind and cross-kind) and explicit-vs-explicit constraint-name collisions on one table; cross-table same-schema index-name collisions, including the create-table and add-column claimants; baseline occupancy and the `renderSql` baseline parameter; the unnamed-not-null occupancy question (PostgreSQL 18 only); and refusal surfacing through the hazard channel with its own ADR. The plan remains the record of the whole boundary.
- **Hand-written explicit names longer than 63 bytes** — an explicit name renders as written while PostgreSQL stores its clip, so a hand-written name longer than 63 bytes reads as a change against a dump of what was applied; pinned as a residual, not fixed in slice A ([ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md)).
- **Non-UTF-8 database encodings** — the prediction mirrors `pg_mbcliplen` under a UTF-8 database; any other encoding is a named residual.
- **Catalog-dependent suffix recovery** — knowing which suffix the server actually assigned needs a live catalog read; introspection parity is the [introspection follow-ups](./introspection-attributes.md).
- **Version gating** — differences across PostgreSQL majors stay with the version-aware slice, so the guard's formulas keep the PG 13 floor.
