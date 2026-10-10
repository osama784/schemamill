# Constraint attributes — enforcement, deferrability, and PostgreSQL 18 named NOT NULL constraints

**Status:** built · **Last updated:** 2026-10-10

Constraint attributes now travel the model. `ForeignKey` and `CheckConstraint` carry `enforcement` — `not-valid` for `NOT VALID`, `not-enforced` for `NOT ENFORCED` (which implies not-valid), absent meaning valid and enforced — decoded from the parser's single `skip_validation` channel by the `is_enforced` discriminator, so a combined declaration collapses to `not-enforced` and the two wordings are never conflated. `PrimaryKey`, `UniqueConstraint`, and `ForeignKey` carry `deferrable`/`initiallyDeferred`, with `INITIALLY DEFERRED` normalized to imply deferrable. A column carries its not-null constraint's optional name (`Column.notNullName`), and import canonicalizes a name exactly matching PostgreSQL's generated `<table>_<column>_not_null` back to unnamed, so a dump of a model-declared named not-null constraint round-trips. Attribute-only changes decompose to drop and add halves — a changed constraint to its drop/add pair, a not-null fact or name change to the new `drop-not-null`/`add-not-null` steps — and rendered statements carry the attributes in PostgreSQL's order. The settled decisions are on [#74](https://github.com/osama784/schemamill/issues/74) (the frozen brief and its two adversarial partner passes), the slice's ledger; the durable decisions are recorded in [ADR 0012](../adr/0012-constraint-attributes-travel-the-model.md) and [ADR 0009](../adr/0009-render-refuses-duplicate-conventional-names.md); and the slice was scoped from [constraints and indexes](./constraints-indexes.md) §Deferred and the residual list on [#48](https://github.com/osama784/schemamill/issues/48) (§D4).

## Goal

A constraint's enforcement (`NOT VALID` vs `NOT ENFORCED`), its deferrability, and — for a not-null constraint — its name travel the model, so a dump carrying them imports, diffs, plans, and renders with no attribute collapsed, dropped, or skipped without a name.

## Scope

**In:**

- Split `NOT ENFORCED` from `NOT VALID` in the model, import, and diagnostics: in the `ALTER TABLE … ADD CONSTRAINT` and table-level `CREATE TABLE` forms, the parser delivers both through `skip_validation`, so the importer must read the tree's discriminator — `NOT VALID` carries `is_enforced: true`, `NOT ENFORCED` omits it — instead of the collapsed signal; the inline column form arrives as its own `CONSTR_ATTR_NOT_ENFORCED` node and must stop importing under the raw enum label; and the two enforcement states never share one wording. Dumps emit only the collapsed forms; the inline shape serves hand-written DDL.
- Model deferrability — `DEFERRABLE` and `INITIALLY DEFERRED`; immediate is the default and `INITIALLY DEFERRED` implies deferrable — on the constraints PostgreSQL allows it on: primary key, unique, and foreign key. Check constraints reject it at parse time and stay out.
- Model PostgreSQL 18's named `NOT NULL` constraints: the name travels with the column's not-null fact; the three dump forms import; and a name exactly matching PostgreSQL's generated `<table>_<column>_not_null` canonicalizes back to unnamed by exact formula. No twin guard is needed: one not-null fact per column is the only shape the model carries, and a duplicate declaration collapses in the import merge.
- Diff, plan, and render for the new fields: an attribute-only change reads as a changed constraint (or changed column for a not-null name) and decomposes to its drop and add halves, and the rendered statements carry the attributes.
- Import diagnostics, unit tests, CLI goldens, and live-PG scenes for the new forms.

**Out, named — never silent:** constraint validation against populated tables — rendering `NOT VALID` is safe, validating it is data-dependent and stays a named gap in [hazards](./hazards.md); exclusion constraints; `NO INHERIT` and inheritance semantics; and enforcement analysis beyond carrying the declaration.

**Deliberately shallow for now:** the model carries the declarations, not apply-time semantics — a `NOT ENFORCED` constraint still renders as the declaration it is, and the slice does not analyze what PostgreSQL will or will not enforce at apply.

## Acceptance

- A dump of a model-declared `NOT ENFORCED`, `DEFERRABLE INITIALLY DEFERRED`, or PostgreSQL 18 named `NOT NULL` constraint round-trips to an empty diff, with the generated not-null name canonicalized to unnamed.
- The two enforcement wordings are never conflated — pinned by an import test per constraint kind and a diagnostic test — and a name outside its formula stays named.
- Rendered SQL carries the attributes, pinned by render tests and CLI goldens.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- The live suite is green on PostgreSQL 18 with the new scenes; on older majors the new forms' live scenes skip with a named reason, and the model and render paths stay pinned by unit tests.
- Mutation checks are recorded on the slice's tracker issue; the five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Not-null `NOT VALID`** — the validation state of a not-null constraint is flagged and dropped while the enforced not-null fact stays; modeling the state itself waits for a consumer.
- **Multiple named not-null constraints per column** — the model carries one not-null fact per column, so a source stating several named ones collapses to the first with a named flag; a fuller representation belongs with introspection parity.
- **Truncation and collision-suffix boundaries** — a generated name truncated at 63 bytes or collision-suffixed (`_key1`, …) stays named; shared with the [render-refusal slice](./render-refusal.md).
- **Introspection parity** — reading these attributes from a live catalog belongs to the [introspection follow-ups](./introspection-attributes.md) ([#60](https://github.com/osama784/schemamill/issues/60), [#77](https://github.com/osama784/schemamill/issues/77)).
- **`NO INHERIT` not-null constraints** — need inheritance modeling, which stays out.
- **`ALTER CONSTRAINT … ENFORCED`** — the in-place enforcement flip PostgreSQL 18 offers for foreign keys is not rendered; an enforcement change decomposes to a drop and an add.
- **Constraint-validation hazards** — validating a `NOT VALID` constraint against existing rows is data-dependent and stays with the [hazards plan](./hazards.md).
- **Exclusion constraints** — whole-object skips today; their slice is mapped in the [import long tail plan](./import-long-tail.md).
