# Constraints and indexes — model, import, diff, plan, render, verify

**Status:** built · **Last updated:** 2026-10-03

Unique and check constraints and standalone indexes are first-class table members: the forms a dump or script carries — inline and `ALTER TABLE … ADD CONSTRAINT` unique and check constraints, and `CREATE [UNIQUE] INDEX`, `CONCURRENTLY` included — travel the whole import → diff → plan → render path, and the result was verified against live PostgreSQL. The slice also landed the plan's first non-transactional step kinds and the multi-group display that came due: a concurrent index build applies bare between wrapped transaction groups. The settled decisions are on [#33](https://github.com/osama784/schemamill/issues/33) (design review rounds 1–3, the folded-in `pg_dump` fact report, and the approved brief), the slice's ledger; the durable decision is recorded in [ADR 0008](../adr/0008-index-concurrency-is-declaration-metadata.md).

## Scope

**In:** `UniqueConstraint`, `CheckConstraint`, and `Index` types and their required arrays on `Table`; import of the unique and check constraint forms a dump carries, with unrepresentable constraint attributes flagged and dropped; the standalone `CREATE [UNIQUE] INDEX` envelope, `CONCURRENTLY` included, with whole-index skips for what the model cannot represent; `USING INDEX` consumption; the diff's constraint and index pairing and change vocabulary; the eight plan step kinds; the added-table path; the plan's first non-transactional classification; multi-group SQL separators and CLI display; canonical rendering; and the live scenes and falsification that pin the slice.

**Out, named in diagnostics — never silent:** exclusion constraints; expression, partial, and covering (`INCLUDE`) indexes; `NOT VALID` and deferrability semantics; constraint validation against existing rows (named as a deferred hazard, not analyzed); index renames (remove + add, per doctrine); tablespaces and storage parameters; and views, comments, and every other object family outside the imported subset, which their own slices carry.

**Deliberately shallow for now:** a constraint is identified structurally — ordered columns for unique, the expression text for check — with its name carried but not identity; an index is identified by its name; `concurrently` is apply metadata, not structure; and check expressions stay opaque text, so semantic equivalence such as `a > 0` versus `0 < a` needs catalog knowledge and stays out.

## Model shape

The three members are embedded in `Table`, like foreign keys — `uniqueConstraints`, `checkConstraints`, and `indexes`, each required and possibly empty — so the ordering doctrine in `model.ts` covers them: unique constraints sort by ordered columns then name, checks by expression then name, and indexes by name, each presence-aware with an absent name first. There is no new top-level model array.

- **`UniqueConstraint`** — `name?` and ordered `columns`. Its identity is the ordered column list; the name travels with it when the source has one but is not identity. Two constraints whose structures are equal including the name cancel in the diff; leftovers pair as changed, so a name-only change is a changed constraint and decomposes to a drop and an add at plan level, while a column-list change is a different identity and reads as remove + add.
- **`CheckConstraint`** — `name?` and `expression`, the text between the `CHECK` parentheses, whitespace-normalized at import and opaque to the model. The expression is identity; the name travels and participates in equality exactly as a unique constraint's does.
- **`Index`** — optional `name`, `unique`, ordered `columns`, and optional `concurrently`. Its identity is the name, so a rename reads as remove + add; `unique` and `columns` are structure; `concurrently` is apply metadata excluded from identity and equality, and only steers how a create or drop is applied. The target's flag drives a create, the baseline's drives a drop ([ADR 0008](../adr/0008-index-concurrency-is-declaration-metadata.md)).

A unique constraint is never modeled as, or accompanied by, a standalone `Index` (round 2, decision 2). Inline and `ADD CONSTRAINT` unique declarations produce `UniqueConstraint`s; a standalone `CREATE UNIQUE INDEX` produces an `Index`; and `ADD CONSTRAINT … UNIQUE USING INDEX` consumes the named index into the constraint when the index is a plain column-list unique index. An unnamed constraint or index drop synthesizes PostgreSQL's conventional name best-effort — `<table>_<cols>_key`, `<table>_<column>_check` (or `<table>_check`), `<table>_<cols>_idx` — because collision suffixes cannot be known offline and `pg_dump` always carries real names.

## Import envelope

