# Persistence attributes — generated columns, temporary persistence, typed tables, ON COMMIT, storage parameters (import slice L)

**Status:** proposed (supply pass 2026-11-02) · **Last updated:** 2026-11-02

**Size:** M. The brief may split into L1 (generated columns) and L2 (table storage parameters), with the three flag decisions landing in whichever half touches the create-table extras; one brief is recommended because both modeled attributes change the same create/add/diff path and share one live scene.

Slice L of the [import long-tail plan](./import-long-tail.md) (`:60`), which also names K's storage half at `:59`; the [introspection attributes plan](./introspection-attributes.md) (`:41-45`) records the same leftovers from the catalog side. The importer already flags most of them, but a flag is the end of the line today: a generated column's expression is dropped at `packages/postgres/src/import.ts:760-765`, a typed table, `ON COMMIT` mode, and table storage parameters are flagged at `import.ts:1181-1188`, temporary persistence at `:1190`, and an `ALTER TABLE … SET (...)`, `RESET (...)` or `SET (key=DEFAULT)` action falls through to the generic skip at `:2395-2397`. Index storage parameters still skip the whole index (`import.ts:2467-2469`), pinned at `packages/postgres/src/import.test.ts:1928-1980`. Only the temporary-table flag is pinned by exact wording (`import.test.ts:3665-3690`); the generated-column, typed-table, and `ON COMMIT` flags have no dedicated pin. [ADR 0015](../adr/0015-column-attributes-travel-the-model.md) (`:7`, `:17`) deferred all of these, and is the decision this slice must either extend or leave standing.

## Goal

Every remaining table/column persistence attribute a dump can state is either modeled end-to-end — imported, diffed, planned, rendered, and round-tripped — or left as a precise, pinned, documented flag; no attribute is dropped with generic wording, and no dump form is silently lost. The modeled set is generated columns and table storage parameters; temporary persistence, typed tables, and `ON COMMIT` remain named flags for the reasons below.

## Scope

**In:**

- Generated columns: `Column.generated`, import of `GENERATED ALWAYS AS (…) STORED|VIRTUAL`, create/add rendering, diff and plan, drop/add change semantics, workspace read/write, CLI display and goldens, and a gated live round trip for the stored form.
- Table storage parameters: `Table.storageParameters`, import of `CREATE TABLE … WITH (…)` and `ALTER TABLE … SET|RESET (…)`, create rendering, a parameter-alter step, diff and plan, workspace read/write, CLI display and goldens, and a gated live round trip.
- Precise flags for temporary-table persistence, typed tables (`OF type`), and `ON COMMIT`, each with an exact pinned diagnostic; the table still imports with the structure the model can carry.
- A `CONTEXT.md` **Generated column** and **Storage parameters** entry; an ADR recording the model shapes and the decision to leave the three attributes flagged; a `[Unreleased]` changelog entry.

