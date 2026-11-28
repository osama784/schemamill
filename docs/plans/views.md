# Views and materialized views — model, import, diff, plan, render, round-trip

**Status:** built · **Last updated:** 2026-11-05

Views and materialized views are the canonical model's first new object family since sequences: `pg_dump` emits both, and the importer now reads them instead of skipping them whole. The slice shipped in [#89](https://github.com/osama784/schemamill/issues/89) — model shape, import, diff, plan, render, CLI display, a render golden, a CLI golden scene, and a gated live round trip — and its durable decisions are recorded in [ADR 0019](../adr/0019-views-and-materialized-views-travel-the-model.md). It is Slice B of the [import long-tail plan](./import-long-tail.md).

## Goal

A dump's ordinary and materialized views survive import → diff → plan → render without silent loss, and a database built from a model's plan imports back to a model the `diff` considers unchanged, check option and plain-to-materialized kind change included.

## Scope

**In:** `Model.views`; the `View` shape — schema-qualified identity, `materialized`, an opaque canonical `definition`, an optional `checkOption`, ordered output `columns`, and `dependsOn` facts; import of `CREATE [OR REPLACE] VIEW` and `CREATE MATERIALIZED VIEW`; named flags for inline attributes the model cannot carry; `view-added`/`view-removed`/`view-changed`; the transactional `create-view`, `drop-view`, and `replace-view` steps; canonical rendering; CLI display and the `views` golden scene; the workspace `views` section; and the `view-round-trip` live scene with its server-derived cross-import check.

