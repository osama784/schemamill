# Introspection attributes — column defaults and representation

**Status:** planned · **Last updated:** 2026-10-08

The tracer shipped in [#55](https://github.com/osama784/schemamill/issues/55) (merge `d3ca120`; [ADR 0011](../adr/0011-introspection-transport.md)): `catalogReader` reads tables, columns, and primary keys in one read-only `psql` batch, and catalog state it meets but cannot represent — defaults, generation, identity, persistence, explicit collation, storage, and compression — is flagged, never silent. [#71](https://github.com/osama784/schemamill/issues/71) collects the follow-ups and #55's frozen brief (§D10) names the same list. This slice reads column defaults and the attribute representation into the model. Introspection cannot recover declarations — the catalog reports effective state, not the DDL that produced it — so canonicalization rules are part of the design, and the dump-import congruence (an introspected model `diff`-empty against the dump import) is the acceptance bar.

## Goal

A live database's column defaults and its persistence, collation, storage, and compression read back as the canonical model — a database built from a model's own plan introspects to a model the existing `diff` considers unchanged for these states — and the flags that named them today disappear.

## Scope

**In:**

- Column defaults: read `pg_attrdef` through `pg_get_expr` so the text matches what the dump importer reads from `pg_dump` under ADR 0011's empty-`search_path` congruence; the model's default stays opaque, whitespace-normalized text.
- Attribute representation into the model: persistence (`LOGGED`/`UNLOGGED`), explicit collation, storage, and compression — the model shape (which are column fields, and persistence a table field) is settled by the brief — with import, diff, plan, and render following so the attributes travel the whole path.
- Canonicalization rules: report only what is explicit — a collation or storage equal to the type's default and no compression are absent, not stated; `attcompression` exists only from PostgreSQL 14 and reads absent on the PG 13 floor through ADR 0011's `jsonb` access; generated and identity columns keep their existing flags because their reading stays deferred.
- Version behavior: the tracer's PG 13 floor and version-gating stance; the brief decides how much of [#57](https://github.com/osama784/schemamill/issues/57) lands here and what stays deferred.
- Live scenes: raw SQL builds defaults and each attribute, introspection asserts `diff`-empty and deep-equal (order-significant) against the dump import, and the flags scene pins the exact diagnostics — the covered flags gone, the deferred ones kept.

**Out, named — never silent:** identity-column reading (its own item in [#71](https://github.com/osama784/schemamill/issues/71)); indexes, constraints, sequences, and identity representation ([#60](https://github.com/osama784/schemamill/issues/60)); the ADR 0008 canonicalization debt (`CONCURRENTLY`, `USING INDEX`); a client-library transport revisit and large-catalog streaming; and the CLI/studio surface.

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

- **Identity-column reading** — generation mode and sequence options from the catalog; its own slice per [#71](https://github.com/osama784/schemamill/issues/71).
- **Indexes, constraints, sequences, and identity representation** — collected by [#60](https://github.com/osama784/schemamill/issues/60), including the ADR 0008 canonicalization debt.
- **Version gating across PostgreSQL majors** — live server detection and the offline target stay with [#57](https://github.com/osama784/schemamill/issues/57).
- **Transport revisit and streaming, CLI/studio consumption** — the remaining [#71](https://github.com/osama784/schemamill/issues/71) items.
