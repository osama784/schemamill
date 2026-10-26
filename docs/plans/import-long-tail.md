# Import long tail — extensions, grants, and exotic objects

**Status:** planned · **Last updated:** 2026-10-24

Real dumps carry far more than the imported subset: extensions, privileges, comments, views, triggers, partitioning, and whole object families the canonical model does not yet name. [#59](https://github.com/osama784/schemamill/issues/59) is the scoping slice its own body asks for; its frozen brief is the [first comment](https://github.com/osama784/schemamill/issues/59#issuecomment-6059861033), the live `pg_dump` capture is the [fact report](https://github.com/osama784/schemamill/issues/59#issuecomment-6059969056), and the [supply-pass promotion](https://github.com/osama784/schemamill/issues/59#issuecomment-6058718000) demanded explicit coverage of the families reserved in [constraints and indexes](./constraints-indexes.md) §Deferred. The anchors: [`core-domain.md`](../domain/core-domain.md) hard problem #1 — import fidelity is "the gate everything else waits behind" — [ADR 0004](../adr/0004-postgresql-only-dialect-seam.md), the [first slice](./first-slice.md) §Out, that §Deferred, and [#33](https://github.com/osama784/schemamill/issues/33)'s decomposition: "Next: views. Then: comments." — comments land last, so they are modeled once. This plan is the long tail's map: every family below is owned by exactly one slice, A–L.

## Goal

Every object family a real `pg_dump` carries either has its own slice or a named deferral, and every fidelity trap inside a family is assigned to the slice that will fix it — no family and no trap falls silently between slices.

## Scope

**In:** the family inventory below; the twelve-slice decomposition A–L and the filing policy (A–F filed now, G–L named for a future supply pass); the named traps and their owners; and two standing rules — comments couple to views (#33) and each family slice carries its own comment surface from the day it models its family, so later families never re-litigate comments; privileges model the already-modeled families (tables, sequences) first, with roles as opaque names, and ACLs on unmodeled families stay named skips until their family lands.

**Out, named — never silent:** beyond-inventory families — schemas as objects, foreign tables/servers, aggregates, operators, casts, collations as objects, event triggers, extended statistics, publications/subscriptions — each keeping its current skip-named behavior, itemized in §Deferred below; introspection parity, where [#76](https://github.com/osama784/schemamill/issues/76) (indexes), [#77](https://github.com/osama784/schemamill/issues/77) (column defaults and attributes), [#79](https://github.com/osama784/schemamill/issues/79) (constraints), and [#80](https://github.com/osama784/schemamill/issues/80) (sequences and identity columns) have shipped, leaving the remaining transport/streaming and CLI/studio surfaces under the [#71](https://github.com/osama784/schemamill/issues/71) umbrella; the import-side gap [#79](https://github.com/osama784/schemamill/issues/79) named — the parser reads `WITHOUT OVERLAPS`/`PERIOD` and not-null `NO INHERIT` while the importer drops them silently — is a named follow-up; data rows; and everything implementation-shaped — each slice's brief decides model shapes, and no ADR is due from this map.

**Deliberately shallow for now:** the `pg_dump` forms are exactly as the fact report records them (`[live-16]` on PostgreSQL 16.15; `[source-cited]` for 17/18 deltas), not re-derived; per-family model shapes are deferred to each slice's brief.

## Inventory

Dispatch covers `CreateStmt`, `AlterTableStmt`, `CreateSeqStmt`, `AlterSeqStmt`, and `IndexStmt` (`import.ts:285–305`); every other statement is skip-named by `describeStatement`, generically `<Node> statement` (`import.ts:2548–2549`). "Unpinned" means no test names the behavior today; the owning slice pins it (slice A pins the families it names).

| Family | Today (import) | pg_dump plain default (flag; `[live-16]` unless labeled) | Owning slice |
| --- | --- | --- | --- |
| Extensions | skip `CREATE EXTENSION pgcrypto` (`import.ts:2539–2542`); no model shape (`model.ts:70–75`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | `CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;` + `COMMENT ON EXTENSION`; members skipped; `--exclude-extension` (17+, `[source-cited]`) | E #91 |
| Ownership | skip `ALTER TABLE action AT_ChangeOwner on …` (`import.ts:1684–1686`); pinned (`reports skips, flags, and failures in dump order`, `import.test.ts:539`) | `ALTER … OWNER TO …` per object (13 in the capture); `--no-owner` | F #92 |
| Grants + `ALTER DEFAULT PRIVILEGES` | GRANT: skip `GRANT statement` (`import.ts:2534–2538`), object `GRANT`; REVOKE: `REVOKE statement`, object `REVOKE` (same branch, `is_grant` discriminates); both pinned (`names every long-tail family in dump order`, `import.test.ts:556`); `ALTER DEFAULT PRIVILEGES` still generic, unpinned, owned by F | `GRANT …`, column `GRANT UPDATE(email) …`, `ALTER DEFAULT PRIVILEGES …`; `--no-acl` | F #92 |
| Views | skip `CREATE VIEW app.v` (`import.ts:2475–2478`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | `CREATE VIEW app.v AS` with the query expanded, not the source text | B #89 |
| Materialized views | skip `CREATE MATERIALIZED VIEW app.mv` (`import.ts:2494–2501`) and `REFRESH MATERIALIZED VIEW app.mv` (`:2502–2505`); `CREATE TABLE AS` stays (`:2497–2500`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | pre-data `CREATE MATERIALIZED VIEW … WITH NO DATA`; post-data `REFRESH` only in data dumps | B #89 |
| Comments | skip `COMMENT ON …` (`import.ts:2521–2525`); the materialized-view and foreign-table keywords now read `MATERIALIZED VIEW` and `FOREIGN TABLE`; pinned (`reports skips, flags, and failures in dump order`, `import.test.ts:545`; long-tail rows `:400–411`) | `COMMENT ON` table/column/extension; `--no-comments` | C #87 |
| Exclusion constraints | inline flag-drop (`import.ts:532–536`; table-level `:880–888`); `ADD CONSTRAINT` skip (`:1629–1637`); pinned (`flags an exclusion constraint instead of modeling it`, `import.test.ts:1815–1834`) | post-data `ALTER TABLE ONLY … ADD CONSTRAINT … EXCLUDE USING gist` | D #90 |
| Expression / partial / `INCLUDE` indexes | whole-index skips (`import.ts:1746–1785`); pinned (`skips whole indexes with elements or clauses outside the minimal envelope`, `import.test.ts:1716–1768`) | verbatim `CREATE INDEX …` (expression, parenthesized predicate, `INCLUDE`); never `CONCURRENTLY` | D #90 |
| Triggers | skip `CREATE TRIGGER trg` (`import.ts:2485–2489`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | `CREATE TRIGGER … FOR EACH ROW EXECUTE FUNCTION …` | G |
| Functions / procedures | skip `CREATE FUNCTION app.f` / `CREATE PROCEDURE app.p` (`import.ts:2479–2484`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | dollar-quoted bodies, `sql` and `plpgsql` | G |
| Rules | skip `CREATE RULE r ON app.t` (`import.ts:2506–2510`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | `CREATE RULE … DO NOTHING` (`DO ALSO` normalized to the default) | G |
| RLS policies + enablement | policy: `CREATE POLICY pol ON app.t` / `ALTER POLICY pol ON app.t` (`import.ts:2511–2520`); enablement: `ALTER TABLE app.rls ENABLE ROW LEVEL SECURITY` (`import.ts:1506–1512`, `:1684–1686`); pinned (`names every long-tail family in dump order`, `import.test.ts:556`) | `CREATE POLICY …` + `ALTER TABLE … ENABLE ROW LEVEL SECURITY`; `--no-policies` (18+, `[source-cited]`) | H |
| Partitioning | parent flagged `partitioning clauses` (`import.ts:946`), children skipped (`:322–331`); pinned (`skips a partition and flags a partitioned table`, `import.test.ts:1985–2007`) | parent `PARTITION BY …`; child as standalone `CREATE TABLE` + `ALTER TABLE ONLY … ATTACH PARTITION …` — not `PARTITION OF` in 16 | I |
| Inheritance | flag `inheritance` (`import.ts:945`), child imported own-columns-only; pinned (`imports LIKE and INHERITS tables partially, flagging the dropped clauses`, `import.test.ts:562`) | `CREATE TABLE app.child ( b integer ) INHERITS (app.parent);` | I |
| `LIKE` | flag `LIKE clause` + zero-column table (`import.ts:378–380`); pinned (`imports LIKE and INHERITS tables partially, flagging the dropped clauses`, `import.test.ts:562`) | never emitted — hand-written DDL only | I |
| Type definitions (enum/domain/composite) | generic fallbacks (`CreateEnumStmt`, `CreateDomainStmt`, `CompositeTypeStmt`, `DefineStmt` → `<Node> statement`, `import.ts:2548–2549`); unpinned, owned by slice J | not captured in the fact report | J |
| Tablespaces | table flag `tablespace` (`import.ts:950`); index skip (`:1759–1761`), pinned (`skips whole indexes with elements or clauses outside the minimal envelope`, `import.test.ts:1765`) | archiver `SET default_tablespace = …;` + `Tablespace:` header token, no DDL clause; `--no-tablespaces` | K |
| Storage parameters | table flag (`import.ts:952`); index skip (`:1756–1758`), pinned (`skips whole indexes with elements or clauses outside the minimal envelope`, `import.test.ts:1766`) | not captured in the fact report | K |
| Attribute representation (generated columns, collation, storage, compression, persistence, typed tables, `ON COMMIT`) | **partially read by [#77](https://github.com/osama784/schemamill/issues/77):** defaults, inline `COLLATE` (`import.ts:577–584`), inline and post-data `STORAGE`/`COMPRESSION` (`:587–603`, `:1679–1680`, `:1882–1920`), and unlogged table persistence incl. `SET LOGGED`/`SET UNLOGGED` (`:953`, `:1669–1677`); still flagged: generated column expressions (`:550–555`), typed-table definitions and `ON COMMIT` (`:947–949`), temporary-table persistence (`:954`), and storage parameters (`:952`); unpinned for the leftovers (owner: slice L) | unlogged `CREATE UNLOGGED TABLE` (its data still dumped by default), inline `COLLATE`, and post-data `SET STORAGE`/`SET COMPRESSION`; `SET LOGGED`/`SET UNLOGGED` is hand-written DDL `pg_dump` never emits; the generated-column, typed-table, `ON COMMIT`, and storage-parameter forms are not captured in the fact report | L — partially closed by [#77](https://github.com/osama784/schemamill/issues/77) |

## Slices

A shipped in #88; B–F are filed as `factory:proposed` now; G–L are named here only — their briefs would churn once A–D reshape the model, and a future supply pass files them from this plan.

- **A. Import diagnostics: pin and correct the long-tail vocabulary.** Shipped in #88, diagnostics-only: the two mislabels are fixed, the families are named, and every family A names is pinned by exact messages and the two partial-import shapes. It adds no model shape, no round-trip, and no live scene; B–L carry the full bar. File: #88
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
- **L. Import attribute representation: generated columns, collation, storage, compression, persistence, typed tables, `ON COMMIT`.** Partially closed by [#77](https://github.com/osama784/schemamill/issues/77) — defaults, inline `COLLATE`, inline and post-data `STORAGE`/`COMPRESSION`, and unlogged table persistence are read, and only generated columns, temporary persistence, typed tables/`ON COMMIT`, and storage parameters remain for L. Named here; filed by a future supply pass.

## Traps

Four fidelity traps sat in the import before #88; A fixed the two wording ones in #88, I owns the two partial-import ones.

- **Matview mislabeled `CREATE TABLE AS`** — fixed in #88: `import.ts:2494–2501` discriminates `objtype` so a materialized view reads `CREATE MATERIALIZED VIEW` while `CREATE TABLE AS` keeps its bytes; pinned by `names every long-tail family in dump order` (`import.test.ts:556`, matview row `:316–321`).
- **REVOKE mislabeled `GRANT statement`** — fixed in #88: `import.ts:2534–2538` discriminates `is_grant`, so GRANT keeps `GRANT statement`/object `GRANT` and REVOKE reads `REVOKE statement`/object `REVOKE`; both REVOKE forms are pinned by `names every long-tail family in dump order` (`import.test.ts:556`, rows `:418–429`).
- **`LIKE` imports a zero-column table** — `import.ts:378–380` flags the clause and imports the table with none of the copied columns; the tag is never emitted by `pg_dump` (`[live-16]`). → I.
- **Inheritance and partitioning import partial tables** — `INHERITS` is flagged (`import.ts:945`) and the child imports own-columns-only, matching the emitted `CREATE TABLE … INHERITS (…)` (`[live-16]`); a partitioned parent is flagged (`:946`) and imports as a plain table while its children are skipped (`:322–331`) — `pg_dump` 16 emits children as `CREATE TABLE` + `ATTACH PARTITION` (`[live-16]`), so a `PARTITION OF`-only matcher would miss the captured form. → I.

## Acceptance

- The inventory has one row per family in the mandated union ([first slice](./first-slice.md) §Out + [constraints and indexes](./constraints-indexes.md) §Deferred + ownership + matviews + the attribute bucket), each with today's behavior and a code/test ref, the `pg_dump` default and its suppression flag, and an owner — no ownerless or missing family.
- Every cited ref matches the working tree; every `pg_dump` claim carries the fact report's `[live-16]`/`[source-cited]` label (uncaptured families say so); trap rows carry evidence.
- Issues A–F exist and link both ways with this plan; A shipped in #88, B–F are `factory:proposed`, and G–L stay named here.
- The [fact report](https://github.com/osama784/schemamill/issues/59#issuecomment-6059969056) stays on #59 with its tier labels; the [first slice](./first-slice.md) §Out and [constraints and indexes](./constraints-indexes.md) §Deferred cross-references point here.
- **The #59 scoping slice was docs-only** — no code files touched, no `CHANGELOG.md` entry; the five gates pass from the repo root. Later family slices (A–L) touch code, pin behavior, and add their own changelog entries as they ship.

## Done means

- Each family slice B–L ships as model shape + import + diff/plan/render + round-trip evidence, pinned by unit tests, goldens, and live-PostgreSQL scenes, as the built plans do.
- Slice A is closed as diagnostics-only in #88: the two mislabeled families read correctly and every family A names is pinned by exact messages and the resulting model shapes for the two partial imports — a deliberately lower bar than B–L's, with no model shape, no round-trip, and no live scene.
- The #59 scoping slice is done when this plan lands, the cross-references point here, and B–F are filed as `factory:proposed`; this plan is the ledger for B–L's statuses.

## Deferred

Named for the slices that own them, never silent:

- **Slices G–L** — named in §Slices; a future supply pass files them.
- **Fallbacks left generic by decision** — type definitions (`CreateEnumStmt`, `CreateDomainStmt`, `CompositeTypeStmt`, `DefineStmt`) stay `<Node> statement`, unpinned, owned by J; role grants (`GrantRoleStmt`) and `ALTER DEFAULT PRIVILEGES` (`AlterDefaultPrivilegesStmt`) → F (#92); tablespace DDL (`CreateTableSpaceStmt`, `DropTableSpaceStmt`, `AlterTableSpaceOptionsStmt`, `AlterTableMoveAllStmt`) → K; the beyond-inventory families below → their own slices.
- **Beyond-inventory families** — schemas as objects (skip-named `CREATE SCHEMA …`, `import.ts:2456–2459`), foreign tables (skip-named `CREATE FOREIGN TABLE …`, `:2490–2493`, and now pinned by `names every long-tail family in dump order`, `import.test.ts:556`), and servers, user mappings, foreign data wrappers, aggregates, operators, casts, collations as objects, event triggers, extended statistics, publications/subscriptions, and roles (all generic fallbacks, `:2548–2549`); each needs its own slice before it can be modeled.
- **Shared nodes with no owning family** — `DropStmt`, `RenameStmt`, and `AlterObjectSchemaStmt` for non-sequence objects, `AlterDefaultPrivilegesStmt` (whose owner is F, #92), and DML/utility nodes stay node-named (`<Node> statement`) until the family slice that owns the dropped/renamed/altered object names them; no family slice contract is implied by the fallback.
- **Rule wording collapses variants** — `CREATE RULE <name> ON <table>` does not distinguish `CREATE OR REPLACE RULE` from `CREATE RULE`, nor `DO ALSO`/`DO INSTEAD` from each other or from `DO NOTHING`; the node cannot tell the `DO … NOTHING` forms apart, so the wording claims none of them.
- **`SELECT … INTO`** — stays `SELECT statement` (skipped `SELECT statement`), never `pg_dump`-emitted, and a different node from `CREATE TABLE AS`.
- **Comment-object abbreviations** — `alterObjectKind` spells `MATERIALIZED VIEW` and `FOREIGN TABLE`; the remaining comment keywords still strip `OBJECT_` (`TABCONSTRAINT`, …), tracked by #87.
- **Catalog-side diagnostic grammar** — untouched: ADR 0011 and ADR 0016 pin the catalog read's grammar; this slice changed only dump-import wording.
- **`position` for mid-statement flags** — remains the statement start; the pins do not assert positions.
- **Introspection parity** — the long tail must reach the introspection families too; [#76](https://github.com/osama784/schemamill/issues/76) (indexes), [#77](https://github.com/osama784/schemamill/issues/77) (column defaults and attributes), [#79](https://github.com/osama784/schemamill/issues/79) (constraints), and [#80](https://github.com/osama784/schemamill/issues/80) (sequences and identity columns) have shipped, leaving the remaining transport/streaming and CLI/studio surfaces under [#71](https://github.com/osama784/schemamill/issues/71). [#79](https://github.com/osama784/schemamill/issues/79)'s catalog read exposes an import-side gap: libpg-query parses `WITHOUT OVERLAPS`, `PERIOD`, and not-null `NO INHERIT` while the importer drops them silently; a follow-up is named for it.
- **Data rows** — the model stays structure-only; `COPY` data is consumed and named `copy-data` (`diagnostic.ts:28`).
