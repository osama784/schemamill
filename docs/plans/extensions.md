# Extensions — model, import, diff, plan, render, round-trip

**Status:** built · **Last updated:** 2026-10-29

PostgreSQL extensions are now first-class model entities. A default dump's `CREATE EXTENSION … WITH SCHEMA …` and `COMMENT ON EXTENSION` survive dump import → model → diff → plan → render → apply → dump import, including a relocatable extension's schema move, and every form the model cannot carry is named in a diagnostic instead of being dropped silently. The slice shipped in [#91](https://github.com/osama784/schemamill/issues/91) as Slice E of the [import long-tail plan](./import-long-tail.md); its durable decisions are recorded in [ADR 0022](../adr/0022-extensions-travel-the-model.md).

## Goal

An extension a default dump installs keeps its name, install schema, and comment all the way around the safe-change loop, and a schema-less `CREATE EXTENSION`, a `VERSION` or `CASCADE` modifier, a member statement, or an `ALTER EXTENSION` form is named rather than lost. A removed extension whose dependents survive fails loudly at apply under `DROP EXTENSION`'s default `RESTRICT`; the plan never hides that class.

## Scope

**In:** `Model.extensions`; the `Extension` shape — name identity, required install schema, optional comment; `ExtensionIdentity`; import of `CREATE EXTENSION` and `COMMENT ON EXTENSION`; `extension-added`/`extension-removed`/`extension-changed`; the transactional `create-extension`, `alter-extension`, and `drop-extension` steps; the tenth `CommentTarget` variant; the thirteen-phase plan placement; canonical rendering of the three statements plus the extension comment target; CLI display, the `extensions` golden scene, and the `extensions.sql` render golden; the workspace `extensions` section; and the `extension-round-trip` live scene with a relocatable schema move.

**Out, named — never silent:** extension version modeling and `--exclude-extension` gating ([#57](https://github.com/osama784/schemamill/issues/57)); extension ownership (`extowner` is not dump-preserved); member-object modeling and `ALTER EXTENSION … ADD`/`DROP` (binary-upgrade only); binary-upgrade dumps; catalog `pg_extension` reads and catalog comment reads (a follow-up; the catalog keeps returning `extensions: []`); catalog extension-member filtering (the [ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md) residual); built-in extensions (`plpgsql` is never dumped); `extconfig` data semantics beyond the dump's own tables; `DROP EXTENSION` with `--clean` dumps; and extension-availability checks. Each is listed in §Deferred.

**Deliberately shallow for now:** an extension is a name, an install schema, and a comment. Core never reads the extension's control file, its version, its relocatability bit, or its member inventory, so the model cannot preflight a schema move or a removal's dependents; PostgreSQL decides both at apply.

## Decisions

- **Model shape and name identity.** `Model` gains a required `extensions` array, always serialized and sorted by name with `compareExtensions` (plain string comparison). `Extension` is `{ name, schema, comment? }` and `ExtensionIdentity` is `{ name }`: extension names are database-unique and never schema-qualified, so the name alone is identity and the install schema is a mutable attribute. `comment` follows the [comments contract](./comments.md): absent means none, the empty string is not a model value, text is stored verbatim, and NUL is rejected.
- **Required schema and the schema-less skip.** `schema` is required because `pg_dump` always states `WITH SCHEMA` (source-verified for 13–18 and live-verified on 16.15). A hand-authored `CREATE EXTENSION hstore;` has no install schema the importer could trust, so it is skipped and named `skipped CREATE EXTENSION hstore (no WITH SCHEMA)`; the importer never invents `public`. A skipped definition never replaces an already imported draft or its comment.
- **Import and named diagnostics.** `CreateExtensionStmt` imports before the generic skip fallback. `IF NOT EXISTS` is restore noise and is ignored with no diagnostic. `VERSION` (`new_version`), `CASCADE` (a Boolean option), and an unknown option are flagged as `dropped VERSION from extension <name>`, `dropped CASCADE from extension <name>`, and `dropped <defname> from extension <name>`, while the extension still imports; a repeated `CREATE EXTENSION` replaces the draft wholesale and clears its comment. `COMMENT ON EXTENSION` joins the modeled comment objects, resolves by bare name, and clears on `IS NULL`/`IS ''`; a comment before its create is flagged, never turned into a phantom extension. `ALTER EXTENSION … UPDATE`, `SET SCHEMA`, and `ADD`/`DROP`, plus `DROP EXTENSION` and the invalid-PostgreSQL `ALTER EXTENSION … RENAME`, are skipped with accurate wording. The module doc lists the named gaps.
- **Value-carrying diff.** `diff` appends `diffExtensions` after every view change and before the comment pass: a baseline-only name is `extension-removed`, a target-only name `extension-added`, and a shared name compares on `schema` and reports `extension-changed` with `changes: [{ field: 'schema', before, after }]`. The field change is value-carrying like `SequenceFieldChange`, so the plan and renderer never look up the baseline; the single-member union keeps the `assertNever` default real from day one. A comment difference is a separate `comment-changed`, an added extension reports its comment as an addition, and a removed extension emits no comment change.
- **Thirteen-phase placement.** Extensions occupy global phase 1 (create, in name order), after the schema creates prepended by the [export slice](./export.md), and phase 13 (schema alters, then removals, both in name order). The full order is 1 create-schema then create-extension, 2 drop-identity, 3 create-sequence, 4 ownership detaches, 5 drop-view, 6 the eighteen table phases, 7 create-view then replace-view, 8 ownership attaches/re-owns, 9 sequence option alters, 10 drop-sequence, 11 add-identity then alter-identity, 12 comment, 13 alter-extension then drop-extension. Creates come first because any object may use an extension's type or function; teardown comes last, after every dependent object and every comment, because a dropped extension takes its comment with it. `alter-extension` carries identity plus value-carrying fields, so its destination is `fields[].after`.
- **Render.** `create-extension` renders `CREATE EXTENSION <quoted name> WITH SCHEMA <quoted schema>;` and never `IF NOT EXISTS`; `alter-extension` renders `ALTER EXTENSION <quoted name> SET SCHEMA <quoted schema>;` from `schema.after`; `drop-extension` renders `DROP EXTENSION <quoted name>;`; the comment target renders `COMMENT ON EXTENSION <quoted name> IS <literal|null>`. Names stay bare and are quoted only when needed. No new refusal class exists: relocatability and dependent-object checks belong to the server.
- **Workspace compatibility.** `extensions` joins `MODEL_KEYS`; an older model file without the key reads as `[]`, while `null`, a non-array, an unknown key, a malformed object, an empty name or schema, or an empty/NUL comment fails closed. Serializers write `{ schema, name, ...(comment) }` and the section always follows `views`. An older binary rejects `extensions` as an unknown key, accepted as it was for `views` ([ADR 0010](../adr/0010-workspace-container.md)); no format version is introduced.
- **Catalog deferral.** `catalog.ts` continues to return `extensions: []`, mirroring its `views: []`. Importing from a live database therefore loses extensions with no diagnostic until the follow-up, and a model carrying extensions is intentionally not what the catalog read returns. Every `matches-import` scene has no extension installed in its scratch databases; only the flags-mode `introspection-flags-constraints-18` installs `btree_gist`, and built-in `plpgsql` is never dumped. The extension scene declares no introspection assertion.
- **Tests and goldens.** Workspace, diff, plan, import, render, CLI, and the gated live scene pin the contract at every level; the test matrix below names the cases. The CLI `extensions` scene imports with zero diagnostics and covers an addition, a removal without dependents, a schema move, comment adds/changes/removals, and the dump-form `IF NOT EXISTS`. The `extensions.sql` golden covers the three statements, quoting, the comment target, and `IS NULL`.

## Plan phases

| Phase | Contents |
| --- | --- |
| 1 | create-schema, then create-extension — target schemas by name, then added extensions in name order |
| 2 | drop-identity |
| 3 | create-sequence |
| 4 | ownership detaches |
| 5 | drop-view |
| 6 | the eighteen table phases |
| 7 | create-view, then replace-view |
| 8 | ownership attaches and re-owns |
| 9 | sequence option alters |
| 10 | drop-sequence |
| 11 | add-identity, then alter-identity |
| 12 | comment |
| 13 | alter-extension, then drop-extension |

## Test matrix

**Workspace (`packages/core/src/workspace.test.ts`)** — `serializeModel round-trips extensions with and without a comment without loss`, `resolveWorkspace reads a model without an extensions field as no extensions`, `resolveWorkspace fails closed when extensions is null or not an array`, `resolveWorkspace fails closed on an unknown extension key`, `resolveWorkspace requires a non-empty extension name and schema`, `resolveWorkspace fails closed on an invalid extension comment`, and `serializeModel emits extensions after views, name-sorted, schema before name, comment last`.

**Diff (`packages/core/src/diff.test.ts`)** — `extensions report additions, removals, and value-carrying schema changes by name`, `a schema-only extension change carries no comment change`, `an extension comment change, addition, and removal are separate comment changes`, `a comment-only extension change emits only its comment change`, `an added extension reports its comment as an addition`, `a removed extension emits no comment change`, and `extension changes follow view changes and precede comment changes`.

**Plan (`packages/core/src/plan.test.ts`)** — `extension creates open the plan, in name order`, `extension comments are phase 12 and the extension alter is phase 13`, `extension alters come before extension drops, both last and in name order`, `extension steps are classified transactional`, `extension changes apply to their buckets with copied payloads`, `a comment change on an extension becomes an extension comment step`, `an unknown extension field is rejected by the exhaustiveness guard`, and `a schema change flows from the diff to the plan destination field`; the slice also renumbered the global-phase pins and the step-kind enumeration.

**Import (`packages/postgres/src/import.test.ts`)** — `imports CREATE EXTENSION with its install schema, ignoring IF NOT EXISTS`, `flags CREATE EXTENSION version and cascade options, keeping the extension`, `replaces a repeated CREATE EXTENSION wholesale and clears its comment`, `skips a CREATE EXTENSION without WITH SCHEMA and keeps an earlier draft`, `imports and clears an extension comment`, `flags a comment on an extension the import has not seen`, `skips extension updates, member statements, and drops by name`, `flags an unknown CREATE EXTENSION option the grammar cannot write`, and `describes an extension rename, which the grammar cannot write`; `names every long-tail family in dump order` flips the long-tail `pgcrypto` create from a skip to `model.extensions`.

**Render (`packages/postgres/src/render.test.ts`)** — `extension steps render create, alter from field.after, and drop, never IF NOT EXISTS`, `extension names stay bare and quote by need, never schema-qualified`, and the `extensions.sql` golden via `golden: creates, moves, drops, and comments extensions`.

**CLI (`packages/cli/src/format.test.ts`, `packages/cli/src/goldens.test.ts`)** — `extension changes print additions, removals, and schema moves`, `extension plan steps print the bare name and the moved schema`, and the `extensions` golden scene.

**Live (`packages/postgres/src/live-scenes.ts`)** — the `extension-round-trip` scene installs a commented `hstore` in `hs1` and a commented `citext` in `public`, then moves `hstore` to `hs2` with a changed comment, adds a commented `pgcrypto` in `public`, and removes `citext`. The plan creates each build's non-public install schema itself — the baseline build creates `hs1`, and the target build and the migration create the target-only `hs2` — so the scene needs no `setupSql`. Its plan check pins phase 1's schema create then extension create, phase 12's two comments, and phase 13's alter then drop; catalog checks read `extnamespace` through `pg_namespace` and the comment through `obj_description(oid, 'pg_extension')`; `importChecks` compare the server-derived extension inventory, and `crossImportChecks` require a deep-equal applied-vs-target import.

## Evidence

The package suites pin model and workspace read/write, import forms and every diagnostic, value-carrying field order and copy isolation, phase placement and transaction classification, render grammar and quoting, and the CLI and SQL goldens. On the local PostgreSQL 16.15 scratch server the gated suite is 398 tests across 50 scenes, 3 skipped — the three PostgreSQL 18 scenes, skipped by name — and all 50 run on the CI's PostgreSQL 18. The live scene fails loudly if `hstore`, `pgcrypto`, or `citext` is unavailable or the relocatable schema move is refused. `pnpm docs:counts --check` reports no stale claim, and the five gates are green on the final tree.

## Acceptance

- A default dump's extensions import with their install schema and comment, sort by name, and re-import unchanged; a schema-less create, `VERSION`, `CASCADE`, an unknown option, a member statement, and every `ALTER EXTENSION` form are named, never silent.
- `diff` reports add, remove, and a value-carrying schema change; `plan` creates in phase 1, comments in phase 12, and alters then drops in phase 13; render emits the three statements and the extension comment target without `IF NOT EXISTS`.
- Workspace read compatibility, both goldens, and the gated scene pass; all five gates and `pnpm docs:counts --check` are green.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.
- The gated suite round-trips `extension-round-trip`, and the applied and target imports are deep-equal on PostgreSQL 16.15; CI reruns it on PostgreSQL 18.
- This plan, [ADR 0022](../adr/0022-extensions-travel-the-model.md), the `[Unreleased]` changelog entry, and [#91](https://github.com/osama784/schemamill/issues/91) carry the ship note.

## Deferred

Named, never silent:

- **Extension version modeling and `--exclude-extension` gating** — [#57](https://github.com/osama784/schemamill/issues/57); `VERSION` is flagged and dropped today.
- **Extension ownership** — `extowner` is not preserved by `pg_dump`; ownership remains unmodeled.
- **Member-object modeling and `ALTER EXTENSION … ADD`/`DROP`** — both statements are skipped and named; normal dumps exclude members, and the forms are binary-upgrade-only.
- **Binary-upgrade dumps** — outside the normal-dump contract.
- **Catalog `pg_extension` reads and comment introspection** — `catalog.ts` returns `extensions: []`; a follow-up is recorded at bookkeeping, and a live-database import loses extensions with no diagnostic until it lands.
- **Catalog extension-member filtering** — the [ADR 0018](../adr/0018-catalog-sequences-and-identity-columns.md) residual, untouched.
- **Built-in extensions** — `plpgsql` is never dumped and is never modeled.
- **Extension config-table data (`extconfig`) semantics** — only the dump's own tables are modeled as tables; the configuration meaning is not.
- **`DROP EXTENSION` with `--clean` dumps** — outside the normal-dump contract.
- **Extension availability checks** — `CREATE EXTENSION` needs the extension's files on the target host; an unavailable extension fails loudly at apply.
