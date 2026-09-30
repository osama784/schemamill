# Sequences — model, plan, render, verify

**Status:** built · **Last updated:** 2026-09-30

Sequences as first-class entities in the model: `CREATE SEQUENCE` and the `ALTER SEQUENCE` options that map to modeled fields now travel the whole import → diff → plan → render path, and the result was verified against live PostgreSQL. The settled decisions are on [#16](https://github.com/osama784/schemamill/issues/16) (design review rounds 2–3); the feature landed in [#17](https://github.com/osama784/schemamill/pull/17), and the five verification scenes, the dogfood rerun, and this document in [#18](https://github.com/osama784/schemamill/pull/18).

## Scope

**In:** standalone and owned sequences with schema-qualified identity like tables; the options `AS` (`smallint`, `integer`, `bigint`), `INCREMENT BY`, `MINVALUE`, `MAXVALUE`, `START WITH`, `CACHE`, and `CYCLE`; ownership (`OWNED BY`, `OWNED BY NONE`); import of `CREATE SEQUENCE` (inline `OWNED BY` included) and the `ALTER SEQUENCE` options that map to modeled fields; a `sequences` group in `compare`; `create-sequence`, `alter-sequence`, and `drop-sequence` plan steps; canonical full-explicit rendering.

**Out, named in diagnostics — never silent:** sequence state — `RESTART`, `setval`, `last_value`, and dump-side `DROP SEQUENCE`; `serial`/`bigserial` sugar — the renderer never rewrites an as-written type, and a `nextval(…)` default stays opaque text; sequence renames, `SET SCHEMA`, and unlogged or temporary persistence. Identity columns, flagged on import when this slice landed, have since been modeled in the [identity slice](./identity.md) as a column property distinct from a sequence-backed default.

**Deliberately shallow for now:** a sequence is identified by schema and name, like a table — no rename detection; ownership alone is modeled, so an owned sequence need not back its column's default; hazards, listed here when this slice landed, have since shipped in the [hazards slice](./hazards.md), and transaction grouping stays later work.

## Plan ordering

Sequence steps sit in six global phases around the first slice's table phases, in this exact order:

1. **Creates** — one `create-sequence` per added sequence, in identity order.
2. **Detaches** — `ALTER SEQUENCE … OWNED BY NONE` for a kept sequence whose baseline owner the plan removes and whose ownership the target changes. The detach runs before the owner's drop: PostgreSQL cascades an owned sequence away with its table or column, so a later detach would find it gone.
3. **Table operations** — the first slice's nine phases, unchanged.
4. **Attaches and re-owns** — ownership changes whose baseline owner survives: a first owner, a re-own, or a detach when the target drops ownership but keeps the owner.
5. **Option alters** — one `alter-sequence` per changed sequence, carrying its non-ownership changes.
6. **Drops** — every removed sequence whose owner the plan does not remove, last. A `DROP SEQUENCE` is suppressed exactly when the plan also removes the table or column that owned it, because PostgreSQL cascades it; otherwise the drop comes after the table phases, so a column's `DROP DEFAULT` has already released the sequence. A surviving default that still references a dropped sequence is a self-inconsistent target: the drop is emitted and fails loudly at apply (round 2, decision 8).

## Effective values

Options compare and render on the values PostgreSQL would actually use, so an omitted option and its explicit default are the same sequence, and a target that merely restates defaults is not a change:

- `AS` defaults to `bigint`, `INCREMENT BY` to `1`, `CACHE` to `1`, `CYCLE` to off.
- Ascending (`increment > 0`): `MINVALUE` defaults to `1`, `MAXVALUE` to the type's maximum, `START WITH` to `MINVALUE`. Descending: `MINVALUE` to the type's minimum, `MAXVALUE` to `-1`, `START WITH` to `MAXVALUE`.
- `NO MINVALUE` and `NO MAXVALUE` are the same as omission.

Every numeric option is an exact 64-bit integer in canonical decimal form — never a JavaScript `number`, whose precision stops at `2^53` — so `9223372036854775807`, `-9223372036854775808`, and values past `Number.MAX_SAFE_INTEGER` survive import, diff, and render exactly. On an `AS` change, `diff` applies the engine's conversion before comparing: a bound equal to the old type's bound becomes the new type's, and the plan restates any bound the conversion would move, so `AS integer` with max `2147483647` moving to `AS bigint` with max `2147483647` renders `AS bigint MAXVALUE 2147483647` and converges.

## Rendering

`CREATE SEQUENCE` is canonical and full-explicit — `AS`, `INCREMENT BY`, `MINVALUE`, `MAXVALUE`, `START WITH`, `CACHE`, `CYCLE`/`NO CYCLE` — with effective values, so re-importing the rendered SQL reproduces the same sequence. An option change renders one multi-clause `ALTER SEQUENCE` per changed field set: one clause per changed field, only changed fields present. Ownership stays a separate statement, because the phases require it.

One statement per field set, rather than one per field, is deliberate: PostgreSQL validates `ALTER SEQUENCE` as a whole, so per-field statements can fail on an intermediate state the final one satisfies. The live example starts from a descending sequence advanced to a current value inside the new bounds: `CREATE SEQUENCE ds INCREMENT BY -1`, then fifteen `nextval` calls (current `-15`). There `ALTER SEQUENCE ds MAXVALUE -15` fails (`START value (-1) cannot be greater than MAXVALUE (-15)`), while `ALTER SEQUENCE ds MAXVALUE -15 START WITH -15` in one statement succeeds; on a fresh default sequence both fail on the `MINVALUE`/`MAXVALUE` cross-check, and the multi-clause form still fails on the `RESTART` cross-check while the current value sits outside the new bounds. The one-statement rendering deviates from the brief's per-field wording and is disclosed in [#17](https://github.com/osama784/schemamill/pull/17) and the [changelog](../../CHANGELOG.md).

## The state edge

Sequence state is not modeled: `last_value`, `is_called`, `RESTART`, and `setval` stay outside the model, skip-and-named on import. That makes one class of hand-written target legal in the model but impossible to apply — flipping a sequence's direction, or narrowing a bound below the sequence's stored value, makes PostgreSQL's `ALTER SEQUENCE` cross-check the current value and fail (`START value … cannot be greater than MAXVALUE`, `RESTART value …`). This is deliberate, with the decisions on record: sequence state is out of scope per [#16](https://github.com/osama784/schemamill/issues/16)'s decision 1, a self-inconsistent target fails loudly at apply per decision 8, and state-aware planning belongs to the hazards slice. The verification shapes stay state-independent for the same reason.

The wording follow-up landed with the [identity slice](./identity.md): on an `AS` transition, `compare` now marks the converted baseline bound, so the example prints `max value 9223372036854775807 (converted) → 2147483647` instead of reading as an as-written value. The [changelog](../../CHANGELOG.md) records the fix.

## Verification

Three levels pin the slice:

- **Unit and golden tests** — import normalization (omitted vs explicit defaults, `NO MINVALUE`/`NO MAXVALUE`, direction defaults, `AS` reset conversions, exact 64-bit values), diff field order and effective-value comparison, plan phases, detach, and drop suppression, render create/alter/drop/ownership, and a CLI `sequences` fixture pair whose `compare` and `plan` stdout is pinned byte-for-byte.
- **Live-harness scenes** — five new scenes in `packages/postgres/src/live-scenes.ts`, each round-tripping build → migrate → dump → import → empty diff with catalog checks:
  - `serial-create` — a new table with a new owned sequence-backed default; ownership resolves through `pg_get_serial_sequence` and `pg_depend`, parameters through `pg_sequences`, and a probe insert generates keys `1` and `2`.
  - `sequence-add-drop` — standalone sequences added and removed, parameters checked before and after.
  - `sequence-alter` — increment, start, cache, cycle, the `AS bigint MAXVALUE 2147483647` re-review shape, a re-own, and `OWNED BY NONE`.
  - `owner-drop-order` — a kept sequence detached before its owner's drop, an owner-table drop cascading its sequence (drop suppressed), and an owner-column drop cascading its sequence.
  - `detached-drop` — a surviving column's default dropped before the sequence it references; PostgreSQL refuses the drop while the default still depends on it, so the round trip pins the order.
- **Dogfood** — a regenerated 24-table corpus across `public`, `app`, and `"Sales"` (many `bigserial` primary keys, a standalone `public.invoice_seq START WITH 1000`, and a target adding `public.audit_entries` plus views and comments): plan → extract and apply the plan SQL with no sequences pre-created → re-dump → import → `No changes.`, with the pre-slice contrast that the plan now carries `CREATE SEQUENCE` before `CREATE TABLE` and the old plan failed at `relation "public.audit_entries_id_seq" does not exist`. Commands and output on [#16](https://github.com/osama784/schemamill/issues/16#issuecomment-5893493931).

## Done means

- The five scenes pass against live PostgreSQL, and every harness scene round-trips with an exactly empty diff.
- `compare` and `plan` run end to end on a real `pg_dump` corpus and converge (`No changes.`).
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Non-goals

Sequence state, renames, and transaction grouping are later slices. Identity columns and hazards, listed here when this slice landed, have since shipped in the [identity slice](./identity.md) and the [hazards slice](./hazards.md) respectively. Verification runs against PostgreSQL 16 locally and 18 in CI through the harness's existing gate; the harness itself was not changed.
