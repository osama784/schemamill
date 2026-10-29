# Introspection tracer bullet — tables, columns, primary keys

**Status:** built — the indexes, constraints, attributes, and sequences/identity follow-ups shipped ([#76](https://github.com/osama784/schemamill/issues/76), [#79](https://github.com/osama784/schemamill/issues/79), [#77](https://github.com/osama784/schemamill/issues/77), [#80](https://github.com/osama784/schemamill/issues/80)) · **Last updated:** 2026-10-26

`CatalogReader.introspect(connection)` was declared in [`packages/core/src/seam.ts`](../../packages/core/src/seam.ts) with no implementation behind it, and DDL import was the only inbound path. The vision puts live introspection beside dumps in the Import stage ([vision §Import](../domain/vision.md)), and [ADR 0008](../adr/0008-index-concurrency-is-declaration-metadata.md) already named canonicalization debt introspection must eventually pay. This slice was the tracer bullet: it proved the seam end-to-end for the smallest meaningful catalog surface — tables, columns, and primary keys — read-only, so the remaining object families inherit a working pattern (connection type, catalog queries, diagnostics, live scenes) instead of a blank socket. It shipped in [#55](https://github.com/osama784/schemamill/issues/55) (PR [#70](https://github.com/osama784/schemamill/pull/70), merge commit `d3ca120`); the transport decision is recorded in [ADR 0011](../adr/0011-introspection-transport.md).

## Goal

A live, read-only PostgreSQL catalog reads back as the canonical model, such that a database built from a model's own plan introspects to a model the existing `diff` considers unchanged — for tables, columns, and primary keys.

## Scope

**In:**

- A `@schemamill/postgres` binding of `CatalogReader`: the connection type it accepts and the `introspect` implementation reached through the seam, not a parallel private path.
- Read-only catalog reads for: tables (schema-qualified, PostgreSQL's own schemas excluded), columns in order with type and nullability, and primary keys as the model's ordered column list.
- The diagnostics channel for catalog state the tracer meets but cannot represent, following the import diagnostic conventions — flagged, never silent.
- Live-PostgreSQL-gated tests: new scene(s) in the existing harness (`packages/postgres/src/live-pg.test.ts`, scenes in `packages/postgres/src/live-scenes.ts`, gated on `SCHEMAMILL_TEST_PG_URL`) build a schema with raw SQL, introspect it, and assert the result `diff`-equals the model imported from that database's `pg_dump` output, for the covered subset. Unset URL skips with a reason, as today; set but unreachable fails loudly.
- A read-only guarantee: introspection issues no write and carries no write path in its surface.

**Out, named — never silent:** every object family past tables, columns, and primary keys; no CLI or studio command gains an introspection surface from this slice; canonical ordering and identity rules stay the model's existing doctrine.

## Acceptance

- The gated scene round-trips: build → introspect → compare against the dump import, exactly empty diff for the covered subset, on the versions CI pins (PostgreSQL 18 in CI; 16 and 18 locally where available).
- The implementation is injected as `CatalogReader` and consumed as such by at least one test, proving the seam carries the work.
- Falsification: dropping one covered fact from the tracer's queries (for example, column order or a primary key) makes the scene fail — the coverage is load-bearing, not decorative.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- The tracer scene is green in the gated suite, and a live run summary (PostgreSQL versions, scene names, pass counts) is recorded on the slice's tracker issue — [#55](https://github.com/osama784/schemamill/issues/55) carries the local PostgreSQL 16.15 run (34 scenes at the time) and the CI `verify-postgres` run on PostgreSQL 18. The suite has since grown to 49 scenes; on PostgreSQL 16.15 it is 388 tests with the three PostgreSQL 18 scenes skipping by name, and all 49 run on the CI's PostgreSQL 18.
- The five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Indexes** — named and unnamed, unique and plain, read back in the plain btree envelope ([#76](https://github.com/osama784/schemamill/issues/76)), with the ADR 0008 canonicalization rules recorded in [ADR 0014](../adr/0014-catalog-index-canonicalization.md). The residuals stay named: expression, partial, and covering (`INCLUDE`) index modeling (named skips today); exclusion-constraint modeling (introspection skips them whole and names them; [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md)); `indisclustered`/`indisreplident`/statistics targets; version gating ([#57](https://github.com/osama784/schemamill/issues/57)); tablespace and storage modeling; and CLI/studio consumption.
- **Constraints** — unique, check, and foreign keys, PostgreSQL 18's named not-null constraints, and a primary key's deferrability, with their naming, consumption, and diagnostic rules ([#79](https://github.com/osama784/schemamill/issues/79)), recorded in [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md). Exclusion constraints are skipped whole and named; their modeling stays deferred.
- **Sequences** — shipped in [#80](https://github.com/osama784/schemamill/issues/80): standalone and owned sequences read back from the catalog with their effective options and ownership, recorded in [ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md). The residuals stay named there and in the [sequences plan](./sequences.md): sequence state, renames and `SET SCHEMA`, unlogged/temporary persistence modeling, extension-member filtering, and import-side `OWNED BY` validation.
- **Identity columns** — shipped in [#80](https://github.com/osama784/schemamill/issues/80): `GENERATED … AS IDENTITY` reads back with generation mode, effective sequence options, and the real sequence name as the column's identity descriptor, never a `Sequence` ([ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md)). Identity persistence modeling and partitioned-table identity reading stay deferred.
- **ADR 0008 canonicalization debt** — resolved by the indexes slice ([#76](https://github.com/osama784/schemamill/issues/76)): a catalog index maps `CONCURRENTLY` absent, because the declaration is unrecoverable and `pg_dump` never emits it either, and a constraint-backed index is consumed by its constraint through the catalog's `conindid` join rather than modeled standalone — the catalog-side counterpart of the importer's `USING INDEX` rule ([ADR 0014](../adr/0014-catalog-index-canonicalization.md)). [ADR 0008](../adr/0008-index-concurrency-is-declaration-metadata.md) stands as written; the dump-side record stays in the [constraints and indexes plan](./constraints-indexes.md).
- **Version gating** — catalog shape and behavior differences across PostgreSQL majors, and the live server detection and offline target work they depend on ([core domain hard problem #5](../domain/core-domain.md)).

The follow-up work is split across issues: [#60](https://github.com/osama784/schemamill/issues/60) collected indexes, constraints, sequences, and identity representation (the ADR 0008 debt included) — proposed by the Oct 5 2026 supply pass — and was closed by the Oct 8 2026 supply pass, which re-cut the work into the indexes slice ([#76](https://github.com/osama784/schemamill/issues/76), shipped), constraints ([#79](https://github.com/osama784/schemamill/issues/79), shipped — [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md)), sequences and identity columns ([#80](https://github.com/osama784/schemamill/issues/80), shipped — [ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md)), and column defaults and attribute representation ([#77](https://github.com/osama784/schemamill/issues/77), shipped — [introspection attributes](./introspection-attributes.md), [ADR 0015](../adr/0015-column-attributes-travel-the-model.md)); [#71](https://github.com/osama784/schemamill/issues/71) carries the remaining follow-ups — transport and streaming, CLI/studio consumption — and version gating stays with [#57](https://github.com/osama784/schemamill/issues/57). This section stays the source record.
