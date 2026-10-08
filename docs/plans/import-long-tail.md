# Import long tail — extensions, grants, and exotic objects

**Status:** planned · **Last updated:** 2026-10-08

Real dumps carry far more than the imported subset: extensions, privileges, comments, views, triggers, partitioning, and whole object families the canonical model does not yet name. [#59](https://github.com/osama784/schemamill/issues/59) is the scoping slice its own body asks for; its frozen brief is the [first comment](https://github.com/osama784/schemamill/issues/59#issuecomment-6059861033), the live `pg_dump` capture is the [fact report](https://github.com/osama784/schemamill/issues/59#issuecomment-6059969056), and the [supply-pass promotion](https://github.com/osama784/schemamill/issues/59#issuecomment-6058718000) demanded explicit coverage of the families reserved in [constraints and indexes](./constraints-indexes.md) §Deferred. The anchors: [`core-domain.md`](../domain/core-domain.md) hard problem #1 — import fidelity is "the gate everything else waits behind" — [ADR 0004](../adr/0004-postgresql-only-dialect-seam.md), the [first slice](./first-slice.md) §Out, that §Deferred, and [#33](https://github.com/osama784/schemamill/issues/33)'s decomposition: "Next: views. Then: comments." — comments land last, so they are modeled once. This plan is the long tail's map: every family below is owned by exactly one slice, A–L.

## Goal

Every object family a real `pg_dump` carries either has its own slice or a named deferral, and every fidelity trap inside a family is assigned to the slice that will fix it — no family and no trap falls silently between slices.

## Scope

**In:** the family inventory below; the twelve-slice decomposition A–L and the filing policy (A–F filed now, G–L named for a future supply pass); the named traps and their owners; and two standing rules — comments couple to views (#33) and each family slice carries its own comment surface from the day it models its family, so later families never re-litigate comments; privileges model the already-modeled families (tables, sequences) first, with roles as opaque names, and ACLs on unmodeled families stay named skips until their family lands.

**Out, named — never silent:** beyond-inventory families — schemas as objects, foreign tables/servers, aggregates, operators, casts, collations as objects, event triggers, extended statistics, publications/subscriptions — each keeping its current skip-named behavior, itemized in §Deferred below; introspection parity, which stays with [#76](https://github.com/osama784/schemamill/issues/76), [#77](https://github.com/osama784/schemamill/issues/77), [#79](https://github.com/osama784/schemamill/issues/79), and [#80](https://github.com/osama784/schemamill/issues/80) under the [#71](https://github.com/osama784/schemamill/issues/71) umbrella; data rows; and everything implementation-shaped — each slice's brief decides model shapes, and no ADR is due from this map.

**Deliberately shallow for now:** the `pg_dump` forms are exactly as the fact report records them (`[live-16]` on PostgreSQL 16.15; `[source-cited]` for 17/18 deltas), not re-derived; per-family model shapes are deferred to each slice's brief.

## Inventory

Dispatch covers `CreateStmt`, `AlterTableStmt`, `CreateSeqStmt`, `AlterSeqStmt`, and `IndexStmt` (`import.ts:240–283`); every other statement is skip-named by `describeStatement`, generically `<Node> statement` (`import.ts:2008–2009`). "Unpinned" means no test names the behavior today; slice A pins it.

| Family | Today (import) | pg_dump plain default (flag; `[live-16]` unless labeled) | Owning slice |
| --- | --- | --- | --- |
| Extensions | skip `CREATE EXTENSION …` (`import.ts:1999–2002`); no model shape (`model.ts:54–60`); unpinned | `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;` + `COMMENT ON EXTENSION`; members skipped; `--exclude-extension` (17+, `[source-cited]`) | E #91 |
| Ownership | skip `ALTER TABLE action AT_ChangeOwner on …` (`import.ts:1281–1287`); pinned (`import.test.ts:322`) | `ALTER … OWNER TO …` per object (13 in the capture); `--no-owner` | F #92 |
| Grants + `ALTER DEFAULT PRIVILEGES` | skip `GRANT statement` (`import.ts:1998`), REVOKE mislabeled the same; pinned (`import.test.ts:230`) | `GRANT …`, column `GRANT UPDATE(email) …`, `ALTER DEFAULT PRIVILEGES …`; `--no-acl` | F #92 |
| Views | skip `CREATE VIEW …` (`import.ts:1962–1965`); unpinned | `CREATE VIEW app.v AS` with the query expanded, not the source text | B #89 |
| Materialized views | skip, mislabeled `CREATE TABLE AS …` (`import.ts:1981–1984`); unpinned | pre-data `CREATE MATERIALIZED VIEW … WITH NO DATA`; post-data `REFRESH` only in data dumps | B #89 |
| Comments | skip `COMMENT ON …` (`import.ts:1985–1989`); pinned (`import.test.ts:328`) | `COMMENT ON` table/column/extension; `--no-comments` | C #87 |
| Exclusion constraints | inline flag-drop (`import.ts:461–465`); `ADD CONSTRAINT` skip (`:1242–1249`); pinned (`import.test.ts:977–996`) | post-data `ALTER TABLE ONLY … ADD CONSTRAINT … EXCLUDE USING gist` | D #90 |
| Expression / partial / `INCLUDE` indexes | whole-index skips (`import.ts:1325–1361`); pinned (`import.test.ts:898–941`) | verbatim `CREATE INDEX …` (expression, parenthesized predicate, `INCLUDE`); never `CONCURRENTLY` | D #90 |
| Triggers | skip `CREATE TRIGGER …` (`import.ts:1972–1976`); unpinned | `CREATE TRIGGER … FOR EACH ROW EXECUTE FUNCTION …` | G |
| Functions / procedures | skip `CREATE FUNCTION`/`PROCEDURE …` (`import.ts:1966–1971`); unpinned | dollar-quoted bodies, `sql` and `plpgsql` | G |
| Rules | generic fallback `RuleStmt statement` (`import.ts:2008–2009`); unpinned | `CREATE RULE … DO NOTHING` (`DO ALSO` normalized to the default) | G |
| RLS policies + enablement | policy: generic `CreatePolicyStmt statement` (`:2008–2009`); enablement: skip `ALTER TABLE action AT_EnableRowSecurity on …` (`:1281–1287`); unpinned | `CREATE POLICY …` + `ALTER TABLE … ENABLE ROW LEVEL SECURITY`; `--no-policies` (18+, `[source-cited]`) | H |
| Partitioning | parent flagged `partitioning clauses` (`import.ts:587`), children skipped (`:296–305`); pinned (`import.test.ts:1147–1169`) | parent `PARTITION BY …`; child as standalone `CREATE TABLE` + `ALTER TABLE ONLY … ATTACH PARTITION …` — not `PARTITION OF` in 16 | I |
| Inheritance | flag `inheritance` (`import.ts:586`), child imported own-columns-only; unpinned | `CREATE TABLE app.child ( b integer ) INHERITS (app.parent);` | I |
| `LIKE` | flag `LIKE clause` + zero-column table (`import.ts:349–351`); unpinned | never emitted — hand-written DDL only | I |
| Type definitions (enum/domain/composite) | generic fallbacks (`CreateEnumStmt`/`DefineStmt`/… `statement`, `import.ts:2008–2009`); unpinned | not captured in the fact report | J |
| Tablespaces | table flag `tablespace` (`import.ts:591`); index skip (`:1337–1340`), pinned (`import.test.ts:909`) | archiver `SET default_tablespace = …;` + `Tablespace:` header token, no DDL clause; `--no-tablespaces` | K |
| Storage parameters | table flag (`import.ts:593`); index skip (`:1333–1336`), pinned (`import.test.ts:910`) | not captured in the fact report | K |
| Attribute representation (generated columns, collation, storage, compression, persistence, typed tables, `ON COMMIT`) | flags: generated (`import.ts:477–480`), collation/storage/compression (`:500–508`), typed table/`ON COMMIT` (`:588–589`), persistence (`:594–595`); unpinned | unlogged `CREATE UNLOGGED TABLE` (its data still dumped by default); the rest not captured in the fact report | L |

## Slices

A–F are filed as `factory:proposed` now; G–L are named here only — their briefs would churn once A–D reshape the model, and a future supply pass files them from this plan.

- **A. Import diagnostics: pin and correct the long-tail vocabulary.** Fix the two mislabels (matview, REVOKE), name the generic fallbacks by family, and pin every currently unpinned long-tail skip with tests. File: #88
- **B. Views and materialized views: model and round-trip.** The first new object family; view comments follow in C. File: #89
- **C. Comments: model and round-trip across the modeled families.** Lands after views (#33); later family slices carry their own comment surface from their first day. File: #87
- **D. Constraint and index expressiveness: exclusion constraints and expression/partial/covering (`INCLUDE`) indexes.** May split at brief time. File: #90
- **E. Extensions: model and round-trip.** Member objects stay skipped; `ALTER EXTENSION … ADD` is binary-upgrade-only, and binary-upgrade dumps are out of scope. File: #91
- **F. Object privileges: ownership, grants, and default privileges.** Modeled families (tables, sequences) first; roles are opaque names; ACLs on unmodeled families remain named skips. File: #92
- **G. Programmable objects: functions/procedures, triggers, rules.** May split at brief time. Named here; filed by a future supply pass.
- **H. Row-level security: policies and enablement flags.** Named here; filed by a future supply pass.
- **I. Partitioning and inheritance (incl. the `LIKE` trap).** Owns the three partial-import traps below. Named here; filed by a future supply pass.
- **J. Type definitions: enum, domain, composite.** Named here; filed by a future supply pass.
- **K. Tablespaces and storage parameters.** Named here; filed by a future supply pass.
- **L. Import attribute representation: generated columns, collation, storage, compression, persistence, typed tables, `ON COMMIT`.** Named here; filed by a future supply pass.

## Traps

Four fidelity traps sit in today's behavior; A fixes the wording ones, I owns the partial-import ones.

- **Matview mislabeled `CREATE TABLE AS`** — `import.ts:1981–1984` labels every `CreateTableAsStmt` `CREATE TABLE AS`; `pg_dump` emits matviews as `CREATE MATERIALIZED VIEW` (`[live-16]`). → A.
- **REVOKE mislabeled `GRANT statement`** — `import.ts:1998` labels every `GrantStmt` `GRANT statement`; a REVOKE parses as the same node. → A.
- **`LIKE` imports a zero-column table** — `import.ts:349–351` flags the clause and imports the table with none of the copied columns; the tag is never emitted by `pg_dump` (`[live-16]`). → I.
- **Inheritance and partitioning import partial tables** — `INHERITS` is flagged (`import.ts:586`) and the child imports own-columns-only, matching the emitted `CREATE TABLE … INHERITS (…)` (`[live-16]`); a partitioned parent is flagged (`:587`) and imports as a plain table while its children are skipped (`:296–305`) — `pg_dump` 16 emits children as `CREATE TABLE` + `ATTACH PARTITION` (`[live-16]`), so a `PARTITION OF`-only matcher would miss the captured form. → I.

## Acceptance

- The inventory has one row per family in the mandated union ([first slice](./first-slice.md) §Out + [constraints and indexes](./constraints-indexes.md) §Deferred + ownership + matviews + the attribute bucket), each with today's behavior and a code/test ref, the `pg_dump` default and its suppression flag, and an owner — no ownerless or missing family.
- Every cited ref matches the working tree; every `pg_dump` claim carries the fact report's `[live-16]`/`[source-cited]` label (uncaptured families say so); trap rows carry evidence.
- Issues A–F exist with `factory:proposed` and link both ways with this plan; G–L stay named here.
- The [fact report](https://github.com/osama784/schemamill/issues/59#issuecomment-6059969056) stays on #59 with its tier labels; the [first slice](./first-slice.md) §Out and [constraints and indexes](./constraints-indexes.md) §Deferred cross-references point here.
- Docs-only: no code files touched, no `CHANGELOG.md` entry; the five gates pass from the repo root.

## Done means

- Each slice ships as model shape + import + diff/plan/render + round-trip evidence, pinned by unit tests, goldens, and live-PostgreSQL scenes, as the built plans do.
- This scoping slice is done when this plan lands, the cross-references point here, and A–F are filed as `factory:proposed`; this plan is the ledger for their statuses.

## Deferred

Named for the slices that own them, never silent:

- **Slices G–L** — named in §Slices; a future supply pass files them.
- **Beyond-inventory families** — schemas as objects (today skip-named `CREATE SCHEMA …`, `import.ts:1943–1945`), foreign tables/servers (foreign tables skip-named `CREATE FOREIGN TABLE …`, `:1977–1979`; servers and user mappings fall through the generic description), and aggregates, operators, casts, collations as objects, event triggers, extended statistics, and publications/subscriptions (all generic fallbacks, `:2008–2009`); each needs its own slice before it can be modeled.
- **Introspection parity** — the long tail must reach the introspection families too; stays with [#76](https://github.com/osama784/schemamill/issues/76), [#77](https://github.com/osama784/schemamill/issues/77), [#79](https://github.com/osama784/schemamill/issues/79), [#80](https://github.com/osama784/schemamill/issues/80) under [#71](https://github.com/osama784/schemamill/issues/71).
- **Data rows** — the model stays structure-only; `COPY` data is consumed and named `copy-data` (`diagnostic.ts:28`).