The importer captures the unique and check forms a dump or script states: column-level and table-level `UNIQUE`/`CHECK` inline in `CREATE TABLE`, and `ALTER TABLE … ADD CONSTRAINT` unique and check constraints, in statement order. PostgreSQL does not record whether a constraint was declared on a column or on the table, so both canonicalize to the table-level array — the folded-in fact report confirmed the emitted forms (PK/UNIQUE always `ALTER TABLE ONLY … ADD CONSTRAINT` in post-data, CHECK always inline carrying its catalog name).

**Constraint attributes are flag-and-drop, following the foreign-key precedent.** `NULLS NOT DISTINCT`, `INCLUDE (…)`, `NO INHERIT`, deferrability, `NOT VALID`, and `NOT ENFORCED` each produce a named flag; the constraint still imports with its representable identity, never silently dropping an attribute. The one whole-constraint skip is reserved for `USING INDEX`: a unique constraint naming an index that is not a plain column-list unique index is skipped and named whole — never partially modeled. When the index is plain, it is consumed: the constraint takes the constraint's name when stated, else the index's, and the index leaves the model. `pg_dump` never emits `USING INDEX`; the rule serves hand-written DDL.

**A standalone `CREATE [UNIQUE] INDEX` is imported only inside a minimal envelope**: a plain btree column list, with the name (optional), `unique`, ordered columns, and `CONCURRENTLY` preserved. Anything else skips the whole index and names it — an expression element, a partial `WHERE`, `INCLUDE`, a non-btree access method, a non-default ordering, operator class, or NULLS ordering, a collation, a tablespace, storage parameters, `NULLS NOT DISTINCT`, an exclusion shape, or an unusable element list. An index is never partially imported. The `pg_dump` report confirmed standalone indexes are emitted as `CREATE [UNIQUE] INDEX <name> ON public.t USING btree (…)` with explicit `USING btree`, and that no separate `CREATE INDEX` is ever emitted for a constraint-backed index.

## Diff pairing

The change vocabulary gained a variant per new object, after the foreign keys and in the model's canonical order: `unique-constraint-added`/`removed`/`changed`, `check-constraint-added`/`removed`/`changed`, and `index-added`/`removed`/`changed`, each `changed` pair carrying its `before` and `after` payloads. Pairing mirrors the foreign-key doctrine: group by identity (ordered columns, expression, name), cancel structurally identical entries first — name included for constraints, `concurrently` excluded for indexes — then pair what remains positionally after sorting each side by a total order, reporting leftovers as removals and additions. Every order is total, so the caller's array order never decides, and structurally equal models produce identical output.

The plan maps the vocabulary mechanically: an addition becomes its add or create step, a removal its drop step, and a changed pair its drop half plus its add half — the drop carrying the baseline payload and the add the target's, which is why the baseline's `concurrently` flag drives a drop and the target's drives a create. A flag-only index difference produces no entry at all.

## Phase placement

Eight new step kinds: `add-unique-constraint`, `drop-unique-constraint`, `add-check-constraint`, `drop-check-constraint`, `create-index`, `drop-index`, and the non-transactional `create-index-concurrently` and `drop-index-concurrently`. The step union is twenty-three kinds.

The table phases are now fifteen, six more than the first slice's nine. Drops sit in table phases 2–4 in the order `drop-index` → `drop-check-constraint` → `drop-unique-constraint`, after `drop-foreign-key` and before `drop-table`, so a constraint or index on a surviving table leaves before the table or column drops that would take its columns away. Creates sit in phases 12–14 in the order `add-unique-constraint` → `add-check-constraint` → `create-index`, after `add-primary-key` and before `add-foreign-key`, so every member attaches only once its columns exist. Changed constraints and indexes decompose into the matching drop and add halves; a removed table or column carries its constraints and indexes away in that drop, so no separate drop step is emitted for them. The step-union comment in `plan.ts` carries the full numbering.

**The added-table path** never inlines a constraint, an index, a foreign key, or an identity: a `table-added` change emits one `create-table` step carrying the columns and primary key only, then member steps in their phases — unique constraints in 12, checks in 13, indexes in 14, foreign keys in 15, and identities in phase 8. Constraints therefore attach only after every referenced table exists, matching the foreign-key and identity doctrine. The create-table payload the renderer receives is guaranteed free of the four member families.

## Concurrent kinds

`create-index-concurrently` and `drop-index-concurrently` are the plan's first non-transactional step kinds; the `TRANSACTIONAL` classification record marks exactly them `false`, and `groupSteps` stands a non-transactional step alone in its own bare group, even beside another. A create step is concurrent exactly when the target index states `concurrently: true`, and a drop step exactly when the baseline index does; because the flag is excluded from structural equality, a flag-only change produces no step and no group. The concurrent kinds render bare (`CREATE INDEX CONCURRENTLY …`, `DROP INDEX CONCURRENTLY …`), with no wrapper lines.

