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

**Exclusion constraint**:
A table constraint whose ordered elements and operators must not compare equal for any two rows. Its `elements` are opaque, whitespace-normalized canonical text — operator, operator-class, and collation spelling stays inside them — and it may carry an explicit `accessMethod` (absent means `gist`), a partial `where`, deferrability, and its own comment. A named exclusion constraint travels its name, but identity is the canonical element text; a generated `<table>_<elements>_excl` name is canonicalized back to unnamed on both read paths. Its backing index is consumed into the constraint, never modeled as a standalone index, and a comment on that backing index is flagged rather than copied.
_Avoid_: exclusion rule, exclusion index

**Index**:
A standalone access path over a table's or a materialized view's ordered key elements. Each element is either a column name or an opaque expression; the index may also carry `INCLUDE` columns and a partial `where` clause. A named index is identified by its name; an unnamed index by its structure — `unique`, its authored element order, its `include` columns, and its `where` clause — with a missing name itself distinct in a diff. `concurrently` is apply metadata, never structure. A unique constraint is never an index, and a constraint-backed index is consumed into its constraint rather than modeled on its own. On import, an index whose name is exactly PostgreSQL's generated name for its structure (`<table>_<cols>_idx`) is canonicalized back to unnamed, so a dump of a model-declared unnamed index round-trips.
_Avoid_: key

