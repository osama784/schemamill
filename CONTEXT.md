# schemamill

A local-first studio for database schemas: one canonical model, a canvas to shape it, import from DDL text or a live database, semantic diffs, and hazard-annotated migration SQL. This file is the project's glossary — the single place where its language is defined.

## Language

### The model layer

**Model** (canonical model):
schemamill's representation of a database schema — the single source of truth every feature reads and writes. The live, editable side of a comparison.
_Avoid_: schema, entity, class, diagram

**Schema**:
The database structure itself, as it really exists in PostgreSQL. Our representation of it is the model, never "the schema". PostgreSQL also calls a namespace a schema; a table's identity in the model is schema-qualified, e.g. `public.users`.
_Avoid_: model

**Table**:
A named set of columns in the model, identified by its schema and name together, e.g. `public.users`. Tables are what the plan creates, alters, and drops.
_Avoid_: relation, entity

**Column**:
A table's attribute, named as PostgreSQL names it. Tables have columns.
_Avoid_: field, attribute

**Primary key**:
A table's row identifier: an ordered list of its columns, named in the source or left unnamed. A table has at most one. On import, a primary key whose name is exactly PostgreSQL's generated name for it (`<table>_pkey`) is canonicalized back to unnamed, so a dump of a model-declared unnamed primary key round-trips.
_Avoid_: pk, key

**Unique constraint**:
A table constraint requiring an ordered list of its columns to be unique together, named in the source or left unnamed. A unique constraint is never modeled as, or accompanied by, an index. On import, a unique constraint whose name is exactly PostgreSQL's generated name for it (`<table>_<cols>_key`) is canonicalized back to unnamed, so a dump of a model-declared unnamed unique constraint round-trips.
_Avoid_: unique index, key

**Check constraint**:
A table constraint requiring every row to satisfy an expression, stored as opaque, whitespace-normalized text and named in the source or left unnamed. On import, a check constraint whose name is exactly PostgreSQL's generated name for it (`<table>_<column>_check`, or `<table>_check` when the expression does not single out one column) is canonicalized back to unnamed, so a dump of a model-declared unnamed check constraint round-trips.
_Avoid_: validation rule, predicate

**Index**:
A standalone access path over a table's columns. A named index is identified by its name; an unnamed index by its structure — `unique` and ordered columns, with a missing name itself distinct in a diff. A unique constraint is never an index, and a constraint-backed index is consumed into its constraint rather than modeled on its own. On import, an index whose name is exactly PostgreSQL's generated name for its structure (`<table>_<cols>_idx`) is canonicalized back to unnamed, so a dump of a model-declared unnamed index round-trips.
_Avoid_: key, access method

**Concurrent index**:
An index declared `CONCURRENTLY`: apply metadata that steers how its create or drop applies, excluded from structural identity, and stood outside any transaction. The target's declaration drives a create; the baseline's drives a drop.
_Avoid_: online index, non-blocking index

**Relationship**:
A link between two tables in the model — what the canvas draws and the plan creates or drops. In v1, every relationship comes from a foreign key.
_Avoid_: connection, edge, link

**Foreign key**:
The PostgreSQL constraint behind a relationship. The same fact in the database's language. On import, a foreign key whose name is exactly PostgreSQL's generated name for it (`<table>_<cols>_fkey`) is canonicalized back to unnamed, so a dump of a model-declared unnamed foreign key round-trips.
_Avoid_: connection, reference

**Constraint enforcement**:
How a check constraint or foreign key is enforced: absent means valid and enforced, `not-valid` means declared `NOT VALID` — existing rows unchecked, new rows checked — and `not-enforced` means declared `NOT ENFORCED`, which implies not-valid and is never checked. A combined `NOT VALID NOT ENFORCED` declaration collapses to `not-enforced`; the two wordings are never conflated on import.
_Avoid_: enabled/disabled constraint, enforcement state

**Constraint deferrability**:
Whether a primary key, unique constraint, or foreign key is checked immediately or at transaction commit, declared `DEFERRABLE` and optionally `INITIALLY DEFERRED`; immediate is the default, and `INITIALLY DEFERRED` implies deferrable. Check constraints reject deferrability at parse time.
_Avoid_: deferred constraint, deferment

**Not-null constraint name**:
A not-null constraint's name when PostgreSQL 18 names it, carried beside the column's not-null fact — the model has no separate not-null constraint object. On import, a name exactly matching PostgreSQL's generated `<table>_<column>_not_null` is canonicalized back to unnamed, so a dump of a model-declared named not-null constraint round-trips; a name outside the formula stays named.
_Avoid_: column constraint name, NN name

**Snapshot**:
A frozen copy of the model at a point in time. Capture it, name it, list it, compare it.
_Avoid_: version, state, revision

