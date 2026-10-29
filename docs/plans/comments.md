# Comments — model, import, diff, plan, render, round-trip

**Status:** built · **Last updated:** 2026-10-29

Every comment on a modeled entity now survives dump import → model → diff → plan → render → apply → dump import: tables, columns, sequences, plain and materialized views, primary keys, unique/check/foreign-key constraints, standalone indexes, and — since [#91](https://github.com/osama784/schemamill/issues/91) — extensions. The slice shipped in [#87](https://github.com/osama784/schemamill/issues/87) as Slice C of the [import long-tail plan](./import-long-tail.md), after views, so comments were modeled once, on the families that existed when they landed; the extension target followed in the [extensions slice](./extensions.md). Its durable decisions are recorded in [ADR 0021](../adr/0021-comments-travel-the-model.md).

## Goal

A dump's comments — the seven `COMMENT ON` object forms this slice modeled, plus the extension form added in [#91](https://github.com/osama784/schemamill/issues/91) — import onto their entities, compare as their own change, plan in a terminal phase, render with PostgreSQL-correct literal quoting, and re-import unchanged; a recreated constraint, index, or materialized view re-asserts its comment instead of losing it to the drop.

## Scope

**In:** `comment?: string` on the nine entity interfaces this slice carried (the extension entity gained one in [#91](https://github.com/osama784/schemamill/issues/91)); import of `COMMENT ON TABLE`, `COLUMN`, `SEQUENCE`, `VIEW`, `MATERIALIZED VIEW`, `INDEX`, and `CONSTRAINT` (plus `EXTENSION` since [#91](https://github.com/osama784/schemamill/issues/91)); `comment-changed`; the `CommentTarget` union and one transactional `comment` step; the terminal global phase 12; canonical rendering with plain and `E'…'` literals and NUL refusal; CLI display and the `comments` golden scene; the workspace `comment` key; and the `comment-round-trip` live scene with server-derived cross-import checks.

**Out, named — never silent:** comments on extensions, listed here when this slice landed, have since shipped in the [extensions slice](./extensions.md) ([#91](https://github.com/osama784/schemamill/issues/91)); comments on unmodeled families (schemas, functions, procedures, triggers, rules, policies, types, foreign tables, tablespaces, roles, databases) — skipped and named as before; comments on PostgreSQL 18 named not-null constraints (deferred below); catalog introspection of comments (deferred below); grants, ownership, and security labels ([#92](https://github.com/osama784/schemamill/issues/92)); view output columns, including their comments ([#143](https://github.com/osama784/schemamill/issues/143)); and `COMMENT ON` deparse ([#57](https://github.com/osama784/schemamill/issues/57)).

**Deliberately shallow for now:** a comment is text the model stores and compares verbatim; it is never parsed, normalized, or used as identity, and the engine does not attempt to merge conflicting comments on the same server object.

## Decisions

- **Model field, absent or non-empty.** Each entity carries `comment?: string`, stored verbatim — exact characters, unicode and newlines allowed. Absent means no comment. The empty string is not a model value: PostgreSQL reduces `COMMENT … IS ''` to the same removal case as `IS NULL`, and `pg_dump` never emits `IS NULL`, so the equivalence is semantic, not a fidelity loss. The workspace parser rejects `""` and text carrying NUL; the renderer refuses NUL again.
- **Descriptive, not structural.** `comment` is excluded from every structural equality function and from every field-change union, and never enters `ColumnAttributes`. A comment-only change must not decompose a constraint or index into a destructive drop and add.
- **One target union, one step.** `CommentTarget` has one variant per `COMMENT ON` object form; `view` carries `materialized`, and the index and constraint variants carry the node so the renderer can synthesize an unnamed node's conventional server name. One `comment` step carries `text`, absent meaning `IS NULL`, and every copied target strips the node's own `comment` so `text` is the only rendered value.
- **One change, appended last.** `diff` returns the table, sequence, view, and extension groups, then `diffComments` in target identity order. A comment the baseline lacks is an addition; a removed entity emits nothing; an entity whose structural identity changed reads as absent and reports an addition. The plan posts one `comment` step per change.
- **Terminal phase 12.** Every comment step — the diff's changes and the recreate re-assertions alike — lands in `application.comments`, and the plan appends the bucket after every structural and identity phase and before the extension teardown (phase 13). Every target exists by then: tables, columns, constraints, and indexes from the table phases, views from phase 7, sequences from phases 3 and 9, identities from phase 11, extensions from phase 1. Comments never affect structure and are order-insensitive among themselves.
- **Recreate re-assertion.** A drop takes the comment with the object, so seven recreate sites push a comment step when the target node states one: index, primary key, foreign key, unique constraint, check constraint, materialized or kind-change view, and the synthesized dependent foreign key whose referenced primary key changes. Both a recreate step and a diff change may name one target; the terminal phase keeps one step per target, and both carry the target's text. A removal is never suppressed.
- **Known ambiguity, recorded.** Two structurally identical unnamed nodes with different comments share one `CommentTarget` key, so the terminal phase keeps one step. The model already cannot distinguish the two server objects on apply, and the workspace does not forbid the shape; the behavior is documented rather than hidden.
- **Literal quoting.** A line-safe comment renders as `'…'` with embedded quotes doubled; a backslash or any C0/DEL control switches to `E'…'`, escaping `\`, `'`, newline, carriage return, tab, and other controls as `\xHH`. The one-statement-per-line contract survives a multi-line comment, unicode passes through unchanged, and NUL throws `RenderRefusalError`.
- **Resolution before canonicalization.** The importer resolves a comment against the stored server name while drafts still carry it — `finalizeTable` canonicalizes after every statement — and falls back to the conventional synthesized name for a node the source declared unnamed. A collision-suffixed name is not stripped, so the comment resolves directly. No comment-aware canonicalization branch exists.
- **Flags, not silence.** An unresolvable target, a kind mismatch, a view output column, and NUL-carrying text are flagged as `dropped comment from <object>`; unmodeled families keep the existing `skipped COMMENT ON <KIND> <object>` path; a PostgreSQL 18 named not-null constraint takes `dropped comment on a not-null constraint from <object>`.
- **Last definition wins.** `IS NULL` and `IS ''` clear the field, a repeated comment replaces the earlier one, and a repeated `CREATE TABLE`/`SEQUENCE`/`VIEW` replaces the entity wholesale and therefore clears its comment, consistent with the import's existing last-definition rule.
- **Workspace compatibility.** `comment` joins each entity's key list and each serializer and parser; a pre-slice model file without the key reads unchanged, while an older binary fails closed on the new key (ADR 0010). No format version is introduced.

## Import envelope

`translateStatement` routes the eight modeled `CommentStmt` object kinds to `translateCommentStatement` before the generic skip fallback. The object lists and arity defaults:

| `objtype` | Object list | Target | Arity default |
| --- | --- | --- | --- |
| `OBJECT_TABLE` | `[schema, table]` | table | 1 → `public` |
| `OBJECT_COLUMN` | `[schema, table, column]` | column | 2 → `public`; 1 unresolvable |
| `OBJECT_SEQUENCE` | `[schema, name]` | sequence | 1 → `public` |
| `OBJECT_VIEW` | `[schema, name]` | plain view | 1 → `public` |
| `OBJECT_MATVIEW` | `[schema, name]` | materialized view | 1 → `public` |
| `OBJECT_INDEX` | `[schema, index]` | the one table's index of that stored or synthesized name | 1 → `public` |
| `OBJECT_TABCONSTRAINT` | `[schema, table, constraint]` | primary key, unique, check, or foreign key | 2 → `public` |
| `OBJECT_EXTENSION` | `<name>` (a `String` node, never a name list) | extension | bare name; never schema-qualified, resolved only against an imported extension ([#91](https://github.com/osama784/schemamill/issues/91)) |

Constraint resolution searches the table draft's primary key, unique constraints, check constraints, and foreign keys by stored or synthesized name, then the columns' named not-null facts (the deferral flag), then the generic flag — the fixed order recorded in ADR 0021. A view or materialized-view output-column comment resolves in no table draft, so it takes the generic `dropped comment` flag; view output columns are [still unmodeled](./views.md) ([#143](https://github.com/osama784/schemamill/issues/143)).

## Test matrix

**Workspace (`packages/core/src/workspace.test.ts`)** — `serializeModel round-trips a comment on every entity kind through resolveWorkspace`, `serializeModel emits each entity comment as its last key`, `serializeModel round-trips comment text with escapes and unicode byte-exactly`, `resolveWorkspace fails closed on an empty comment at every entity kind`, `resolveWorkspace fails closed on a non-string comment at every entity kind`, `resolveWorkspace fails closed on a comment containing NUL at every entity kind`, and `resolveWorkspace reads a pre-comment model as entities without a comment property`.

**Diff (`packages/core/src/diff.test.ts`)** — `a table comment appears, changes, and disappears as one comment change`, `a column comment appears and changes as one comment change`, `a sequence comment is a comment change, not a sequence change`, `a view comment is a comment change, not a view change`, `a comment-only change on a constraint or index never recreates it`, `equal comments on every member emit nothing`, `an added table reports one comment change per commented member`, `a removed commented entity emits no comment change`, and `comment changes come last, after table, sequence, and view changes, in target order`.

**Plan (`packages/core/src/plan.test.ts`)** — `a comment-only table change is one terminal comment step`, `an added commented table asserts its comments after every create`, `an index recreate re-asserts an unchanged comment after the create`, `a recreated index with a changed comment keeps exactly one comment step`, `a primary-key recreate re-asserts an unchanged comment`, `a foreign-key recreate re-asserts an unchanged comment`, `a unique-constraint recreate re-asserts an unchanged comment`, `a check-constraint recreate re-asserts an unchanged comment`, `a recreated materialized view re-asserts an unchanged comment`, `a commented foreign key is re-asserted when its referenced primary key changes`, `a comment removal is a comment step with no text`, `every comment step follows every structural step`, `the simulator applies comment steps to all nine target kinds`, and `a comment step strips the target node so its text is the only source`.

**Import (`packages/postgres/src/import.test.ts`)** — `imports comments on every modeled family, including synthesized names`, `defaults unqualified comment targets to public and flags an under-qualified column`, `clears a comment on IS NULL and on IS ''`, `flags every comment target the import cannot resolve, keeping skips for unmodeled families`, `flags not-null comments with the deferral wording, after the constraint slots`, `keeps the last repeated comment on every modeled family`, `clears table, sequence, and view comments when a create is repeated`, and `refuses a comment carrying NUL before it can reach the model`; the long-tail fixtures flip their pinned `COMMENT ON TABLE`/`MATERIALIZED VIEW` skips while `COMMENT ON FOREIGN TABLE` stays skipped (`reports skips, flags, and failures in dump order`, `names every long-tail family in dump order`).

**Render (`packages/postgres/src/render.test.ts`)** — `comment statements quote identifiers and keep explicit names as stored`, `a comment removal renders IS NULL`, `comment text renders plainly when line-safe and escapes otherwise`, `a comment containing NUL is refused with RenderRefusalError`, `a comment step's text wins over a stale comment on its target node`, and the `comments.sql` golden via `golden: comments on every modeled family, a removal, and escaping`.

**CLI (`packages/cli/src/format.test.ts`, `packages/cli/src/goldens.test.ts`)** — `comment changes print every target shape with the signed texts`, `comment text is JSON-quoted so quotes, backslashes, newlines, and unicode stay visible`, `comment plan steps print every target shape and the text or (none)`, and the `comments` golden scene covering adds, changes, removals, every target kind, unnamed nodes, five recreate re-assertions, and one check constraint whose comment and enforcement both change.

**Live (`packages/postgres/src/live-scenes.ts`)** — the `comment-round-trip` scene builds a baseline and target across all seven families with additions, changes, removals, an unnamed conventional-name constraint and index, a special-character comment, and recreated objects with unchanged comments. Its `baselineChecks`/`targetChecks`/`checks` pin the server's stored text, `planChecks` pin that every comment step is terminal and each recreated object re-asserts its comment, `importChecks` pin both imports' comment inventories and the unnamed nodes, and `crossImportChecks` compare the applied and target imports by structure, a comment inventory, and a full deep equality. The PostgreSQL 18 scene `not-null-constraint-names` flips its pinned skip to the named deferral flag.

## Evidence

The package suites pin the contract level by level; the CLI `comments` scene pins compare and plan bytes, including the terminal phase and the JSON-quoted display; and the postgres `comments.sql` golden pins all seven statement forms, `IS NULL`, and the escape matrix. On a scratch PostgreSQL 16.15 the live suite is 388 tests across 49 scenes, 3 skipped — the three PostgreSQL 18 scenes, `not-null-constraint-names` among them — and the `verify-postgres` job runs the same harness on PostgreSQL 18. The new scene is PostgreSQL 16-compatible and carries no `introspection` check: a comment-carrying model is intentionally not what the catalog read returns yet.

## Acceptance

- Comments on the nine modeled entities import, diff, plan, and render without silent loss, and a comment on an unnamed constraint or index survives canonicalization.
- A recreated index, primary key, foreign key, unique or check constraint, materialized view, or dependent foreign key re-asserts its comment exactly once in the terminal phase.
- Workspace read compatibility, the goldens, and the gated scene pass; all five gates are green and `pnpm docs:counts --check` reports no stale claim.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.
- The gated suite round-trips `comment-round-trip`, and the applied and target imports agree on comments and structure on the PostgreSQL 16.15 scratch server; CI reruns it on PostgreSQL 18.
- This plan, [ADR 0021](../adr/0021-comments-travel-the-model.md), the `[Unreleased]` changelog entry, and [#87](https://github.com/osama784/schemamill/issues/87) carry the ship note.

## Deferred

Named, never silent:

- **Comments on extensions** — closed in [#91](https://github.com/osama784/schemamill/issues/91): `COMMENT ON EXTENSION` now imports, plans in the terminal comment phase, and renders ([extensions plan](./extensions.md)).
- **Comments on unmodeled families** — schemas, functions, procedures, triggers, rules, policies, types, foreign tables, tablespaces, roles, and databases stay skipped and named.
- **Comments on PostgreSQL 18 named not-null constraints** — the model has no not-null entity; the flag keeps the not-null fact while the comment is dropped, and a follow-up is recorded for bookkeeping.
- **Catalog introspection of comments** — `catalog.ts` reads no `obj_description`/`col_description` today, so a live-database import loses comments with no diagnostic; a follow-up is recorded for bookkeeping and the live scene omits `introspection`.
- **Grants, ownership, and security labels** — [#92](https://github.com/osama784/schemamill/issues/92).
- **View output columns, including their comments** — [#143](https://github.com/osama784/schemamill/issues/143); `COMMENT ON COLUMN <view>.<column>` is flagged today.
- **`COMMENT ON` deparse** — [#57](https://github.com/osama784/schemamill/issues/57).
- **The index-name collision-guard residual** — comment steps are not part of `renderSql`'s duplicate-name guard; an unnamed comment target and a differently shaped create could in principle share a server-form name.
- **Comment-aware canonicalization** — deliberately not introduced; resolution happens while the server name is stored, and adding a comment-aware strip would make the importer disagree with catalog reads.
- **The owned-sequence removal rule** — a comment on a sequence owned by a removed column follows the sequence; the existing owner-removal suppression decides whether that sequence survives, and no comment-specific rule is added.