**Out, named — never silent:** view reloptions (`WITH (...)`), column lists, persistence modeling, matview tablespace and access method, matview indexes, populated state and `REFRESH`, view output-column comments ([#143](https://github.com/osama784/schemamill/issues/143)) — comments on the view itself shipped in [#87](https://github.com/osama784/schemamill/issues/87) — view grants and ownership ([#92](https://github.com/osama784/schemamill/issues/92)), catalog introspection parity ([#71](https://github.com/osama784/schemamill/issues/71)), partly shipped for views and materialized views in [#146](https://github.com/osama784/schemamill/issues/146) ([ADR 0026](../adr/0026-catalog-comment-reads.md)); recursive views and `CREATE TABLE AS`. Output columns and view dependencies now travel the model and are ordered at plan time ([ADR 0044](../adr/0044-view-output-columns-and-dependencies.md)). Each remaining item is flagged, skipped by name, or listed in §Deferred.

**Deliberately shallow for now:** a view is identified by schema and name, like a sequence; its definition is text the model owns and never parses, so semantic equivalence between two spellings of one query is out of reach. Output columns are carried only for the `CREATE OR REPLACE` compatibility preflight, and dependency facts only for plan-time ordering and refusal — neither reconstructs the query.

## Model shape

`Model` gains a required `views` array beside `tables` and `sequences`, sorted by schema then name. One entity holds both kinds, discriminated by the required `materialized` boolean: both are relations in one namespace and share identity, ordering, and the view group of the diff. A plain view may carry `checkOption` — `local` or `cascaded`, absent meaning none; a workspace that pairs one with `materialized: true` fails closed as `invalid model`, because PostgreSQL has no such object.

`definition` is the SQL body after the top-level `AS`, whitespace-normalized and stripped of a trailing check-option or `WITH [NO] DATA` clause. It is opaque canonical text in the spelling the server's deparse produced, exactly like a check expression or a default; render emits it verbatim, on one line. Core never reconstructs a view from structure, so the model compares definitions as text.

## Import envelope

`ViewStmt` imports a plain view; `CreateTableAsStmt` with `objtype === 'OBJECT_MATVIEW'` imports a materialized view. The body is sliced from the statement's raw SQL — `ViewStmt.query` carries no location — via the relation name's `location` and a quote/dollar-quote/comment-aware scan for the first top-level `AS`; a trailing `WITH LOCAL|CASCADED CHECK OPTION` or `WITH [NO] DATA` is removed, and the body is normalized. A view's check option comes from the clause or a `check_option` reloption, the clause winning when both are stated; a malformed body is skipped and named, never thrown.

Every inline attribute outside the model is flagged by name and the view still imports: reloptions, a view or matview column list, matview access method, tablespace, `IF NOT EXISTS`, an explicit `WITH DATA`, and a clause-less statement's implicit populated state (`WITH NO DATA` itself needs no flag). Non-default persistence is likewise flagged defensively: PostgreSQL rejects unlogged views and materialized views at parse analysis, so the forms are reachable only from hand-authored dumps, and a temporary view is valid but never dumped. A recursive view is skipped and named — the parser rewrites it into a view-named recursive CTE and the raw body loses that CTE, so the stored definition could not be re-rendered; `pg_dump` never emits the form. `REFRESH MATERIALIZED VIEW` and non-matview `CREATE TABLE AS` keep their existing skips. A repeated identity keeps its last definition, which is how a dump's loop-repair dummy followed by `CREATE OR REPLACE VIEW` imports.

## Plan phases

View steps join a plan now ordered in thirteen global phases: schema creates, then extension creates, are phase 1; view drops are phase 5, before the table phases, so a removed view cannot block a table or column drop; table operations are phase 6; view creates and then replaces are phase 7, after every table phase, so a view can reference a newly created table or column; comment assertions are phase 12; and the extension alter/drop teardown is phase 13. The three view step kinds are transactional and append to the step union.

## Change strategy

A changed plain view renders `CREATE OR REPLACE VIEW`, which preserves grants, ownership, comments, and dependent views but requires the existing output columns to stay compatible. A changed materialized view, and any change between plain and materialized, renders `DROP … VIEW` plus `CREATE … VIEW … WITH NO DATA`: PostgreSQL cannot replace a materialized view, and the recreate leaves it unpopulated and drops its indexes, grants, dependents, and comment under `RESTRICT`; the terminal comment phase re-asserts a modeled comment ([ADR 0021](../adr/0021-comments-travel-the-model.md)).

A failure that still reaches apply is PostgreSQL's own error, and view steps are transactional, so a failed apply rolls back the transaction carrying them — the whole plan for a view-only migration — with no partial apply. The common cases were (a) a `CREATE OR REPLACE` that drops, renames, reorders, or type-changes an output column; (b) adding a column before existing ones; (c) dropping a depended-on view before its dependents; (d) creating a view before a view it references; and (e) a kept view whose definition references a dropped sequence, table, or column. Cases (a) and (b) are now preflighted from verifiable output columns and plan a drop and recreate with a diagnostic naming the incompatible column; (c) and (d) are now ordered from dependency facts, with a typed plan-time refusal where no safe order exists ([ADR 0044](../adr/0044-view-output-columns-and-dependencies.md)). Case (e) remains the pre-existing well-formedness residual, not closed here.

## Workspace

`model.json` gains a `views` array after `sequences`, always serialized. A model file without the key still reads as no views, so pre-slice workspaces load unchanged; `null` or a non-array fails closed, as does a malformed view object. The new optional `columns` and `dependsOn` keys are accepted the same way: absent means unknown, and a reader older than this slice rejects them as unknown keys. **Rollback is forward-incompatible:** a workspace saved with `columns` or `dependsOn` fails to parse after reverting until it is re-saved without those keys; no format version is introduced ([#54](https://github.com/osama784/schemamill/issues/54)), so this is a deliberate consequence, not a silent migration.

## Evidence

Unit tests pin the model and workspace read/write, import forms and every flag, diff field order and copy isolation, the three plan steps and their phases, and render's grammar and matview-replace refusal. The postgres golden `views.sql` and the CLI `views` fixture pair pin add/remove/change of both kinds byte-for-byte; existing goldens are untouched because no existing fixture has views. The gated `view-round-trip` scene redefines a view, rewrites a materialized view, removes one, adds two (one with `WITH LOCAL CHECK OPTION`), and changes one from plain to materialized; its `crossImportChecks` seam asserts the applied and target imports are deep-equal, and its catalog checks read `relkind` and `relispopulated` and only boolean anchors from the server's deparse. No test pins `pg_get_viewdef` text, so a PostgreSQL 18 spelling difference cannot fail a PostgreSQL 16-authored expectation. Since [#146](https://github.com/osama784/schemamill/issues/146) the `comment-introspection` scene carries `matches-import` and compares views and comments against the applied dump's import, so the catalog's normalized `pg_get_viewdef` read is live-checked on the same server without pinning its spelling. The corpus is 567 postgres tests + 63 scenes + 4 always-on live subtests = 634 tests across 63 scenes, and the five PostgreSQL 18 scenes are floored with 5 skipped by name. No local `SCHEMAMILL_TEST_PG_URL` was configured, so live pass/skip counts come from CI only, where all 63 run on PostgreSQL 18. [#143](https://github.com/osama784/schemamill/issues/143) adds two gated scenes for the successful cases — a dependent-view chain ordered by the recorded facts and a standalone view whose column is renamed and retyped — while the three refusal cases stay unit- and CLI-pinned with no live claim. Every view-bearing scene now declares `introspectionIgnore` for `view.columns` and `view.dependsOn`, so `matches-import` is not claimed for those fields until catalog parity lands ([#71](https://github.com/osama784/schemamill/issues/71)); [ADR 0044](../adr/0044-view-output-columns-and-dependencies.md) records the rule.

## Acceptance

- A dump of plain and materialized views imports both as `Model.views` entries with sorted identities, normalized definitions, and check options; every inline form the model cannot carry is flagged by name, and recursive views are skipped by name.
- `diff` reports add, remove, and change for both kinds, a kind change included; `plan` drops views before the table phases and creates or replaces them after; render emits `CREATE [OR REPLACE] [MATERIALIZED] VIEW` and the matching `DROP`, and refuses a materialized `replace-view`.
- Workspace read compatibility, the goldens, and the gated scene pass; all five gates are green and `pnpm docs:counts --check` reports no stale claim.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.
- The gated suite round-trips `view-round-trip`, and the applied and target imports are deep-equal on the PostgreSQL 16.15 scratch server; CI reruns it on PostgreSQL 18.
- This plan, [ADR 0019](../adr/0019-views-and-materialized-views-travel-the-model.md), the `[Unreleased]` changelog entry, and [#89](https://github.com/osama784/schemamill/issues/89) carry the ship note.

## Deferred

Named, never silent. The former **view dependency graph** and **view output columns** deferrals are closed by [#143](https://github.com/osama784/schemamill/issues/143) ([ADR 0044](../adr/0044-view-output-columns-and-dependencies.md)): dependency-aware ordering plus a typed plan-time `ViewDependencyError` cover (c) and (d), and output columns preflight (a) and (b). A hazard annotation was rejected because it would leave the failing step emitted, so a caller that ignores hazards still fails at apply ([ADR 0027](../adr/0027-plan-refuses-dangling-target-ownership.md):18). `ALTER VIEW` keeps its own deferral below.

- **View reloptions** (`WITH (...)`) — flagged today; modeling is a follow-up. Persistence stays defensive, not a modeling follow-up.
- **Matview indexes** — closed by [#175](https://github.com/osama784/schemamill/issues/175) ([ADR 0032](../adr/0032-matview-indexes-travel-the-model.md)); no longer deferred.
- **Matview tablespace, access method, populated state, and `REFRESH`** — flagged or skipped today; `WITH DATA` is flagged.
- **Matview rewrite hazard** — the data, index, and grant loss of a rewrite is not analyzed.
- **View output-column comments and view grants/ownership** — output-column comments are [#143](https://github.com/osama784/schemamill/issues/143), flagged today; comments on the view and materialized view themselves shipped in [#87](https://github.com/osama784/schemamill/issues/87) ([comments plan](./comments.md)); grants and ownership are [#92](https://github.com/osama784/schemamill/issues/92).
- **Catalog introspection parity** ([#71](https://github.com/osama784/schemamill/issues/71)) — the view and materialized-view read shipped in [#146](https://github.com/osama784/schemamill/issues/146) slice 1 ([ADR 0026](../adr/0026-catalog-comment-reads.md)), and `matches-import` now covers views and comments through the `comment-introspection` scene. The catalog read does not reproduce import's flags for view reloptions and column lists, and view output-column comments still have no model slot and stay deferred under [#143](https://github.com/osama784/schemamill/issues/143) even though that slice now models the columns themselves.
- **Workspace format versioning** ([#54](https://github.com/osama784/schemamill/issues/54)) — `views` rides the bare model with absent-means-empty compatibility.
- **Recursive view import and view column-list preservation** — both skipped or flagged today.