**Baseline**:
The "from" side of a comparison — where a diff starts.
_Avoid_: old, source, from

**Target**:
The "to" side of a comparison — where a diff aims.
_Avoid_: new, destination, to

**Diff**:
The computed difference between a baseline and a target: what actually changed, semantically. "Compare" is the action; the diff is the result.
_Avoid_: comparison, delta, changeset

**Data**:
The rows inside tables. Out of scope: schemamill works on structure, never data.
_Avoid_: records, contents

**Sequence**:
A PostgreSQL object that produces numbers on demand, modeled as a first-class entity with schema-qualified identity, its effective options, and optional ownership.
_Avoid_: counter, autoincrement

**Sequence-backed default**:
A column's `DEFAULT` that calls `nextval()` on a sequence — what the `serial` and `bigserial` sugar produces. The default stays opaque text in the model; the sequence is its own entity, and ownership links the two.
_Avoid_: serial column, autoincrement

**Ownership**:
The link from a sequence to the table column it serves, stated as `OWNED BY`. PostgreSQL drops an owned sequence together with its owning table or column, so the plan detaches before a removed owner and suppresses a redundant drop.
_Avoid_: dependency, association

**Identity column**:
A column declared `GENERATED ALWAYS AS IDENTITY` or `GENERATED BY DEFAULT AS IDENTITY` — a column property carrying its generation mode, its effective sequence options, and an optional schema-qualified sequence name. Never a member of `Model.sequences`.
_Avoid_: serial, sequence column

**Identity sequence**:
The internal sequence attached to an identity column. Created with `ADD GENERATED`, dropped with `DROP IDENTITY` or with its column or table; it is never detached, re-owned, or dropped on its own, and never appears as a `Sequence` in `Model.sequences`. PostgreSQL records the link as a `pg_depend` dependency of type `i`.
_Avoid_: owned sequence, serial sequence

### Crossing the boundary

**Import**:
Bringing a schema into the model from DDL text — a dump or a script.
_Avoid_: ingest, load, sync, reverse-engineer

**Introspection**:
Bringing a schema into the model by reading a live database's catalog, read-only. The verb is introspect.
_Avoid_: import, scan, sync

**DDL dump**:
The textual source import reads: a file or paste of DDL statements.
_Avoid_: SQL file, pg_dump output

**Apply**:
What the user does with migration SQL — runs it against their database. Schemamill never applies; it generates.
_Avoid_: run, execute, deploy

### The change engine

**Change**:
One atom of a diff — a table, column, primary key, foreign key, unique constraint, check constraint, or index added, removed, or changed between a baseline and a target.
_Avoid_: edit, modification, alteration

**Migration plan**:
The engine's analysis of a diff: the ordered changes that move a baseline to a target, partitioned into transaction groups and annotated with hazards.
_Avoid_: changeset, script

**Migration SQL**:
The SQL rendering of a migration plan — deterministic and reviewable, for the user to apply.
_Avoid_: script, patch, changeset

**Transaction group**:
A run of consecutive migration-plan steps that applies as one unit. Transaction-safe steps coalesce into one group; a step PostgreSQL cannot run inside a transaction stands alone. Boundaries are derived from step semantics, never configured by the user. A plan with more than one group displays the group count with one section per group, and its SQL separates the groups with a blank line.
_Avoid_: batch, transaction block, commit point

**Non-transactional step**:
A migration-plan step whose statement PostgreSQL refuses to run inside a transaction. It stands alone, unwrapped; the concurrent index builds — `create-index-concurrently` and `drop-index-concurrently` — are the only such kinds.
_Avoid_: unsafe step, autocommit step

**Hazard**:
A risk annotation on a migration plan. A definite hazard is a self-inconsistent target PostgreSQL rejects at apply, regardless of stored state; a state-dependent hazard — a bound the plan tightens — may fail depending on the sequence's stored value, which is not modeled.
_Avoid_: warning, danger

**Expand/contract**:
The sequencing pattern for safe change: expand (add the new alongside the old), migrate, contract (remove the old).

**Round-trip fidelity**:
Importing, editing, and re-exporting a real schema without losing meaning. The make-or-break quality bar.
_Avoid_: accuracy, completeness

### The product's shape

**Safe-change loop**:
The core workflow: design or import, compare, plan, review — schema change made boring.
_Avoid_: pipeline, workflow

**Studio**:
The local application — server plus canvas — for working visually.
_Avoid_: frontend, web app, UI

**Canvas**:
The studio's editing surface where the model is seen and shaped.
_Avoid_: diagram, board, graph

**Workspace**:
The container that organizes a user's work on disk; the unit the studio and the CLI work within.
_Avoid_: project, folder