**Expression index**:
An index whose ordered key elements include an expression, carried as opaque, whitespace-normalized text in an `IndexElement` rather than as a column name. Operator and operator-class spelling stays inside that text; the model has no separate field for it. The renderer emits the text as written, and a generated name uses a best-effort label (a function's last identifier, `nullif`, or `expr`), never deparsed text.
_Avoid_: functional index, computed index

**Partial index**:
An index carrying the `where` clause that limits which rows its access path covers. The field and headword are `where`, not "predicate": **predicate** is the banned synonym for a check constraint's expression. A partial index's `where` participates in identity and equality but not in PostgreSQL's generated-name formula.
_Avoid_: filtered index, predicate index

**Covering (INCLUDE) index**:
An index with `INCLUDE` columns carried after its ordered key elements. These columns are structure — they take part in identity, equality, and the generated-name addition — but they are not keys and cannot back a constraint. A table-owned index may carry them; an index on a materialized view keeps the older named skip.
_Avoid_: covering key, included column

**Operator class**:
PostgreSQL's operator class (`opclass`) for an index element. The model has no operator-class field: any operator-class spelling lives inside the element's opaque expression text, and an explicit `opclass` on a plain column or expression element keeps the whole index out of the envelope.
_Avoid_: opclass as a model field

**Access method**:
PostgreSQL's index access method, e.g. `btree` or `hash`. The model renders `USING btree`; an index declared with another access method is skipped whole and named on import, and a non-btree access method remains a named residual rather than a modeled field.
_Avoid_: index type

**Index owner**:
The relation an index belongs to: a table or a materialized view, carried as a discriminated payload on index changes and steps so one `Index` shape and one set of index steps serve both. An ordinary view cannot own an index; an index on one is skipped by name on import. A table-owned index keeps its identity, ordering, canonicalization, and plan placement unchanged.
_Avoid_: index parent, owning relation

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

**Column collation**:
A column's explicit collation, carried as opaque, whitespace-normalized text in the spelling a dump writes — qualified and quoted, e.g. `pg_catalog."C"` — so it is attribute text, never identity. Absent means the type's default collation. Import keeps the source's spelling as written and the catalog reproduces pg_dump's spelling, so a dump's forms round-trip; a hand-authored spelling that differs from them is a named residual.
_Avoid_: charset, locale, sort order

**Column storage**:
A column's explicit storage method: `plain`, `external`, `extended`, or `main`. Absent means the type's default. A method equal to the type's default reads back as absent from a live catalog — `attstorage` carries no explicit bit — and a dump cannot carry the distinction either.
_Avoid_: toast mode, storage class

**Column compression**:
A column's explicit compression method: `pglz` or `lz4`. Absent means the type's default. `attcompression` exists only from PostgreSQL 14: on the 13 floor the catalog reports no explicit method.
_Avoid_: codec, encoding

**Comment**:
Descriptive text PostgreSQL stores on a modeled entity — a table, column, sequence, view, materialized view, primary key, unique/check/foreign-key/exclusion constraint, index, or extension — carried verbatim as the entity's `comment`, plus the text on a column's named not-null constraint, carried as the same column's `notNullComment`. The not-null surface is the same **Comment**, not a new entity: it travels as a `not-null` `CommentTarget` variant and renders against the column's **Not-null constraint name** or the name synthesized when a generated one was stripped. Absent means no comment; the empty string is not a model value, because `COMMENT … IS ''` removes a comment exactly as `IS NULL` does. A comment is never identity or structure, so a comment-only change never recreates the object it describes.
_Avoid_: description, annotation, docstring, metadata

**Table persistence**:
A table's persistence when it is not PostgreSQL's default: `unlogged`. Absent means `LOGGED`. Temporary persistence is not modeled and stays flagged.
_Avoid_: logging, durability

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
The link from a sequence to the table column it serves, stated as `OWNED BY`. PostgreSQL drops an owned sequence together with its owning table or column, so the plan detaches before a removed owner and suppresses a redundant drop. The plan validates every target sequence's `ownedBy` against the target model and refuses a dangling owner with `SequenceOwnershipError` before building any step. Not the role-level [Object owner](#object-owner), which owns the object itself.
_Avoid_: dependency, association

**Object owner**:
The role that owns a table or sequence, carried as an opaque role name on `owner`. `ALTER … OWNER TO` changes it; a role is cluster-wide and is not a modeled object, so a plan emits the statement as declared and Apply fails if the role is absent. Distinct from [Ownership](#ownership) (`OWNED BY`) and from the grantor of a privilege.
_Avoid_: schema owner, grantor

**Privilege**:
A named access right carried as opaque text on a `Grant` — for example `select`, `update`, or `usage`. `ALL` is the marker for an omitted privilege list, never an expansion: which rights it carries depends on server version, object type, and column level, so an explicit list is never collapsed into it.
_Avoid_: permission, access level

**Grant**:
One privilege assignment to a [Grantee](#grantee) on a table or sequence, carried with its optional column list and `WITH GRANT OPTION`. Grants are compared and rendered in canonical order; a removed object's grants disappear with it, and a grant only one side carries becomes a `grant` or `revoke` step. No grantor is modeled — a non-owner grantor is a named import skip.
_Avoid_: ACL, permission row

**Grantee**:
The role or the literal `PUBLIC` a [Grant](#grant) is made to. Role names are opaque as written; `PUBLIC` stays unquoted in SQL, every other grantee is quoted by need, and role membership is out of scope.
_Avoid_: user, recipient

**Default privileges**:
Privileges that apply to objects created later, scoped by roles and schemas and stated for tables or sequences. Modeled as `DefaultPrivilege` scopes with a `grant` or `revoke` action; repeated statements in one scope merge their grants, and a scope's REVOKE renders before its GRANT. Not the privileges an object inherits from its schema.
_Avoid_: inherited ACL

**Identity column**:
A column declared `GENERATED ALWAYS AS IDENTITY` or `GENERATED BY DEFAULT AS IDENTITY` — a column property carrying its generation mode, its effective sequence options, and an optional schema-qualified sequence name. Never a member of `Model.sequences`.
_Avoid_: serial, sequence column

**Identity sequence**:
The internal sequence attached to an identity column. Created with `ADD GENERATED`, dropped with `DROP IDENTITY` or with its column or table; it is never detached, re-owned, or dropped on its own, and never appears as a `Sequence` in `Model.sequences`. PostgreSQL records the link as a `pg_depend` dependency of type `i`.
_Avoid_: owned sequence, serial sequence

**View**:
A named query stored in the model, identified by its schema and name, e.g. `public.active_accounts`. A view is a relation with a definition, not a table: it has no modeled columns, and a change is a `CREATE OR REPLACE` or a drop and recreate.
_Avoid_: virtual table, query object

**Materialized view**:
A view whose query result is stored. It is the same `View` entity as a plain view, discriminated by `materialized`; PostgreSQL cannot replace one in place, so a change is a drop and recreate, and the model carries no populated state.
_Avoid_: materialized query table, MV

**View definition**:
The SQL body after a view's `AS`, carried as opaque, whitespace-normalized canonical text in the server's deparsed spelling. The model never parses or reconstructs it, and the renderer emits it verbatim.
_Avoid_: view query, view SQL

**View check option**:
A plain view's `WITH [LOCAL|CASCADED] CHECK OPTION`: `local` or `cascaded` in the model, absent meaning none. A materialized view never carries one.
_Avoid_: check constraint, validation rule

**Extension**:
A PostgreSQL extension installed in the database, identified by its name alone: extension names are database-unique and never schema-qualified. Its install schema and comment are attributes, not identity, so moving the extension is an `ALTER EXTENSION … SET SCHEMA`, not a drop and create. The install schema is required because a dump always states it; a definition without one is skipped and named, never defaulted.
_Avoid_: plugin, module, package

**Built-in extension**:
An extension created by `initdb` rather than installed by a user, identified by a `pg_extension.oid` below `FirstNormalObjectId` (16384). A dump never recreates one, so the model never carries one, and the catalog read excludes them by the same rule.
_Avoid_: system extension, default extension

### Crossing the boundary

**Import**:
Bringing a schema into the model from DDL text — a dump or a script.
_Avoid_: ingest, load, sync, reverse-engineer

**Introspection**:
Bringing a schema into the model by reading a live database's catalog, read-only. The verb is introspect.
_Avoid_: import, scan, sync

**Export**:
Projecting the canonical model into a reviewable artifact — migration-style DDL, Markdown, or canonical JSON — without changing the workspace. Read-only: schemamill never applies the SQL it prints.
_Avoid_: dump, save, serialize

**Report artifact**:
A deterministic, human-reviewable document that presents findings another operation already produced, without changing the workspace — the import fidelity report aggregates one DDL dump's diagnostics so a human can judge round-trip fidelity before accepting the Model. It reports on a Schema or a Model but is neither, and is read-only like Export. See Import, DDL dump, Export, Model, Schema, and Round-trip fidelity.
_Avoid_: score, verdict, snapshot

**DDL dump**:
The textual source import reads: a file or paste of DDL statements.
_Avoid_: SQL file, pg_dump output

**Diagnostic**:
A structured finding emitted while working with a schema — from Import, a kind (`skip`, `flag`, or `error`) with a stable code, a source position, a human-facing message, and an owning object on skips and flags. The import fidelity report aggregates the DDL importer's diagnostics for one DDL dump; a live catalog read is Introspection and its findings stay with that owner. See Import, DDL dump, and Round-trip fidelity.
_Avoid_: warning, issue, log line

**Apply**:
What the user does with migration SQL — runs it against their database. Schemamill never applies; it generates.
_Avoid_: run, execute, deploy

### The change engine

**Change**:
One atom of a diff — a table, column, primary key, foreign key, unique constraint, check constraint, index, sequence, view, extension, or comment added, removed, or changed between a baseline and a target.
_Avoid_: edit, modification, alteration

**Migration plan**:
The engine's analysis of a diff: the ordered changes that move a baseline to a target, partitioned into transaction groups and annotated with hazards.
_Avoid_: changeset, script

**Migration SQL**:
The SQL rendering of a migration plan — deterministic and reviewable, for the user to apply.
_Avoid_: script, patch, changeset

**Target version**:
The PostgreSQL major a migration plan's SQL is generated for, declared offline — `plan --target-version <major>`, or `export --target-version <major>` for the read-only projection, default 13, the documented floor. Export accepts and forwards the same major, but its create-only projection is byte-invariant today because every export step is a create. The renderer synthesizes nothing above it: a synthesized statement whose form postdates the target is refused by name, while a declaration the model carries still renders as declared. A form with an equivalent fallback renders the fallback below its floor — the in-place foreign-key enforcement flip does exactly that — which is distinct from a declaration (rendered as declared) and from a synthesized reset (refused). Distinct from the diff's **Target** side, which is a model, not a server major.
_Avoid_: server version, PG version, dialect, version

**Transaction group**:
A run of consecutive migration-plan steps that applies as one unit. Transaction-safe steps coalesce into one group; a step PostgreSQL cannot run inside a transaction stands alone. Boundaries are derived from step semantics, never configured by the user. A plan with more than one group displays the group count with one section per group, and its SQL separates the groups with a blank line.
_Avoid_: batch, transaction block, commit point

**Non-transactional step**:
A migration-plan step whose statement PostgreSQL refuses to run inside a transaction. It stands alone, unwrapped; the concurrent index builds — `create-index-concurrently` and `drop-index-concurrently` — are the only such kinds.
_Avoid_: unsafe step, autocommit step

**Hazard**:
A risk annotation on a migration plan. A definite hazard is a self-inconsistent target PostgreSQL rejects at apply, regardless of stored state; a state-dependent hazard — a bound the plan tightens — may fail depending on the sequence's stored value, which is not modeled. A certain-cost hazard — a persistence flip — rewrites the table under an ACCESS EXCLUSIVE lock at apply.
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

### The context map

**Bounded context**:
A sphere of language and model with its own boundaries. Schemamill is one bounded context: it owns a single canonical model, into which Import and Introspection bring a schema from DDL text or a live database. PostgreSQL is external and not owned; it keeps its own vocabulary — catalog names, type and constraint semantics, lock modes — that schemamill never adopts into the model. See [context-map.md](./docs/domain/context-map.md), § Contexts (line 7).
_Avoid_: context, boundary context, domain

**Anti-Corruption Layer (ACL)**:
The translation boundary between two bounded contexts. Inbound, Import and Introspection translate PostgreSQL's vocabulary into the canonical model, so no catalog or dialect words leak in. Outbound, a migration plan's Migration SQL renders into PostgreSQL's SQL. Schemamill never writes the database; the user carries every change across by Apply. See [context-map.md](./docs/domain/context-map.md), § Relationships (lines 19-20).
_Avoid_: access-control list

**Subdomain**:
A part of a bounded context's problem space, one of three kinds: core — schema-change intelligence, where investment and craft go (the canonical model, import fidelity, semantic diff, and the hazard-annotated migration plan); supporting — presentation and projection (migration SQL rendering, export projections, import diagnostics); or generic — plumbing (CLI/server mechanics, packaging, parsing and catalog tooling). The source names the first kind "Core domain" (context-map.md:13), and the others "Supporting subdomain" and "Generic subdomain" (:14-15). See [context-map.md](./docs/domain/context-map.md), § Subdomains (lines 13-15).
_Avoid_: subsystem, module
