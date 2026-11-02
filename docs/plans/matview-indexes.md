# Materialized-view indexes — model, import, diff, plan, render, round-trip

**Status:** proposed (supply pass 2026-11-02) · **Last updated:** 2026-11-02

**Size:** M. The brief may split into M1 (model + import + workspace) and M2 (diff/plan/render/CLI) if the index-owner refactor grows, but one brief is recommended: the same `IndexOwner` seam serves both halves, and a split would leave the importer able to store an index the plan cannot drop.

The [views plan](./views.md) (`:66`) defers matview indexes, and [#143](https://github.com/osama784/schemamill/issues/143) explicitly excludes them from its output-column and dependency work. Table indexes are already modeled in the [constraints and indexes plan](./constraints-indexes.md) (`:17-23`) and read by introspection ([introspection plan](./introspection.md) `:39`); a matview index is the same `Index` shape on a materialized view instead of a table. Today the importer finds no table draft and skips the whole statement as a table that was not imported (`packages/postgres/src/import.ts:2416-2421`), pinned by `skips a materialized view index as a table that was not imported` (`packages/postgres/src/import.test.ts:4222`) and by the `view-round-trip` scene's target import check (`packages/postgres/src/live-scenes.ts:5345-5350`). A matview therefore loses a real access path, and a rewrite loses it silently.

## Goal

An index on a materialized view survives dump import → model → diff → plan → render → apply → dump import, using the same `Index` type, identity, canonicalization, and concurrency metadata as a table index; an index on an ordinary view is rejected or flagged by name.

## Scope

**In:**

- `View.indexes`, an optional array of `Index` members present only on materialized views and never on plain views.
- Import of `CREATE [UNIQUE] INDEX … ON <matview>` through the existing minimal index envelope; generated-name canonicalization for a matview index; repeated `CREATE MATERIALIZED VIEW` replaces the view and clears its indexes.
- An index-owner payload for index changes and steps, so one `Index` type and one set of index step kinds serve tables and materialized views.
- Diff: matview index addition, removal, and change; suppression when the matview is recreated, because the recreate carries its indexes.
- Plan: index drops before the view drops and index creates after the view creates, with the existing `CONCURRENTLY` kinds still standing alone.
- Render, CLI display, workspace read/write, goldens, and a gated live round trip whose cross-import check is deep-equal.
- A new ADR for the index-owner shape and the recreate rule; a `[Unreleased]` changelog entry.

**Out, named — never silent:** matview reloptions, tablespace, and access method; populated state and `REFRESH`; the matview dependency graph and topological ordering ([#143](https://github.com/osama784/schemamill/issues/143)); the matview rewrite hazard ([#58](https://github.com/osama784/schemamill/issues/58)); catalog introspection parity for matviews and indexes ([#71](https://github.com/osama784/schemamill/issues/71)); expression, partial, and `INCLUDE` indexes ([#90](https://github.com/osama784/schemamill/issues/90)); index comments ([#146](https://github.com/osama784/schemamill/issues/146)); and the schema-wide duplicate-index-name guard ([#102](https://github.com/osama784/schemamill/issues/102)), which stays owner-scoped here as it is for tables today.

**Deliberately shallow for now:** a matview index is an access path, not a definition of the view. The model does not read the matview's output columns, does not decide whether an index is usable for a query, and does not order dependent views; it only carries the index's name, uniqueness, ordered columns, concurrency flag, and comment on the matview.

## Decisions

- **D1 — `View.indexes`, not a second index type.** `Index` stays exactly as modeled (`packages/core/src/model.ts:293-311`): optional name, `unique`, ordered columns, optional `concurrently`, optional comment. A matview carries an optional `indexes` array (`View` is at `model.ts:393-412`); absent means no indexes, an empty array normalizes to absent, and a plain view carrying a non-empty array fails closed as an invalid model, because PostgreSQL has no such object. The workspace key list and serializer grow the optional key (`packages/core/src/workspace.ts:639-646`, `:537-545`); a pre-slice model without it reads unchanged, and no format version is introduced ([#54](https://github.com/osama784/schemamill/issues/54)).
- **D2 — Generalize ownership in the change engine, not in `Index`.** Index steps and index changes currently name a `TableIdentity` (`packages/core/src/plan.ts:389-395`; `packages/core/src/diff.ts:280-285`). They gain one `IndexOwner` union:
  ```ts
  type IndexOwner =
    | { readonly kind: 'table'; readonly table: TableIdentity }
    | { readonly kind: 'materialized-view'; readonly view: ViewIdentity };
  ```
  Table index steps become `{ owner: { kind: 'table', table }, index }`; matview steps use the view variant. This is the structural cost of the slice: every index step consumer and golden re-pins, while `Index` itself, its identity rules, and its `concurrently` metadata stay untouched. Rejected: a `MatviewIndex` type (a duplicate shape and duplicate canonicalization), a top-level `Model.indexes` array with owner links (workspace churn for every existing table index), and representing a matview as a phantom `Table` (wrong object family and wrong `DROP`).
- **D3 — The same envelope and naming rules.** `translateCreateIndex` resolves the owner in the table drafts first, then the view drafts (`import.ts:2416-2421`, `:2424-2435`); a materialized view attaches through the same envelope classifier and `attachIndex` path. A plain view target is skipped whole and named `CREATE INDEX <name> (indexes are not supported on a plain view)`; an unknown owner keeps a named skip. The minimal envelope is unchanged — an expression element, partial `WHERE`, `INCLUDE`, non-btree access method, non-default ordering, operator class, collation, tablespace, storage parameters, or `NULLS NOT DISTINCT` still skips the whole index (`import.ts:2449-2496`). Generated-name canonicalization runs over the matview's array with the same `synthesizedIndexName`/`indexStructureKey` formula (`import.ts:4032-4046`), which is based on the owner's name and therefore already correct for a matview; a repeated `CREATE MATERIALIZED VIEW` replaces the view wholesale and clears its indexes, matching the table path (`import.ts:536-543`).
- **D4 — Diff is separate from `view-changed`.** A matview index is reported as `view-index-added`, `view-index-removed`, or `view-index-changed` after the view changes and before extensions, with the view identity and the same index pairing as `diffIndexes` (`packages/core/src/diff.ts:1550-1600`). Keeping it out of `ViewFieldChange` is deliberate: a matview index change must not make the matview look changed and trigger a rewrite. A `view-changed` that recreates a matview — a definition change or a kind change — suppresses per-index changes for that identity, because the drop destroys every index and the create must re-create every target index, including unchanged ones. An added matview contributes its indexes through its addition; a removed matview emits no index removals, because the view drop takes them.
- **D5 — Plan order.** The existing `create-index`, `drop-index`, `create-index-concurrently`, and `drop-index-concurrently` kinds take the `IndexOwner` payload. Table-owned index steps keep their table-phase placement: drops in table phase 2 and creates in table phase 17. View-owned index drops join global phase 5 ahead of `drop-view`, so an index is gone before the matview it belongs to; view-owned index creates join global phase 7 after `create-view`/`replace-view`, so the matview exists first. A recreate emits `drop-view`, `create-view … WITH NO DATA`, then one create step per target index; a kept matview's index change emits its drop and create in the same phases. A `CONCURRENTLY` matview index keeps its non-transactional classification and stands alone exactly as a table index does (`plan.ts:457-500`).
- **D6 — Render and naming.** `CREATE [UNIQUE] INDEX [CONCURRENTLY] [name] ON <matview> USING btree (columns);` and `DROP INDEX [CONCURRENTLY] <schema>.<name>;` are the existing renderers with the owner's schema and name (`packages/postgres/src/render.ts:948-974`); PostgreSQL never spells `MATERIALIZED` in an index statement. An unnamed matview index synthesizes `<matview>_<cols>_idx`, the same formula PostgreSQL uses, so a dump of a model-declared unnamed index canonicalizes back to unnamed. The duplicate-name guard keys by the owner identity as today; making it schema-scoped remains [#102](https://github.com/osama784/schemamill/issues/102), and the residual is named rather than silently claimed.
- **D7 — CLI and evidence.** The human formatter gains the view-index change lines and prints an index step's owner as the table or matview identity (`packages/cli/src/format.ts:428-432`, `:519-523`). The gated scene carries a matview with a plain, a unique, and an unnamed index, changes an index and rewrites the matview definition, then proves the applied and target dumps import to models the existing `diff` calls equal, with catalog checks on `pg_class.relkind = 'm'` and `pg_indexes`.

## Acceptance

- A dump with a materialized view and a plain, unique, concurrent, and unnamed index imports to `View.indexes` with the same identity, ordering, and canonicalization a table index gets; the rendered target applies and re-imports to an empty diff.
- Diff reports add, remove, and change for matview indexes without marking the matview changed; a matview rewrite re-creates every target index, and a removed matview emits no orphan index drops.
- Plan places matview index drops before the view drops and creates after the view creates; a concurrent matview index stands alone outside a transaction; table index phases and payload behavior remain unchanged.
- An index on an ordinary view is skipped or flagged by exact wording, never silently imported; an index on an unknown owner is named.
- Workspace round-trip, CLI goldens, the gated live scene, the five gates, and `pnpm docs:counts --check` are green; the ADR, the plan, and a `[Unreleased]` changelog entry land with the slice.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root; the live suite passes on PostgreSQL 16.15 locally and on the CI's PostgreSQL 18.
- The live scene round-trips a matview with all three index shapes and a rewrite, and its cross-import check is deep-equal.
- The plan, the ADR, the changelog entry, and the tracker issue carry the ship note; the [views plan](./views.md) §Deferred marks matview indexes closed.

## Deferred

Named for the slices that own them, never silent:

- **Matview reloptions, tablespace, and access method** — still flagged by the views slice; they are attributes of the view, not of its indexes.
- **Populated state and `REFRESH`** — the model carries no populated state; a created matview is `WITH NO DATA`, and refresh scheduling stays out.
- **Dependency graph and topological ordering** — [#143](https://github.com/osama784/schemamill/issues/143); a matview that depends on another view is still ordered by identity, not dependency.
- **Matview rewrite hazard** — [#58](https://github.com/osama784/schemamill/issues/58); this slice makes the index re-creation explicit, not the data, grant, and dependent loss.
- **Catalog introspection parity** — [#71](https://github.com/osama784/schemamill/issues/71); `catalog.ts` reads no views and its index read is table-scoped (`packages/postgres/src/catalog.ts:401`, `:1048`), so a matview model is intentionally not what the catalog returns yet.
- **Expression, partial, and `INCLUDE` indexes** — [#90](https://github.com/osama784/schemamill/issues/90); the minimal envelope still skips them whole.
- **Index comments on a matview** — the `Index` shape carries a `comment`, but `COMMENT ON INDEX` resolution searches table drafts (`import.ts:1530-1546`) and does not see a matview; the target and catalog reading are follow-ups under [#146](https://github.com/osama784/schemamill/issues/146) and the [comments plan](./comments.md).
- **Schema-wide duplicate-index-name guard** — [#102](https://github.com/osama784/schemamill/issues/102); the guard stays owner-scoped as it is for tables, and a table/matview name collision in one schema is the named residual.
- **Matview table/view name collisions** — [ADR 0019](../adr/0019-views-and-materialized-views-travel-the-model.md) already defers the view/table namespace guard; this slice adds no new identity rule.

## Non-goals

- Refresh scheduling, data population, or `REFRESH MATERIALIZED VIEW`.
- Matview output columns, dependency ordering, or query planning.
- A new index type or a second canonicalization path.
- Changing table-index phases, naming, concurrency semantics, or the minimal index envelope.
- Modeling matview reloptions, tablespace, or access method.