**Out, named — never silent:** catalog introspection of these attributes (the read still reports no `attgenerated`, `reloptions`, or `relpersistence` beyond the existing unlogged state); tablespaces and `ALTER TABLE … SET TABLESPACE` ([slice K](./import-long-tail.md)); index storage parameters (the index envelope stays whole-object-skip); typed-table inheritance; generated-column expression parsing or semantic comparison; version gating ([#57](https://github.com/osama784/schemamill/issues/57)); partition-specific storage ([#142](https://github.com/osama784/schemamill/issues/142)); and the data-loss and rewrite hazards of generated-column or storage changes ([#58](https://github.com/osama784/schemamill/issues/58)).

**Deliberately shallow for now:** a generated expression and every storage-parameter value are opaque text. The model never parses, validates, or evaluates them; `'70'` versus `70` and a hand-authored expression spelling remain the spellings the importer received, exactly as defaults and check expressions are stored.

## Decisions

- **D1 — One disposition per attribute.** The slice's contract is the table, not a promise that everything becomes model state:

  | Attribute | v1 disposition | Why |
  | --- | --- | --- |
  | Generated column (`GENERATED ALWAYS AS (…) STORED`) | **model end-to-end** | A dump emits it; the expression is opaque text with no type dependency; create/add/plan/render are all local to the column. |
  | Table storage parameters (`WITH`, `SET`, `RESET`) | **model end-to-end** | A dump and `ALTER TABLE` both emit them; a key/value map needs no type or catalog knowledge; `SET`/`RESET` render deterministically. |
  | Temporary-table persistence | **precise flag** | [ADR 0015](../adr/0015-column-attributes-travel-the-model.md) deliberately kept temporary tables out of the model; `pg_dump` never dumps a temporary table; and PostgreSQL has no `ALTER TABLE` that turns a permanent table temporary, so modeling it would force a drop/recreate path for an object neither inbound path produces. The existing `dropped temporary-table persistence from <table>` wording stays, now pinned. |
  | Typed table (`OF type`) | **precise flag** | Composite types are slice J's object family; a typed table's columns come from an unmodeled type, so modeling the table without the type cannot round-trip its structure. The flag gains the type identity: `dropped typed-table definition OF <schema>.<type> from <table>`. |
  | `ON COMMIT` | **precise flag** | `ON COMMIT` is only meaningful for temporary tables, which stay out; `pg_dump` never emits it; the flag names the mode (`DROP`, `DELETE ROWS`, or `PRESERVE ROWS`) instead of the generic label. |

- **D2 — Generated-column shape.** `Column.generated?: { readonly expression: string; readonly stored: boolean }`; absent means the column is not generated. `expression` is the text between `AS (` and its balanced `)`, whitespace-normalized with `normalizeSourceText` (`packages/postgres/src/import.ts:4391`), the same slice-and-normalize treatment `checkExpressionText` gives a check (`import.ts:3453`). `stored` is `true` for `STORED` and `false` for `VIRTUAL`; the parser exposes the distinction as `generated_kind` on the `CONSTR_GENERATED` constraint (`generated_when` remains the identity mode and is not this flag). A generated column cannot carry a `DEFAULT`; import flags the impossible combination rather than storing both, and the workspace parser fails closed on it.
- **D3 — Generated columns travel the whole path.** A new `generated` member joins `ColumnFieldChange` after `default`. `create-table` and `add-column` render `name type [COLLATE …] GENERATED ALWAYS AS (<expr>) STORED|VIRTUAL [NOT NULL]`; `alter-column` never carries it. PostgreSQL cannot change a generation expression in place, so any `generated` difference — expression, stored flag, or presence — decomposes at plan time to `drop-column` followed by `add-column` (phases 7 and 9 of the table phases), carrying the target column wholesale. That is destructive; the hazard family for relation-level data loss is [#58](https://github.com/osama784/schemamill/issues/58), and the plan names the drop/add rather than hiding it behind an `ALTER` that cannot work. A stored generated column is available at the table floor; a virtual one is PostgreSQL 18 syntax and renders as declared, with declaration validation against the target staying with the named version-gating residual ([ADR 0024](../adr/0024-synthesized-forms-consult-the-target-version.md)).
- **D4 — Storage-parameter shape.** `Table.storageParameters?: Readonly<Record<string, string>>`; absent means no options, and an empty map normalizes to absent so a `RESET` of the last key produces no diff churn. Keys are stored as written, including the `toast.` namespace the parser reports separately as `defnamespace` (for example `toast.autovacuum_enabled`); values are stored as PostgreSQL's textual value (`70`, `false`, `true`), never as JavaScript numbers or booleans, so a dump spelling round-trips. A repeated key keeps its last value, matching PostgreSQL. Keys sort lexicographically in serialization and rendering.
- **D5 — Storage parameters travel the whole path.** Import reads `CreateStmt.options` (`import.ts:1188`), `AT_SetRelOptions`, and `AT_ResetRelOptions`; because the parser collapses `SET (key=DEFAULT)` and a quoted `'default'` into the same string, the importer reads the source spelling to decide reset versus value, and flags a value node it cannot spell. `SET` adds or overwrites, `RESET` removes, and a repeated `CREATE TABLE` clears the map (`import.ts:536-543`). Diff adds `storage-parameters-changed { before, after }` after the index entries and before `persistence-changed`. The plan gains `alter-storage-parameters { table, set, reset }`, with sorted entries in table phase 13 beside `alter-persistence`, before the key phases. `create-table` renders `WITH (key = 'value', …)` after the closing parenthesis; an alter step renders one `ALTER TABLE … SET (…)` and then one `ALTER TABLE … RESET (…)`, each sorted, and never both halves for the same key. Keys render with each dotted segment minimally quoted and values as string literals, which PostgreSQL accepts for every reloption kind. Index storage parameters stay out; the index envelope remains the whole-object skip recorded in the [constraints and indexes plan](./constraints-indexes.md).
- **D6 — The three flags become precise and pinned.** Temporary-table persistence keeps its wording and is now pinned exactly; typed tables report `dropped typed-table definition OF <schema>.<type> from <table>` from `CreateStmt.ofTypename` (`import.ts:1183`); `ON COMMIT` reports `dropped ON COMMIT <mode> from <table>` from the `ONCOMMIT_*` enum (`import.ts:1184-1185`). Each is a flag, not a skip: the table still imports with its columns, constraints, indexes, persistence, and comment. No attribute is silently dropped, and the three decisions are documented in the plan's §Decisions rather than left implicit in code.
- **D7 — Workspace and vocabulary.** `generated` joins the column serializer/parser and `storageParameters` the table serializer/parser; a pre-slice `model.json` without either reads unchanged, an empty map and an absent object both read as no options, and no format version is introduced ([#54](https://github.com/osama784/schemamill/issues/54)). `CONTEXT.md` gains **Generated column** (a column whose value PostgreSQL computes from an opaque expression, stored or virtual) and **Storage parameters** (a table's deterministic `WITH` key/value options) when the slice lands.

## Acceptance

- A dump with a stored generated column, a table `WITH (…)`, and later `ALTER TABLE … SET|RESET` imports to the model's `Column.generated` and `Table.storageParameters`; the rendered target builds the same shapes and re-imports to an empty diff.
- Generated-column creation and addition render correctly; a changed expression, stored flag, or presence plans as a drop and add column, pinned at the step level; storage-parameter additions, changes, and removals plan as `SET`/`RESET` and render deterministically.
- Temporary persistence, typed tables, and `ON COMMIT` each keep a precise, exact diagnostic and still import the rest of the table; no form is silently dropped.
- The gated live scene covers a stored generated column and storage-parameter `SET`/`RESET`, applies the migration, and proves the applied and target dumps import to the same model, with catalog checks on `attgenerated`, `pg_get_expr(adbin, adrelid)`, and `reloptions`.
- Workspace round-trip and CLI goldens pass; the five gates and `pnpm docs:counts --check` are green; `CONTEXT.md`, the ADR, the plan, and a `[Unreleased]` changelog entry land with the slice.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root; the live suite passes on PostgreSQL 16.15 locally and on the CI's PostgreSQL 18.
- The live scene round-trips generated columns and storage parameters with a deep-equal cross-import; the three flag paths are pinned by unit tests at their exact wording and the affected table shapes.
- The plan, the ADR, the two `CONTEXT.md` terms, the changelog entry, and the tracker issue carry the ship note.

## Deferred

Named for the slices that own them, never silent:

- **Catalog introspection of generated columns, storage parameters, temporary persistence, typed tables, and `ON COMMIT`** — `packages/postgres/src/catalog.ts` reads none of them; a model carrying the modeled attributes is intentionally not what the catalog read returns yet. The live scene omits the introspection assertion, and the follower is recorded at bookkeeping.
- **Tablespaces and `ALTER TABLE … SET TABLESPACE`** — slice K ([#59](https://github.com/osama784/schemamill/issues/59) scope, [import long tail](./import-long-tail.md)); a table's `WITH` map deliberately does not absorb `TABLESPACE`.
- **Index storage parameters** — the index envelope stays whole-object-skip (`import.ts:2467-2469`); index option modeling belongs with the index-expressiveness slice ([#90](https://github.com/osama784/schemamill/issues/90)).
- **Typed-table inheritance** — typed tables and their type family are slice J's object model; this plan flags `OF type` only.
- **Generated-column expression parsing or semantic diff** — expressions compare as opaque text.
- **Version gating and declaration validation** — [#57](https://github.com/osama784/schemamill/issues/57) and the declaration-validation follow-up; a `VIRTUAL` generated column and other PostgreSQL 18-only declarations render as declared.
- **Partition-specific storage and attributes** — [#142](https://github.com/osama784/schemamill/issues/142).
- **Data-loss and rewrite hazards for generated-column drop/add and storage-parameter changes** — [#58](https://github.com/osama784/schemamill/issues/58); this plan makes the drop/add explicit, not safe.
- **Temporary-table persistence modeling** — deliberately not adopted; see D1. The flag is the contract until a slice owns temporary objects end-to-end.
- **`ON COMMIT` modeling** — follows temporary-table modeling; neither is in the model.

## Non-goals

- Data migration or backfilling a generated column.
- Expression parsing, normalization beyond whitespace, or semantic equivalence.
- Modeling composite types or tablespaces.
- Changing the index envelope, index skip wording, or index storage behavior.
- Reworking the existing unlogged-persistence model.
