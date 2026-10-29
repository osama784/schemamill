# Views and materialized views — model, import, diff, plan, render, round-trip

**Status:** built · **Last updated:** 2026-10-27

Views and materialized views are the canonical model's first new object family since sequences: `pg_dump` emits both, and the importer now reads them instead of skipping them whole. The slice shipped in [#89](https://github.com/osama784/schemamill/issues/89) — model shape, import, diff, plan, render, CLI display, a render golden, a CLI golden scene, and a gated live round trip — and its durable decisions are recorded in [ADR 0019](../adr/0019-views-and-materialized-views-travel-the-model.md). It is Slice B of the [import long-tail plan](./import-long-tail.md).

## Goal

A dump's ordinary and materialized views survive import → diff → plan → render without silent loss, and a database built from a model's plan imports back to a model the `diff` considers unchanged, check option and plain-to-materialized kind change included.

## Scope

**In:** `Model.views`; the `View` shape — schema-qualified identity, `materialized`, an opaque canonical `definition`, and an optional `checkOption`; import of `CREATE [OR REPLACE] VIEW` and `CREATE MATERIALIZED VIEW`; named flags for inline attributes the model cannot carry; `view-added`/`view-removed`/`view-changed`; the transactional `create-view`, `drop-view`, and `replace-view` steps; canonical rendering; CLI display and the `views` golden scene; the workspace `views` section; and the `view-round-trip` live scene with its server-derived cross-import check.

