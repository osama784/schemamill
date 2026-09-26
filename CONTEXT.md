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
A table's row identifier: an ordered list of its columns, named in the source or left unnamed. A table has at most one.
_Avoid_: pk, key

**Relationship**:
A link between two tables in the model — what the canvas draws and the plan creates or drops. In v1, every relationship comes from a foreign key.
_Avoid_: connection, edge, link

**Foreign key**:
The PostgreSQL constraint behind a relationship. The same fact in the database's language.
_Avoid_: connection, reference

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

**Migration plan**:
The engine's analysis of a diff: the ordered changes that move a baseline to a target, with hazard annotations.
_Avoid_: changeset, script

**Migration SQL**:
The SQL rendering of a migration plan — deterministic and reviewable, for the user to apply.
_Avoid_: script, patch, changeset

**Hazard**:
A risk annotation on a planned change: locks taken, rewrites triggered, downtime risk — what could hurt when the migration runs.
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
