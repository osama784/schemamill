# Render refusal — hardening the unsatisfiable-name boundaries

**Status:** built — slices A and B shipped · **Last updated:** 2026-11-27

[ADR 0009](../adr/0009-render-refuses-duplicate-conventional-names.md) decided that `renderSql` validates a plan before rendering and throws the exported `RenderRefusalError` when two index statements of one table and polarity resolve to one name — the explicit name, or the conventional `<table>_<cols>_idx` an unnamed index will take at apply. `@schemamill/cli`'s `plan` catches exactly that class, keeps the plan display on stdout, writes `schemamill: refusing to render: …` to stderr, and exits 1; `compare` never renders, so it cannot hit the refusal today. Slice A ([#75](https://github.com/osama784/schemamill/issues/75)) shipped the name-fidelity and omitted-declaration half: generated names longer than 63 bytes predict PostgreSQL's stored server form, canonicalize back to unnamed on import, render as server-form drops, and the guard refuses truncation collapses; a foreign key that omits `referencedColumns` compares equal to the primary key its own model resolves; and the check heuristic's fail-safe class is pinned. The decisions are recorded in [ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md). Slice B ([#102](https://github.com/osama784/schemamill/issues/102)) built the remaining guard namespaces, baseline occupancy, the PostgreSQL 18 unnamed-not-null occupancy question, and refusal surfacing through the hazard channel; the decisions are recorded in [ADR 0043](../adr/0043-render-refusals-are-reported-hazards.md), a correction-paragraph ADR that leaves ADR 0009 accepted and unedited. The frozen brief's residual list on [#48](https://github.com/osama784/schemamill/issues/48) (§D4) named the boundaries this slice closed; the same residuals are recorded in [constraints and indexes](./constraints-indexes.md) §Deferred and ADR 0009's consequences.

## Goal

Every plan either renders SQL PostgreSQL accepts for its declared target version or is refused by name before any statement is produced — no same-name pair reaches apply from a plan schemamill can see, and a refusal is visible wherever a plan or diff is reported, not only as a stderr line from one command.

## Scope

**In — slice A (built, [#75](https://github.com/osama784/schemamill/issues/75)):**

- Truncation and collision-suffix canonicalization: a generated name that equals the server form of its structure's formula — PostgreSQL's 63-byte truncation included — canonicalizes back to unnamed (deterministic, unlike suffixes); collision-suffixed names (`_idx1`, `_key1`, …) stay named because they are not predictable offline.
- Truncation-collapsed unnamed predictions: two unnamed indexes whose synthesized names differ above 63 bytes but truncate to one server name refuse with `RenderRefusalError` before any SQL renders.
- The unnamed foreign key declared without a referenced-column list: the diff treats the omission as equal to the omitting side's own model's referenced-table primary key, in primary-key order, so the dump's explicit list round-trips to an empty diff; an absent referenced table, a table without a primary key, and an explicit list matching a unique constraint rather than the primary key stay named residuals.
- The check-heuristic fail-safe class: the check-name formula stays a lexical best-effort scan — an expression it misreads keeps its server name — and the class is pinned without tightening.

**In — slice B (built, [#102](https://github.com/osama784/schemamill/issues/102)):**

- Constraint twins, same-kind and cross-kind: an unnamed constraint beside an explicit twin bearing its conventional name on one table — a constraint name is table-scoped, so a check twin colliding with a unique twin's name counts too — is refused like the index case, along with explicit-vs-explicit constraint-name collisions.
- Cross-table same-schema index-name collisions: an index name's uniqueness spans its schema, so two tables' (or a table's and a materialized view's) same-named index creates in one schema are refused under the schema-wide key. Constraint-backed indexes of primary-key, unique, and exclusion constraints claim the same namespace.
- Baseline occupancy: `renderSql` accepts an optional `baseline: Model`; a create that collides with a name the baseline materializes is refused, while a same-identity drop in the plan releases that name so drop-then-recreate still renders. Callers without a baseline keep the plan-local behavior byte-for-byte.
- PostgreSQL 18 unnamed-not-null occupancy: at a declared target of 18 or newer an unnamed `NOT NULL` claims the table-scoped `<table>_<column>_not_null` name the server stores in `pg_constraint`; below 18 it claims nothing. `compare --target-version` and an optional analyzer version option carry the same major to human `compare`.
- Refusal surfacing through the hazard channel: the refusal is both the existing stderr + exit 1 in `plan` and a `render-refusal` hazard reported by `plan` and human `compare` — the stderr line stays, and `compare --json` still emits no hazards.

**Out, named — never silent:** constraint validation against populated tables, which stays data-dependent and named in [hazards](./hazards.md); exclusion constraints as modeled objects ([ADR 0041](../adr/0041-exclusion-constraints-and-index-expressiveness-travel-the-model.md)); and collision suffixes actually assigned by the server, which need catalog knowledge the guard deliberately lacks.

**Deliberately shallow for now:** the guard refuses only what a plan and the baseline it is given can see; a fact that needs the live catalog is named, never guessed.

## Acceptance

- Slice A (met): truncated generated names round-trip to an empty diff (unit and live), a long-named unnamed drop applies (live), omitted referenced columns round-trip (unit and live), truncation collapses refuse with pinned messages, and existing tests and goldens stay byte-identical apart from the intended omitted-referenced-columns re-pin.
- Slice B (met): every residual above has a pinned outcome — refuse, canonicalize, or stay named — with unit tests and, where the CLI surface changes, goldens.
- Refusals are pinned by exact message and by CLI streams and exit codes. Cross-kind and cross-table collisions are pinned by unit tests, and the `name-collision` CLI golden pins the same-table hazard and refusal surface; the gated `baseline-index-occupancy` and PostgreSQL-18-only `unnamed-not-null-occupancy` scenes carry live evidence that the refused twin would fail at apply and the accepted plan applies. The corpus is 584 postgres tests + 63 scenes + 4 always-on live subtests = 651 tests across 63 scenes, and the five PostgreSQL 18 scenes are floored. No local `SCHEMAMILL_TEST_PG_URL` was configured for this slice, so live pass/skip counts come from CI only, where all 63 run on the PostgreSQL 18 leg.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- Slice A: the live suite is green with `truncated-name-round-trip` and `unnamed-fk-round-trip`, and the durable decisions are recorded in [ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md).
- Slice B: the live suite is green with `baseline-index-occupancy` and `unnamed-not-null-occupancy`, and the refusal's surfacing contract is recorded in [ADR 0043](../adr/0043-render-refusals-are-reported-hazards.md) — ADR 0009 stays as written, since accepted ADRs are immutable, and ADR 0043 narrows its boundary by correction.
- Mutation checks are recorded on the slice's tracker issue; the five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Slice B — the remaining guard boundaries** — built in [#102](https://github.com/osama784/schemamill/issues/102) and recorded in [ADR 0043](../adr/0043-render-refusals-are-reported-hazards.md): constraint twins (same-kind and cross-kind) and explicit-vs-explicit constraint-name collisions on one table; cross-table same-schema index-name collisions, including the create-table and add-column claimants; baseline occupancy and the `renderSql` baseline parameter; the unnamed-not-null occupancy question (PostgreSQL 18 only); and refusal surfacing through the hazard channel. What stays deferred from that boundary is named below.
- **Hand-written explicit names longer than 63 bytes** — an explicit name renders as written while PostgreSQL stores its clip, so a hand-written name longer than 63 bytes reads as a change against a dump of what was applied; pinned as a residual, not fixed in slice A ([ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md)).
- **Non-UTF-8 database encodings** — the prediction mirrors `pg_mbcliplen` under a UTF-8 database; any other encoding is a named residual.
- **Catalog-dependent suffix recovery** — knowing which suffix the server actually assigned needs a live catalog read; introspection parity is the [introspection follow-ups](./introspection-attributes.md).
- **Version gating** — version gating for renderer-synthesized forms shipped in the [target version plan](./target-version.md); the guard's conventional-name arithmetic gained one version branch in slice B — PostgreSQL 18 unnamed-not-null occupancy, which exists only when a target major reaches the renderer or the analyzer ([ADR 0043](../adr/0043-render-refusals-are-reported-hazards.md)) — and other cross-major differences stay with the version-aware slice.
