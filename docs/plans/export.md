# Export — project the model as DDL or canonical JSON

**Status:** planned · **Last updated:** 2026-10-30

Export is the model's read-only projection out of the workspace. [#134](https://github.com/osama784/schemamill/issues/134) adds `schemamill export --format ddl|json`; the durable decisions are recorded in [ADR 0023](../adr/0023-export-projects-the-model.md).

## Goal

A workspace can be turned into a reviewable artifact without a database: `--format ddl` prints migration-style SQL that builds the whole model on an empty database (including `CREATE SCHEMA` for every non-`public` schema), and `--format json` prints the canonical model bytes. Both are deterministic, byte-stable, and reviewed like code.

## Scope

**In:** the `export` command (workspace resolution, `--format`, stdout, exit codes); the `ddl` projection `renderSql(plan(EMPTY_MODEL, model))`; the `json` projection `serializeModel(model)`; the new transactional `create-schema` step and its render; the schema inventory rule; CLI goldens and help; the `export-round-trip` live scene; CONTEXT, ADR 0023, and changelog.

**Out, named — never silent:** file output (`--out`); a generated DDL header; markdown/docs projection; a JSON envelope or version field; `drop-schema`, schema ownership/ACL/comments, and empty schemas as modeled objects; schemas referenced only inside opaque text (collation names, view definitions, check/default expressions) or through a foreign key to an unmodeled table; system schemas; version-aware semantics ([#57](https://github.com/osama784/schemamill/issues/57)); studio consumption ([#83](https://github.com/osama784/schemamill/issues/83)); applying SQL, hazard analysis, snapshots; export from a bare dump without a workspace; extension `VERSION`.

## Decisions

- **D1 — Command.** `schemamill export [--format <ddl|json>]`, workspace from `process.cwd()`, default `ddl`, stdout only, no `--verbose`. Failures are one `schemamill: …` line, exit 1, empty stdout.
- **D2 — JSON.** Exactly `serializeModel(model)`: canonical two-space JSON, sorted arrays, `tables`/`sequences`/`views`/`extensions` order, trailing newline, no wrapper.
- **D3 — Serializer.** `serializeModel` is re-exported from `@schemamill/core`; the CLI gains no second serializer and never writes JSON itself.
- **D4 — DDL.** `renderSql(plan(EMPTY_MODEL, model))`; the CLI carries a typed local empty model. Render before writing; a refusal is reported and leaves stdout empty.
- **D5 — Schema step.** `create-schema { schema }`, transactional, rendered `CREATE SCHEMA IF NOT EXISTS <quoted>;`. Idempotent because schemas are not modeled and the target database may already carry the namespace.
- **D6 — Inventory.** One step per schema used by a target object (tables, sequences, views, extension install schemas, identity sequence names) that no baseline object uses; `public` excluded; deduped and name-sorted; emitted at the head of global phase 1, before extensions. Schemas named only inside opaque text (collation names, view definitions, check/default expressions) are not inventoried; identity sequence names are same-schema in practice. Both are named residuals.
- **D7 — Order.** Schemas → extensions → the existing plan order, with schema creation prepended. No schema drops.

## Acceptance

- `export --format ddl` for a model with at least two non-public schemas prints schema creates first (name order), then the model's objects in plan order; the exact bytes are pinned.
- `export --format json` bytes equal `serializeModel(model)`; parsing them yields the canonical model.
- The exported DDL applies to a fresh database with no `setupSql` and round-trips through `importDump` to an empty diff (gated live-PG scene).
- Existing plans with a newly used non-public schema emit `CREATE SCHEMA IF NOT EXISTS` before their objects; all goldens are re-pinned deliberately and every other golden is byte-unchanged.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` are green; `docs:counts --check` reports 0 stale.
- A `[Unreleased]` changelog entry exists.

## Done means

The command, the step, the renderer, the goldens, the live scene, CONTEXT, ADR 0023, and the changelog land together; mutation evidence covers the inventory, order, idempotence, quoting, and both projections; the live suite passes on PG16.15 locally and PG18 in CI.

## Deferred

`--out`; a DDL header; markdown projection; JSON envelope/version; `drop-schema` and schema ownership/ACL/comments; empty schemas as objects; system schemas; version-aware semantics (#57); studio consumption (#83); applying SQL/hazards/snapshots; export from a bare dump; extension `VERSION`; cleanup of redundant `setupSql` schema creates outside `extension-round-trip`.