**Out, named — never silent:** view reloptions (`WITH (...)`), column lists, persistence modeling, matview tablespace and access method, matview indexes, populated state and `REFRESH`, view output-column comments ([#143](https://github.com/osama784/schemamill/issues/143)) — comments on the view itself shipped in [#87](https://github.com/osama784/schemamill/issues/87) — view grants and ownership ([#92](https://github.com/osama784/schemamill/issues/92)), catalog introspection ([#71](https://github.com/osama784/schemamill/issues/71)), dependency ordering among views, view output columns, recursive views, and `CREATE TABLE AS`. Each is flagged, skipped by name, or listed in §Deferred.

**Deliberately shallow for now:** a view is identified by schema and name, like a sequence; its definition is text the model owns and never parses, so semantic equivalence between two spellings of one query is out of reach, and dependency order among views is not modeled.

## Model shape

`Model` gains a required `views` array beside `tables` and `sequences`, sorted by schema then name. One entity holds both kinds, discriminated by the required `materialized` boolean: both are relations in one namespace and share identity, ordering, and the view group of the diff. A plain view may carry `checkOption` — `local` or `cascaded`, absent meaning none; a workspace that pairs one with `materialized: true` fails closed as `invalid model`, because PostgreSQL has no such object.

`definition` is the SQL body after the top-level `AS`, whitespace-normalized and stripped of a trailing check-option or `WITH [NO] DATA` clause. It is opaque canonical text in the spelling the server's deparse produced, exactly like a check expression or a default; render emits it verbatim, on one line. Core never reconstructs a view from structure, so the model compares definitions as text.

## Import envelope

`ViewStmt` imports a plain view; `CreateTableAsStmt` with `objtype === 'OBJECT_MATVIEW'` imports a materialized view. The body is sliced from the statement's raw SQL — `ViewStmt.query` carries no location — via the relation name's `location` and a quote/dollar-quote/comment-aware scan for the first top-level `AS`; a trailing `WITH LOCAL|CASCADED CHECK OPTION` or `WITH [NO] DATA` is removed, and the body is normalized. A view's check option comes from the clause or a `check_option` reloption, the clause winning when both are stated; a malformed body is skipped and named, never thrown.

Every inline attribute outside the model is flagged by name and the view still imports: reloptions, a view or matview column list, matview access method, tablespace, `IF NOT EXISTS`, an explicit `WITH DATA`, and a clause-less statement's implicit populated state (`WITH NO DATA` itself needs no flag). Non-default persistence is likewise flagged defensively: PostgreSQL rejects unlogged views and materialized views at parse analysis, so the forms are reachable only from hand-authored dumps, and a temporary view is valid but never dumped. A recursive view is skipped and named — the parser rewrites it into a view-named recursive CTE and the raw body loses that CTE, so the stored definition could not be re-rendered; `pg_dump` never emits the form. `REFRESH MATERIALIZED VIEW` and non-matview `CREATE TABLE AS` keep their existing skips. A repeated identity keeps its last definition, which is how a dump's loop-repair dummy followed by `CREATE OR REPLACE VIEW` imports.

## Plan phases

View steps join a plan now ordered in thirteen global phases: extension creates are phase 1; view drops are phase 5, before the table phases, so a removed view cannot block a table or column drop; table operations are phase 6; view creates and then replaces are phase 7, after every table phase, so a view can reference a newly created table or column; comment assertions are phase 12; and the extension alter/drop teardown is phase 13. The three view step kinds are transactional and append to the step union.

## Change strategy

A changed plain view renders `CREATE OR REPLACE VIEW`, which preserves grants, ownership, comments, and dependent views but requires the existing output columns to stay compatible. A changed materialized view, and any change between plain and materialized, renders `DROP … VIEW` plus `CREATE … VIEW … WITH NO DATA`: PostgreSQL cannot replace a materialized view, and the recreate leaves it unpopulated and drops its indexes, grants, dependents, and comment under `RESTRICT`; the terminal comment phase re-asserts a modeled comment ([ADR 0021](../adr/0021-comments-travel-the-model.md)).

Every failure here is PostgreSQL's own error at apply, and view steps are transactional, so a failed apply rolls back the transaction carrying them — the whole plan for a view-only migration — with no partial apply. The common cases are (a) a `CREATE OR REPLACE` that drops, renames, reorders, or type-changes an output column; (b) adding a column before existing ones; (c) dropping a depended-on view before its dependents; (d) creating a view before a view it references; and (e) a kept view whose definition references a dropped sequence, table, or column. The first four are named for follow-ups — view output-column modeling and a dependency graph — and (e) is the pre-existing well-formedness residual the plan has always carried, not closed here.

## Workspace

`model.json` gains a `views` array after `sequences`, always serialized. A model file without the key still reads as no views, so pre-slice workspaces load unchanged; `null` or a non-array fails closed, as does a malformed view object. No format version is introduced ([#54](https://github.com/osama784/schemamill/issues/54)).

## Evidence

Unit tests pin the model and workspace read/write, import forms and every flag, diff field order and copy isolation, the three plan steps and their phases, and render's grammar and matview-replace refusal. The postgres golden `views.sql` and the CLI `views` fixture pair pin add/remove/change of both kinds byte-for-byte; existing goldens are untouched because no existing fixture has views. The gated `view-round-trip` scene redefines a view, rewrites a materialized view, removes one, adds two (one with `WITH LOCAL CHECK OPTION`), and changes one from plain to materialized; its `crossImportChecks` seam asserts the applied and target imports are deep-equal, and its catalog checks read `relkind` and `relispopulated` and only boolean anchors from the server's deparse. No test pins `pg_get_viewdef` text, so a PostgreSQL 18 spelling difference cannot fail a PostgreSQL 16-authored expectation. On PostgreSQL 16.15 the live suite is 388 tests across 49 scenes, 3 skipped — the three PostgreSQL 18 scenes, skipped by name — and all 49 run on the CI's PostgreSQL 18.

## Acceptance

- A dump of plain and materialized views imports both as `Model.views` entries with sorted identities, normalized definitions, and check options; every inline form the model cannot carry is flagged by name, and recursive views are skipped by name.
- `diff` reports add, remove, and change for both kinds, a kind change included; `plan` drops views before the table phases and creates or replaces them after; render emits `CREATE [OR REPLACE] [MATERIALIZED] VIEW` and the matching `DROP`, and refuses a materialized `replace-view`.
- Workspace read compatibility, the goldens, and the gated scene pass; all five gates are green and `pnpm docs:counts --check` reports no stale claim.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.
- The gated suite round-trips `view-round-trip`, and the applied and target imports are deep-equal on the PostgreSQL 16.15 scratch server; CI reruns it on PostgreSQL 18.
- This plan, [ADR 0019](../adr/0019-views-and-materialized-views-travel-the-model.md), the `[Unreleased]` changelog entry, and [#89](https://github.com/osama784/schemamill/issues/89) carry the ship note.

## Deferred

Named, never silent:

- **View reloptions** (`WITH (...)`) — flagged today; modeling is a follow-up. Persistence stays defensive, not a modeling follow-up.
- **Matview indexes** — skipped today as a table that was not imported; modeling them is a follow-up.
- **Matview tablespace, access method, populated state, and `REFRESH`** — flagged or skipped today; `WITH DATA` is flagged.
- **View dependency graph** — topological drop/create ordering and dependency-aware hazards are not modeled.
- **View output columns** — names and types, to preflight `CREATE OR REPLACE` compatibility and support renames and `ALTER VIEW`.
- **Matview rewrite hazard** — the data, index, and grant loss of a rewrite is not analyzed.
- **View output-column comments and view grants/ownership** — output-column comments are [#143](https://github.com/osama784/schemamill/issues/143), flagged today; comments on the view and materialized view themselves shipped in [#87](https://github.com/osama784/schemamill/issues/87) ([comments plan](./comments.md)); grants and ownership are [#92](https://github.com/osama784/schemamill/issues/92).
- **Catalog introspection parity** ([#71](https://github.com/osama784/schemamill/issues/71)) — no view read, and `matches-import` stays view-blind.
- **Workspace format versioning** ([#54](https://github.com/osama784/schemamill/issues/54)) — `views` rides the bare model with absent-means-empty compatibility.
- **Recursive view import and view column-list preservation** — both skipped or flagged today.