## Multi-group display

The display wording settled in round 2, decision 5, is now live. The single-group headers are unchanged — `N steps in one transaction:`, singular `1 step in one transaction:`, `N steps outside a transaction:` for a single standalone group, and `No changes.` for an empty plan. A multi-group plan reads `N steps in M groups:` with one section line per group — `  group k of M:`, or `  group k of M (standalone):` when the group is non-transactional — its steps indented four spaces and numbered continuously across the plan, so the step list still reads as one ordered migration. In SQL, groups separate with exactly one blank line and nothing else: no comments and no decoration beyond the `BEGIN;`/`COMMIT;` wrappers around transactional groups. A single-group plan and an empty plan render byte-identical to before.

## Evidence

Three levels pin the slice:

- **Unit and golden tests** — core tests pin the model ordering, the constraint and index pairing (ordered-column identity, cancellation including the name, absent-versus-empty names, duplicate-name indexes, flag-only no-ops), the added-table decomposition, and the fifteen-phase order; `packages/postgres/src/render.test.ts` pins the eight rendered forms, the synthesized drop names, and the one-blank-line separator between groups, with the new goldens `constraints.sql`, `indexes.sql`, `index-concurrent.sql`, and `multi-group.sql`; `packages/cli/src/format.test.ts` pins the multi-group header, section lines, and continuous numbering.
- **CLI goldens** — a `constraints-indexes` fixture pair pins `compare` and `plan` byte-for-byte; its plan golden is `13 steps in 4 groups:` with two standalone sections, the concurrent drop first and the concurrent create second.
- **Live PostgreSQL evidence** — the gated suite on PostgreSQL 16.15 is 174 tests across 30 scenes, 0 skipped. Three scenes are new and each round-trips build → migrate → dump → import → empty diff: `constraint-create` (named and unnamed, single- and multi-column unique and check constraints, canonicalized to table level, with `pg_constraint` name spot-checks and an import check that no constraint-backed index is modeled as a standalone `Index`), `index-create` (a plain and a unique standalone index; raw target SQL adds a partial and an expression index the model cannot represent, and the import skips them whole and by name so the migrated and target imports still agree), and `index-concurrently` (a transactional column add, a standalone `CREATE INDEX CONCURRENTLY`, and a second transactional index create; the plan partitions them `wrapped / standalone / wrapped`, the catalog proves the built index `indisvalid`, and both imports prove `CONCURRENTLY` never survives a dump).
- **Falsification** — in the same shape as the transactions slice's stripped-wrappers proof, `index-concurrently`'s rendered concurrent statement is wrapped in `BEGIN;`/`COMMIT;` and applied to a freshly built baseline: real PostgreSQL refuses the run with `cannot run inside a transaction block` and leaves no index behind, while the same statement bare builds a valid index. The two runs differ only in the wrapper lines, and the rendered statement's blank-line isolation is pinned first, so the standalone group is load-bearing through a renderer change.

The slice's `pg_dump` fact report was gathered on a throwaway local cluster and is folded into [#33](https://github.com/osama784/schemamill/issues/33); its constraint forms, ordering, and `CONCURRENTLY` finding are recorded above.

## Done means

- The eight kinds are classified, and every unit test and golden passes.
- The live suite is green with the three new scenes and the concurrent falsification, and every scene round-trips with an exactly empty diff.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Views and comments** — the fact report records their emitted forms for their own slices.
- **Exclusion constraints, expression, partial, and covering (`INCLUDE`) indexes** — whole-object skips today; modeling them needs shapes the model deliberately does not have.
- **`NOT VALID`, deferrability, and constraint-validation hazards** — attributes are flagged and dropped, and adding a unique or check constraint to a populated table can fail validation against existing rows; the gap is named in the [hazards plan](./hazards.md) alongside the `INVALID` index a failed `CONCURRENTLY` build leaves behind.
- **`assertNever` exhaustiveness** — `TRANSACTIONAL`'s `Record` is the only compile-time guard over `Step['kind']`; a default that rejects an unclassified kind would close the gap in a later slice.
- **Introspection canonicalization debt** — `pg_dump` never emits `CONCURRENTLY`, so introspection cannot recover the declaration and must canonicalize; the `USING INDEX` consumption rule needs the same treatment when introspection lands.
