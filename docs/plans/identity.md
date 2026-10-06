# Identity columns — model, plan, render, verify

**Status:** built · **Last updated:** 2026-10-03

Identity columns as first-class column properties in the model: the DDL forms a dump or a target carries — inline `GENERATED … AS IDENTITY` in `CREATE TABLE` and `ADD COLUMN`, `ALTER TABLE … ADD GENERATED`, the `SET GENERATED` and sequence-option `SET` clauses, and `DROP IDENTITY` — now travel the whole import → diff → plan → render path, and the result was verified against live PostgreSQL. The settled decisions are on [#20](https://github.com/osama784/schemamill/issues/20) (design review rounds 1–4), which also carries the dogfood evidence; the feature landed in [#21](https://github.com/osama784/schemamill/pull/21), and the five verification scenes and this document form the verification pass that follows it.

## Scope

**In:** inline identity in `CREATE TABLE` and `ADD COLUMN`; `ALTER TABLE … ADD GENERATED … AS IDENTITY`; the `SET GENERATED` and sequence-option `SET` clauses of multi-action `ALTER TABLE`s, applied per clause in engine order; `DROP IDENTITY`; identity as the `identity` part of a changed column in `compare`; the plan steps `drop-identity`, `add-identity`, and `alter-identity`; canonical full-explicit rendering; and conversions between sequence-backed columns and identity in both directions.

**Out, named in diagnostics — never silent:** identity state — `RESTART`, `setval`, and `last_value`; sequence renames and `SET SCHEMA`; `LOGGED`/`UNLOGGED` persistence; `AS` and `OWNED BY` inside identity options; a cross-schema `SEQUENCE NAME` (flagged by name, and the identity is modeled without one); identity on a non-integer column; and partitioned, inheritance, typed, and foreign tables, which stay fenced by the existing table-level flags. An identity action on a column the import did not model as an identity is skipped and named.

**Deliberately shallow for now:** identity is a column property, never a `Sequence` in `Model.sequences`; the internal sequence is not introspected, renamed, or altered on its own; hazards, listed here when this slice landed, have since shipped in the [hazards slice](./hazards.md), and transaction grouping has since shipped in the [transactions slice](./transactions.md).

## Plan ordering

Identity steps open and close the plan's eight global phases, in this exact order:

1. **drop-identity** — every removed identity whose column survives, in diff order. First, always: it must precede the `DROP NOT NULL`/`SET DEFAULT` the table phases put on the same column, and it frees the default sequence name for the replacement sequence the identity→serial conversion creates in phase 2 — or for the replacement identity's own sequence in phase 8.
2. **create-sequence** — one per added sequence, in identity order.
3. **Ownership detaches** — `ALTER SEQUENCE … OWNED BY NONE` where a kept sequence's baseline owner is removed, before the owner's drop.
4. **Table operations** — the nine table phases, unchanged.
5. **Ownership attaches and re-owns** — the ownership changes whose baseline owner survives.
6. **Option alters** — one `alter-sequence` per changed sequence.
7. **drop-sequence** — every removed sequence whose owner the plan does not remove; a column's `DROP DEFAULT` has already released it.
8. **add-identity, then alter-identity** — additions before option alters, in diff order. Last because `ADD GENERATED` manufactures a fresh sequence and refuses a column that still carries a `DEFAULT`: by then the table phases have produced the column, its `SET NOT NULL`, and its `DROP DEFAULT`, and phases 1 and 7 have freed the sequence names the added identities reuse.

A `drop-identity` needs no suppression: an identity reaches the plan as its own removal only when its column survives, and a removed column or table carries its identity away in its own drop.

Both conversions are compositions of those ordinary steps, with no special cases beyond the phase order:

- **serial → identity** — a table-phase `DROP DEFAULT`, a sequence-phase `drop-sequence`, then a phase-8 `add-identity`; the sequence name is free for reuse.
- **identity → serial** — a phase-1 `drop-identity`, a phase-2 `create-sequence`, then a table-phase `SET DEFAULT`.

## Effective values and type

Option normalization reuses `sequence.ts`: `INCREMENT BY` defaults to `1`, `CACHE` to `1`, and `CYCLE` to off; ascending identities default `MINVALUE` to `1` and `MAXVALUE` to the type's maximum, descending ones `MINVALUE` to the type's minimum and `MAXVALUE` to `-1`; `START WITH` defaults to `MINVALUE`/`MAXVALUE` by direction; `NO MINVALUE`/`NO MAXVALUE` are the same as omission. Every numeric option is an exact 64-bit integer in canonical decimal form, never a JavaScript `number`. Identity implies `NOT NULL`; dropping the identity leaves the explicit `notNull` behind.

The identity's sequence type always follows the column, canonicalized across PostgreSQL's integer aliases — `smallint`/`int2`, `integer`/`int`/`int4`, `bigint`/`int8` — and a column outside that family is flagged on import and modeled without an identity. A change between canonical integer types is the engine's `AS` conversion: `diff` applies it to the baseline identity's bounds before comparing, the plan restates only a bound the conversion would move, and `compare` prints the moved value as `<value> (converted)` — the wording follow-up from the [sequences plan](./sequences.md), landed here because the identity type changes reuse the same conversion.

## Sequence names

A descriptor's `sequenceName` is optional and schema-qualified. `diff` compares names only when both sides state one; a stated mismatch is a recreation (`drop-identity` + `add-identity`), never a rename — renames stay out of scope. Absent on either side is a don't-care, an asymmetry with the option fields because the engine's name choice is not computable offline. Render emits `SEQUENCE NAME` exactly when the descriptor holds one.

Import resolves an unqualified `SEQUENCE NAME` to the table's schema — in the inline `CREATE TABLE` and the `ALTER ADD` paths alike, because the namespace is materialized before the engine defines the sequence; `pg_dump` always emits the name qualified. A qualified name in another schema is flagged by name and the identity is modeled without one, so the plan creates the default-named sequence in the table's schema — the only shape the engine supports.

## Rendering

`add-identity` is one full-explicit `ALTER TABLE … ALTER COLUMN … ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY ( … )` with the plan's effective values, option order mirroring `create-sequence` minus `AS` — the type follows the column — and `SEQUENCE NAME` only when modeled. `alter-identity` is one statement carrying repeated `SET GENERATED`/`SET <option>` clauses in the diff's fixed field order (`generated`, `increment`, `minValue`, `maxValue`, `start`, `cache`, `cycle`), never `SET AS` (a parse error) and never a name or persistence clause; one statement, because PostgreSQL validates the option set as a whole, the same reason `alter-sequence` is multi-clause. `drop-identity` is `ALTER TABLE … DROP IDENTITY`. An identity never renders inline in `create-table` or `add-column`: the plan adds it with its own statement.

## The state edge

Identity state is not modeled: `last_value`, `is_called`, `RESTART`, and `setval` stay outside the model, skip-and-named on import. That makes the same class of hand-written target legal in the model but impossible to apply — flipping a direction, or narrowing a bound below the sequence's stored value, makes PostgreSQL's identity `SET` clauses cross-check the sequence's current value and fail (`START value … cannot be greater than MAXVALUE`, `RESTART value …`). This is deliberate, with the decisions on record: state is out of scope per [#20](https://github.com/osama784/schemamill/issues/20), a self-inconsistent target fails loudly at apply ([#16](https://github.com/osama784/schemamill/issues/16) decision 8 extended), and state-aware planning, listed here when this slice landed, stays out of scope in the annotation-only [hazards slice](./hazards.md). The verification shapes stay state-independent for the same reason.

## Verification

Three levels pin the slice:

- **Unit and golden tests** — import normalization (inline identity, `ADD GENERATED`, per-clause `SET` application, `NO MINVALUE`/`NO MAXVALUE` resets, `DROP IDENTITY` keeping `NOT NULL`, skip-and-named exclusions, non-integer types), diff (`added`, `removed`, `recreated`, and field-level `changed`; the both-sides name rule; the type-change conversion), plan (phase order, both conversions, no identity step for an identity that leaves with its column or table), render (the multi-clause `SET`, quoting, both conversions), and a CLI `identity` fixture pair whose `compare` and `plan` stdout is pinned byte-for-byte.
- **Live-harness scenes** — five new scenes in `packages/postgres/src/live-scenes.ts`, each round-tripping build → migrate → dump → import → empty diff with catalog checks:
  - `identity-create` — two tables with four identity columns: `GENERATED ALWAYS` and `BY DEFAULT`, an explicit option set, and descending defaults. `attidentity` (`a`/`d`), `pg_get_serial_sequence`, `pg_depend` deptype `i`, and the sequence parameters are checked, plus the generated keys.
  - `identity-alter` — one multi-clause `SET` per table flips the generation mode and rewrites the options, with the parameters, ownership dependency, and generated keys checked after.
  - `identity-drop` — `DROP IDENTITY` keeping the column and its `NOT NULL`, a dropped identity column, and a dropped identity table: the cascaded internal sequences are gone, the plan emits no explicit `drop-sequence`, and a kept identity survives.
  - `identity-to-sequence` — an identity becomes an owned `nextval` default with a separate `Sequence`: same name, target parameters, ownership, and keys.
  - `sequence-to-identity` — an owned `nextval` default becomes an identity reusing its sequence name: `pg_depend` deptype `i`, no column default, target parameters, and keys.
  - Each scene also checks that the identity columns come back column by column: the harness's retention guard matches every target identity against the re-imported model by `schema.table.column`, rejects an invented or moved identity, and fails the scene on any import diagnostic that names identity.
- **Dogfood** — the sequences slice's 24-table corpus across `public`, `app`, and `"Sales"` (bigserial primary keys, a standalone `public.invoice_seq START WITH 1000`), plus a target that converts `public.audit_log.id` from `bigserial` to `GENERATED ALWAYS AS IDENTITY` reusing `public.audit_log_id_seq` and adds `public.identity_events` with a nameless identity: plan → apply the plan SQL verbatim → re-dump → import → `No changes.`, with no `audit_log_id_seq1` collision, the engine-chosen `public.identity_events_id_seq` for the nameless identity, and `attidentity` `a`/`d` after the migration. Commands and output on [#20](https://github.com/osama784/schemamill/issues/20#issuecomment-5913091302).

On PostgreSQL 16.15 the live suite is 198 tests across 32 scenes, 0 skipped; the `verify-postgres` CI job runs the same harness against PostgreSQL 18.

## Done means

- The five scenes pass against live PostgreSQL, and every harness scene round-trips with an exactly empty diff.
- `compare` and `plan` run end to end on a real `pg_dump` corpus and converge (`No changes.`).
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Non-goals

Introspection of identity columns from a live catalog; state-aware planning; sequence renames and `SET SCHEMA`; identity persistence; and partitioned, inheritance, typed, or foreign tables, which stay behind the existing table-level flags. Transaction grouping, listed here when this slice landed, has since shipped in the [transactions slice](./transactions.md); hazards, likewise listed, have since shipped in the [hazards slice](./hazards.md). Verification runs against PostgreSQL 16 locally and 18 in CI through the harness's existing gate.
