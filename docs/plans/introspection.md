# Introspection tracer bullet — tables, columns, primary keys

**Status:** built · **Last updated:** 2026-10-08

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

- The tracer scene is green in the gated suite, and a live run summary (PostgreSQL versions, scene names, pass counts) is recorded on the slice's tracker issue — [#55](https://github.com/osama784/schemamill/issues/55) carries the local PostgreSQL 16.15 run (34 scenes) and the CI `verify-postgres` run on PostgreSQL 18.
- The five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Indexes** — named and unnamed, unique and plain, including the `CONCURRENTLY` declaration gap below.
- **Constraints** — unique, check, and foreign keys, with their naming and consumption rules.
- **Sequences** — first-class sequence entities with their effective options and ownership.
- **Identity columns** — `GENERATED … AS IDENTITY` with generation mode and sequence options.
- **ADR 0008 canonicalization debt** — `pg_dump` never emits `CONCURRENTLY` and `USING INDEX` consumption needs a catalog-side rule; introspection cannot recover the declaration and must canonicalize rather than guess ([constraints and indexes plan](./constraints-indexes.md)).
- **Version gating** — catalog shape and behavior differences across PostgreSQL majors, and the live server detection and offline target work they depend on ([core domain hard problem #5](../domain/core-domain.md)).

The follow-up work is split across issues filed earlier: [#60](https://github.com/osama784/schemamill/issues/60) collects indexes, constraints, sequences, and identity representation (the ADR 0008 debt included) — proposed by the Oct 5 2026 supply pass — and [#71](https://github.com/osama784/schemamill/issues/71) collects defaults, identity reading, attribute representation, version gating, transport/streaming, and consumers, filed at [#55](https://github.com/osama784/schemamill/issues/55)'s bookkeeping. The Oct 8 2026 supply pass re-cuts the follow-up work: the attribute slice is planned in [introspection attributes](./introspection-attributes.md), and the remaining families stay deferred here. This section stays the source record.
