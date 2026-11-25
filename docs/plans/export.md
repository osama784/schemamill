# Export — project the model as DDL, Markdown, or canonical JSON

**Status:** built · **Last updated:** 2026-11-25

Export is the model's read-only projection out of the workspace: `schemamill export [--format ddl|json|markdown] [--target-version <major>]` prints migration-style DDL, a readable Markdown projection, or the canonical model bytes without changing the workspace or a database. It shipped in [#134](https://github.com/osama784/schemamill/issues/134); the Markdown projection followed in [#177](https://github.com/osama784/schemamill/issues/177), with its decision in [ADR 0039](../adr/0039-markdown-export-projection.md), and the original durable decisions are recorded in [ADR 0023](../adr/0023-export-projects-the-model.md).

## Goal

A workspace can be turned into a reviewable artifact without a database: `--format ddl` prints migration-style SQL that builds the whole model on an empty database (including `CREATE SCHEMA` for every non-`public` schema), `--format json` prints the canonical model bytes, and `--format markdown` prints a deterministic, readable Markdown projection of the model. All three — DDL, Markdown, and canonical JSON — are deterministic, byte-stable, and reviewed like code.

## Scope

**In:** the `export` command (workspace resolution, `--format`, stdout, exit codes); the `--target-version` flag, accepted, validated before any filesystem access, and forwarded to the renderer (export's create-only projection is version-invariant today); the `ddl` projection `renderSql(plan(EMPTY_MODEL, model), { targetVersion })`; the `json` projection `serializeModel(model)`; the new transactional `create-schema` step and its render; the schema inventory rule; CLI goldens and help; the `export-round-trip` live scene; CONTEXT, ADR 0023, and changelog.

**Out, named — never silent:** file output (`--out`); a generated DDL header; a JSON envelope or version field; `drop-schema`, schema ownership/ACL/comments, and empty schemas as modeled objects; schemas referenced only inside opaque text (collation names, view definitions, check/default expressions) or through a foreign key to an unmodeled table; system schemas; version-aware semantics ([#57](https://github.com/osama784/schemamill/issues/57)); studio consumption ([#83](https://github.com/osama784/schemamill/issues/83)); applying SQL, hazard analysis, snapshots; export from a bare dump without a workspace; extension `VERSION`.

## Decisions

- **D1 — Command.** `schemamill export [--format <ddl|json|markdown>] [--target-version <major>]`, workspace from `process.cwd()`, default `ddl`, target default `13`, stdout only, no `--verbose`. `--format` is validated first, then `--target-version` against the declared 13–18 span, both before any filesystem access; an invalid value is one `error: …` line. Other failures are one `schemamill: …` line, exit 1, empty stdout.
- **D2 — JSON.** Exactly `serializeModel(model)`: canonical two-space JSON, sorted arrays, `tables`/`sequences`/`views`/`extensions` order, trailing newline, no wrapper.
- **D3 — Serializer.** `serializeModel` is re-exported from `@schemamill/core`; the CLI gains no second serializer and never writes JSON itself.
- **D4 — DDL.** `renderSql(plan(EMPTY_MODEL, model), { targetVersion })`; the CLI carries a typed local empty model. Render before writing; a refusal is reported and leaves stdout empty.
- **D5 — Schema step.** `create-schema { schema }`, transactional, rendered `CREATE SCHEMA IF NOT EXISTS <quoted>;`. Idempotent because schemas are not modeled and the target database may already carry the namespace.
- **D6 — Inventory.** One step per schema used by a target object (tables, sequences, views, extension install schemas, identity sequence names) that no baseline object uses; `public` excluded; deduped and name-sorted; emitted at the head of global phase 1, before extensions. Schemas named only inside opaque text (collation names, view definitions, check/default expressions) are not inventoried; identity sequence names are same-schema in practice. Both are named residuals.
- **D7 — Order.** Schemas → extensions → the existing plan order, with schema creation prepended. No schema drops.

## Acceptance

- `export --format ddl` for a model with at least two non-public schemas prints schema creates first (name order), then the model's objects in plan order; the exact bytes are pinned.
- `export --format json` bytes equal `serializeModel(model)`; parsing them yields the canonical model.
- `export --target-version` accepts `13`, `14`, `16`, and `18` with byte-identical DDL, and `--format json --target-version 18` equals the plain JSON golden — the JSON projection ignores the flag; `12`, `19`, `13.4`, and `abc` are the exact usage error `error: --target-version must be a PostgreSQL major from 13 to 18` with empty stdout and exit 1 from a non-workspace directory, rejecting with the usage error ahead of any workspace diagnostic (non-workspace cwd); validation precedes `resolveWorkspace` in code; `--format` is reported first when both values are invalid.
- The exported DDL applies to a fresh database with no `setupSql` and round-trips through `importDump` to an empty diff (gated live-PG scene).
- Existing plans with a newly used non-public schema emit `CREATE SCHEMA IF NOT EXISTS` before their objects; all goldens are re-pinned deliberately and every other golden is byte-unchanged.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` are green; `docs:counts --check` reports 0 stale.
- A `[Unreleased]` changelog entry exists.

## Done means

The command, the step, the renderer, the goldens, the live scene, CONTEXT, ADR 0023, and the changelog land together; mutation evidence covers the inventory, order, idempotence, quoting, and both projections; the live suite passes on PG16.15 locally and PG18 in CI.

## Deferred

`--out`; a DDL header; JSON envelope/version; `--target-version` parity plumbing (no version-sensitive create form exists today, so the flag is accepted, validated, and forwarded but cannot change export bytes; it becomes observable when the renderer gains such a form); `drop-schema` and schema ownership/ACL/comments; empty schemas as objects; system schemas; schemas named only inside opaque text (collation names, view definitions, check/default expressions) or reachable through a foreign key to an unmodeled table; version-aware semantics (#57); studio consumption (#83); applying SQL/hazards/snapshots; export from a bare dump; extension `VERSION`; cleanup of redundant `setupSql` schema creates outside `extension-round-trip`.

## Markdown projection

[#177](https://github.com/osama784/schemamill/issues/177) added a third projection: `schemamill export --format markdown` prints a deterministic, readable Markdown projection of the canonical model. It is a projection for human review, not a second canonical format, and there is no round-trip back to a model; [ADR 0039](../adr/0039-markdown-export-projection.md) records the decision. `renderMarkdown(model: Model): string` lives in a pure, dependency-free `packages/cli/src/markdown.ts` module with no I/O, clock, filesystem, locale, or environment reads. The `ddl` and `json` artifact bytes and their exit behavior stay byte-identical; the help/usage description, the `--format` option line, and the validation error string are deliberately re-pinned for the new value, and the `planOrReport` gate still runs before the format branch so a dangling target `ownedBy` is refused before any format is rendered.

**Section order.** Fixed, matching `Model` declaration order: `# Schema`, then `## Tables`, `## Sequences`, `## Views`, and `## Extensions`. A section is omitted entirely when its collection is empty; an empty model renders exactly `# Schema\n` (one LF, pinned).

**Self-sorting.** The renderer sorts every collection itself and never relies on stored order: `parseModel` preserves file order and the workspace serializer does not re-sort nested arrays. Comparisons are ascending plain JS `<` string comparisons. `opt(x)` is absent before present, then value; `arr(x)` is element-wise `<`, then shorter-first. Each nested collection uses a total order — the listed keys, then as a final tiebreak a plain string comparison of `JSON.stringify(entry)` (the parser rebuilds every model object in declaration order, so this is deterministic).

- tables, sequences, and views: `schema` then `name`; extensions: `name`.
- `columns`: **source order preserved** — ordinal is part of a table's shape, never sorted.
- `indexes` (table and materialized view): `opt(name)`, then `unique` (false before true), then `arr(columns)`.
- `uniqueConstraints`: `arr(columns)`, then `opt(name)`.
- `checkConstraints`: `expression`, then `opt(name)`.
- `foreignKeys`: `arr(columns)`, `referencedTable.schema`, `referencedTable.name`, `opt(name)`, `arr(referencedColumns)`, `opt(onUpdate)`, `opt(onDelete)`, `opt(deferrable)`, `opt(enforcement)`, `opt(comment)`.
- `primaryKey`: one object, no sort.

**Formatting (`fmt`).** Absent/undefined becomes the literal `(none)`; a boolean becomes `yes`/`no`; a number becomes a plain decimal; a string becomes one code span per the escaping rule below; a string array becomes `(` + comma-space joined code spans + `)`, or `(none)` when empty. `(none)` is never wrapped in a code span. A code span chooses a fence of `n` backticks where `n = 1 + (longest run of backticks in the value)`; if the value starts or ends with a backtick, one space goes just inside each fence. A backslash is literal inside a code span and is never an escape for a backtick. Before fencing, CRLF and lone CR fold to one `\n`, then each `\n` becomes `<br>` so every value stays on one output line; a tab becomes the two characters `\t`; every other C0 control (0x00–0x1F), DEL (0x7F), and C1 control (0x80–0x9F) becomes `\uXXXX` with uppercase hex. NUL cannot occur in comments; if encountered in opaque text it is rendered as the U+0000 escape, never a raw NUL. Output uses `\n` line endings and ends with exactly one final `\n`.

**Block layout.** A block is either a heading plus its one following blank line, or a contiguous run of bullet lines. Every `#`, `##`, `###`, and `####` heading is followed by exactly one blank line — including `# Schema` whenever a section follows; for an empty model it is followed only by the final LF. Consecutive bullets have no blank line between them; two adjacent entity blocks are separated by exactly one blank line. Every attribute line is `- <Label>: <fmt(value)>` with NO trailing punctuation; nested bullets are indented exactly two spaces plus `- `. Optional attribute bullets are omitted when absent (there is no `Persistence: (none)` form); only values inside a rendered bullet use `(none)`.

**Comment slots.** All eleven are rendered: `comment` on Table, Column, PrimaryKey, UniqueConstraint, CheckConstraint, ForeignKey, Index, Sequence, View, and Extension, plus `Column.notNullComment` as the column's separate `not-null comment` value.

**Entity templates.** Labels are in this exact order; a qualified name is one code span containing the dot-joined value:

- Table: `` ### Table `<schema>.<name>` ``; bullets `Comment`, `Persistence` (`unlogged` only, omitted otherwise), then `#### Columns`, `#### Primary key`, `#### Unique constraints`, `#### Check constraints`, `#### Foreign keys`, `#### Indexes` (each sub-heading omitted when its collection is empty).
- Column: `Column <name>`, `type`, nullable/`not null`, `default`, `collation`, `storage`, `compression`, `statistics target`, `comment`, `not-null comment`; nested `Not-null constraint name` when present and nested `Identity` (`generation`, `sequence`, `increment`, `min`, `max`, `start`, `cache`, `cycle`) when present.
- Primary key and unique constraint: `name`, `columns`, `deferrable`, `initially deferred`, `comment`. Check constraint: `name`, `expression`, `enforcement`, `comment`. Foreign key: `name`, `columns`, `referenced table`, `referenced columns`, `on update`, `on delete`, `enforcement`, `deferrable`, `initially deferred`, `comment`. Index: `name`, `unique`, `columns`, `concurrently`, `comment`.
- Sequence: `` ### Sequence `<schema>.<name>` ``; bullets `data type`, `increment`, `min`, `max`, `start`, `cache`, `cycle`, `owned by` (one code span for `<schema>.<table>.<column>` when present), `comment`.
- View: `` ### View `<schema>.<name>` `` or `` ### Materialized view `<schema>.<name>` ``; bullets `definition`, `check option`, `comment`; materialized views add `#### Indexes` with the Index template, plain views have none; both kinds share `## Views` in schema/name order.
- Extension: `` ### Extension `<name>` ``; bullets `schema`, `comment`.

**Worked bytes** for one table with one column and one sub-heading (each `\n` is one LF; no blank line after the last bullet, one final LF):

```
# Schema\n
\n
## Tables\n
\n
### Table `public.t`\n
\n
#### Columns\n
\n
- Column `id`: type `integer`, not null, default (none), collation (none), storage (none), compression (none), statistics target (none), comment (none), not-null comment (none)\n
```
