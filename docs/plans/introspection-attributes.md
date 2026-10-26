# Introspection attributes — column defaults and representation

**Status:** built · **Last updated:** 2026-10-15

The tracer shipped in [#55](https://github.com/osama784/schemamill/issues/55) (merge `d3ca120`; [ADR 0011](../adr/0011-introspection-transport.md)): `catalogReader` reads tables, columns, and primary keys in one read-only `psql` batch, and catalog state it meets but cannot represent — defaults, generation, identity, persistence, explicit collation, storage, and compression — is flagged, never silent. [#71](https://github.com/osama784/schemamill/issues/71) collects the follow-ups and #55's frozen brief (§D10) names the same list. This slice shipped in [#77](https://github.com/osama784/schemamill/issues/77), its durable decisions recorded in [ADR 0015](../adr/0015-column-attributes-travel-the-model.md): column defaults and the attribute representation now travel the whole path — `Column` carries `collation`, `storage`, and `compression`, each present only when something states it, and `Table` carries `persistence` (`unlogged`; absent means `LOGGED`) — import reads a dump's default text, inline `COLLATE` and `STORAGE`/`COMPRESSION` qualifiers, post-data `SET STORAGE`/`SET COMPRESSION`, `CREATE UNLOGGED TABLE`, and `SET LOGGED`/`SET UNLOGGED`, the plan renders `CREATE UNLOGGED TABLE`, inline `COLLATE`, and post-data `ALTER TABLE ONLY … SET STORAGE`/`SET COMPRESSION` with their `DEFAULT`/`default` resets, with a merged `TYPE` statement restating what a type change resets, and the catalog reads `pg_attrdef`/`pg_get_expr` defaults and the explicit-only attribute state. Introspection cannot recover declarations — the catalog reports effective state, not the DDL that produced it — so canonicalization rules are part of the design, and the dump-import congruence (an introspected model `diff`-empty and deep-equal against the dump import) is the acceptance bar, now met for the covered states: on PostgreSQL 16.15 the gated suite is 327 tests across 46 scenes, 3 skipped — the three PostgreSQL 18 scenes, skipped by name — and all 46 run on the CI's PostgreSQL 18. The new `column-attributes` scene (minServerMajor 16) round-trips defaults added, changed, and removed, collations added, changed between the system and a user spelling, and removed, storage changes and a removal, `pglz` compression added and removed, a simultaneous type-and-collation change, and persistence flipped both ways, with the physical catalog values checked, and `introspection-flags` pins the covered flags gone and the deferred set kept.

## Goal

A live database's column defaults and its persistence, collation, storage, and compression read back as the canonical model — a database built from a model's own plan introspects to a model the existing `diff` considers unchanged for these states — and the flags that named them today disappear.

## Scope

**In:**

- Column defaults: read `pg_attrdef` through `pg_get_expr` so the text matches what the dump importer reads from `pg_dump` under ADR 0011's empty-`search_path` congruence; the model's default stays opaque, whitespace-normalized text.
- Attribute representation into the model: persistence (`LOGGED`/`UNLOGGED`), explicit collation, storage, and compression — the model shape (which are column fields, and persistence a table field) is settled by the brief — with import, diff, plan, and render following so the attributes travel the whole path.
- Canonicalization rules: report only what is explicit — a collation or storage equal to the type's default and no compression are absent, not stated; `attcompression` exists only from PostgreSQL 14 and reads absent on the PG 13 floor through ADR 0011's `jsonb` access; only generated columns keep their flag because their reading stays deferred — identity columns now attach from the catalog's `sequences` read ([#80](https://github.com/osama784/schemamill/issues/80), [ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md)).
- Version behavior: the tracer's PG 13 floor and version-gating stance; the brief decides how much of [#57](https://github.com/osama784/schemamill/issues/57) lands here and what stays deferred.
- Live scenes: raw SQL builds defaults and each attribute, introspection asserts `diff`-empty and deep-equal (order-significant) against the dump import, and the flags scene pins the exact diagnostics — the covered flags gone, the deferred ones kept.

**Out, named — never silent:** identity-column reading and sequences, since shipped in [#80](https://github.com/osama784/schemamill/issues/80) ([ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md)); the ADR 0008 canonicalization debt (`CONCURRENTLY`, `USING INDEX`), closed for indexes by [ADR 0014](../adr/0014-catalog-index-canonicalization.md) ([#76](https://github.com/osama784/schemamill/issues/76)); a client-library transport revisit and large-catalog streaming; and the CLI/studio surface ([#71](https://github.com/osama784/schemamill/issues/71)). Constraint introspection, out of scope here, shipped in [#79](https://github.com/osama784/schemamill/issues/79) with the rules recorded in [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md).

**Deliberately shallow for now:** the slice reads and canonicalizes state the catalog reports; it never guesses a declaration the catalog cannot show, and it adds no write path.

## Acceptance

- The gated scene round-trips for the covered states — introspected model `diff`-empty and deep-equal against the dump import — on the versions CI pins (PostgreSQL 18; 16 and 18 locally where available).
- The covered states' flags disappear from the diagnostics and the deferred states' flags stay, pinned by the flags scene; the mapper's canonicalization rules are pinned by unit tests (explicit versus default collation and storage, compression absent on the floor).
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- The live suite is green with the new scenes and the flag-set change, and a live run summary (PostgreSQL versions, scene names, pass counts) is recorded on the slice's tracker issue.
- The five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Identity persistence** — an identity sequence whose persistence differs from its table's stays flagged by name and unmodeled; generation mode, effective sequence options, and the real sequence name otherwise read from the catalog in [#80](https://github.com/osama784/schemamill/issues/80) ([ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md)), and a live persistence-flags scene stays deferred for the retention-guard and dump reasons that ADR records.
- **Temporary and sequence persistence** — a temporary table and an unlogged or temporary sequence stay flagged; only a table's `unlogged` state is modeled.
- **Statistics targets** — `attstattarget` stays unread; a dump's post-data `ALTER TABLE … ALTER COLUMN … SET STATISTICS` (emitted for a non-default target) is skipped and named, and the catalog's explicit-only gates carry no target.
- **Storage parameters** — table and index `WITH (…)` options stay flagged on import and unread by the catalog.
- **Typed tables and `ON COMMIT`** — flagged on import; not modeled.
- **Generated columns** — generation stays flagged, and the catalog never reads a generated column's `atthasdef` default.
- **Persistence rewrite and lock hazards** — `SET LOGGED`/`SET UNLOGGED` rewrites the table under an access-exclusive lock; the model carries persistence, so the hazard is model-knowable and belongs to the [hazards plan](./hazards.md), which carries the deferred bullet, and a follow-up issue is filed at bookkeeping.
- **Authored default and collation spelling drift** — a hand-authored default text or collation spelling that differs from what a dump writes, and a storage method equal to the type's default, are stated by the model and rendered yet not recoverable from a re-dump; the diff-empty bar is dump-import congruence, which holds.
- **Storage removal below PostgreSQL 16** — `SET STORAGE DEFAULT` needs 16, so the 13–15 floor can state a storage set but not a removal.
- **Inline `STORAGE`/`COMPRESSION` rendering** — read-only support: a dump's qualifiers map to the model words, and the renderer never emits the qualifiers.
- **Transport revisit and streaming, CLI/studio consumption** — the remaining [#71](https://github.com/osama784/schemamill/issues/71) items; the slice adds no surface.
- **Version gating across PostgreSQL majors** — live server detection and the offline target stay with [#57](https://github.com/osama784/schemamill/issues/57).
- **Partitioned-table identity reading** — identity columns on partitioned parents stay unread because partitioned relations are skipped; ordinary-table identity reading shipped in [#80](https://github.com/osama784/schemamill/issues/80) ([ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md)). Constraint introspection shipped in [#79](https://github.com/osama784/schemamill/issues/79) under [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md).
