# Constraint attributes — enforcement, deferrability, and PostgreSQL 18 named NOT NULL constraints

**Status:** planned · **Last updated:** 2026-10-08

Constraint attributes outside the model are flag-and-drop today, following the foreign-key precedent: in the `ALTER TABLE … ADD CONSTRAINT` and table-level `CREATE TABLE` forms a dump emits, `NOT VALID` and `NOT ENFORCED` arrive through the parser's one `skip_validation` channel — a `NOT ENFORCED` foreign key or check constraint is flagged under the `NOT VALID` wording, because `is_enforced` is omitted from the tree rather than false — while the inline column form (`a integer CONSTRAINT c CHECK (a > 0) NOT ENFORCED`) parses to a separate `CONSTR_ATTR_NOT_ENFORCED` node and today imports with that raw enum label in its diagnostic. Deferrability (`DEFERRABLE` / `INITIALLY DEFERRED`) is flagged and dropped, and PostgreSQL 18's named `NOT NULL` constraints are not modeled at all: the inline `CONSTRAINT <name> NOT NULL` form keeps the column's nullability while the name has nowhere to live, the table-level form is flagged and dropped, and the post-data `ADD CONSTRAINT … NOT NULL …` form a PG 18 dump emits is skipped whole. This slice models them so a dump or script's declarations survive import → diff → plan → render. It is scoped from [constraints and indexes](./constraints-indexes.md) §Deferred and the frozen brief's residual list on [#48](https://github.com/osama784/schemamill/issues/48) (§D4); the render guard's decision record is [ADR 0009](../adr/0009-render-refuses-duplicate-conventional-names.md).

## Goal

A constraint's enforcement (`NOT VALID` vs `NOT ENFORCED`), its deferrability, and — for a not-null constraint — its name travel the model, so a dump carrying them imports, diffs, plans, and renders with no attribute collapsed, dropped, or skipped without a name.

## Scope

**In:**

- Split `NOT ENFORCED` from `NOT VALID` in the model, import, and diagnostics: in the `ALTER TABLE … ADD CONSTRAINT` and table-level `CREATE TABLE` forms, the parser delivers both through `skip_validation`, so the importer must read the tree's discriminator — `NOT VALID` carries `is_enforced: true`, `NOT ENFORCED` omits it — instead of the collapsed signal; the inline column form arrives as its own `CONSTR_ATTR_NOT_ENFORCED` node and must stop importing under the raw enum label; and the two enforcement states never share one wording. Dumps emit only the collapsed forms; the inline shape serves hand-written DDL.
- Model deferrability — `DEFERRABLE` and `INITIALLY DEFERRED`; immediate is the default and `INITIALLY DEFERRED` implies deferrable — on the constraints PostgreSQL allows it on: primary key, unique, and foreign key. Check constraints reject it at parse time and stay out.
- Model PostgreSQL 18's named `NOT NULL` constraints: the name travels with the column's not-null fact; the three dump forms import; and a name exactly matching PostgreSQL's generated `<table>_<column>_not_null` canonicalizes back to unnamed, with the same exact-formula and twin-guard discipline as the other conventional names.
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

- **Constraint-validation hazards** — validating a `NOT VALID` constraint against existing rows is data-dependent and stays with the [hazards plan](./hazards.md).
- **Truncation and collision-suffix boundaries** — a generated name truncated at 63 bytes or collision-suffixed (`_key1`, …) stays named; shared with the [render-refusal slice](./render-refusal.md).
- **Introspection parity** — reading these attributes from a live catalog belongs to the [introspection follow-ups](./introspection-attributes.md).
- **`NO INHERIT` not-null constraints** — need inheritance modeling, which stays out.
