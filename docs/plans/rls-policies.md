# Row-level security — policies and enablement (import slice H)

**Status:** proposed (supply pass 2026-11-02) · **Last updated:** 2026-11-02

**Size:** M. The brief may split into H1 (the `Policy` type and policy diff/plan/render) and H2 (the table's enablement/force state) if the policy grammar dominates, but one brief is recommended: enablement's ordering only has meaning relative to policy drops and creates, and a split would leave a half round trip.

Slice H of the [import long-tail plan](./import-long-tail.md) (`:56`). A real dump carries `CREATE POLICY` and the four `ALTER TABLE … [NO] [FORCE] ROW LEVEL SECURITY` commands, and the importer drops both families today: `CreatePolicyStmt` and `AlterPolicyStmt` fall through to the generic skip (`packages/postgres/src/import.ts:3812-3820`, `:497-498`), while the row-security commands are described as SQL and then skipped as unhandled `ALTER TABLE` actions (`import.ts:2225-2239`, `:2395-2397`). The skips are pinned by `names every long-tail family in dump order` (`packages/postgres/src/import.test.ts:546`), with the exact messages at `:313-385`. Views and comments are the precedent for a family landing whole: model shape, import, diff, plan, render, CLI, and a gated round trip ([views plan](./views.md), [comments plan](./comments.md)).

## Goal

A dump's policies and row-level-security state survive import → diff → plan → render → apply → dump import without silent loss: policies on tables, the permissions each policy grants, and whether the table has RLS enabled or forced.

## Scope

**In:**

- `Table.policies`, a required array of `Policy` members beside `columns`, constraints, and indexes; `Table.rowLevelSecurity`, the explicit-only enablement/force state.
- Import of `CREATE POLICY` and `ALTER TABLE … ENABLE|DISABLE|FORCE|NO FORCE ROW LEVEL SECURITY`; repeated `CREATE TABLE` replaces the table wholesale, clearing policies and state, as it clears indexes (`import.ts:536-543`).
- Diff: policy addition, removal, and change; row-level-security state change, as their own table member changes.
- Plan: `create-policy`, `drop-policy`, and `alter-row-level-security` steps in a dedicated phase after the table phases and before comments.
- Render: `CREATE POLICY`, `DROP POLICY`, and the four `ALTER TABLE` statements, with deterministic clause order and quoting.
- CLI display and goldens for the new changes and steps; workspace compatibility; a gated live scene with catalog checks on `pg_policy` and `pg_class.relrowsecurity`/`relforcerowsecurity` and a cross-import deep equality.
- A new ADR for the model shape, ordering, and change strategy; `CONTEXT.md` gains **Policy** and **Row-level security**; a `[Unreleased]` changelog entry.

**Out, named — never silent:** catalog introspection of `pg_policy`, `pg_class.relrowsecurity`, and `pg_class.relforcerowsecurity`; role and group membership, grants, and ownership ([#92](https://github.com/osama784/schemamill/issues/92)); semantic comparison of policy expressions; the `ALTER POLICY` authoring surface; RLS on partitions and inheritance ([#142](https://github.com/osama784/schemamill/issues/142)); policy comments (the [comments plan](./comments.md) keeps comments on unmodeled families skipped, and catalog comment reading is [#146](https://github.com/osama784/schemamill/issues/146)); and security labels. Each stays a named flag or skip until its owner lands.

**Deliberately shallow for now:** `USING` and `WITH CHECK` are opaque, whitespace-normalized text, like a check expression or a default. Roles are opaque names; the model never resolves membership, `CURRENT_USER`, or `PUBLIC`'s implied grants, and it never evaluates whether a policy admits a row.

## Decisions

- **D1 — A table member, not a top-level array.** A policy belongs to exactly one table and its name is unique only within that table, so `Table.policies` is the ownership and identity in one place, matching `indexes` and the constraint arrays (`packages/core/src/model.ts:95-118`). A top-level `Model.policies` array would duplicate an owner link every consumer already has. The array is required and sorted by policy name; a table removed from the model takes its policies and state with it.
- **D2 — The `Policy` shape.**
  ```ts
  interface Policy {
    readonly name: string;
    readonly command: 'all' | 'select' | 'insert' | 'update' | 'delete';
    readonly permissive: boolean;
    readonly roles: readonly string[];
    readonly using?: string;
    readonly withCheck?: string;
  }
  ```
  `name` is required and never synthesized. `command` is required, with explicit `FOR ALL` canonicalized to `all` and omitted on render (the default). `permissive` is required, with `AS PERMISSIVE` canonicalized to `true` and omitted on render; `AS RESTRICTIVE` is `false`. `roles` is required and sorted; `PUBLIC` is the default and canonicalizes to the empty array, so an explicit `TO PUBLIC` and an omitted `TO` compare equal, and a `PUBLIC` anywhere in a mixed list collapses the whole list to the default because `PUBLIC` already means every role. Named roles stay opaque, case-sensitive spellings, duplicates collapse, and a non-empty list renders as a `TO` list. `using` and `withCheck` are absent when the source states no clause; the model never synthesizes `WITH CHECK` from `USING`, because PostgreSQL's implicit behavior is semantic and a dump's omitted clause must round-trip as omitted. A policy has no comment field in this slice.
- **D3 — The row-level-security state.** `Table.rowLevelSecurity?: { readonly enabled: boolean; readonly forced: boolean }`, absent meaning both false. The object is explicit-only, like table `persistence`: `ENABLE`/`DISABLE` set `enabled`, `FORCE`/`NO FORCE` set `forced`, and neither command implies the other (PostgreSQL permits `FORCE` while RLS is disabled). An explicit both-false object normalizes to absent so a state reset produces no diff churn. A repeated `CREATE TABLE` clears the object. A table with no such state serializes without the key, as pre-slice workspaces do.
- **D4 — Import envelope.** `CreatePolicyStmt` supplies `policy_name`, `table`, `cmd_name`, `permissive`, `roles` (`RoleSpec`), `qual`, and `with_check`; the expressions are sliced from the statement's raw SQL between the clause keyword's balanced parentheses and normalized with `normalizeSourceText` (`import.ts:4391`), the same treatment a check expression receives (`import.ts:3453`). A `ROLESPEC_PUBLIC` role is dropped to the default; a `ROLESPEC_CSTRING` role is kept; any other role spec, a malformed expression slice, or a table that is not an imported plain table skips the whole policy and names it — a policy is never partially imported. `ALTER POLICY` stays skipped by its existing description (`import.ts:3817-3820`); it is a hand-authored form `pg_dump` does not emit. The four `AT_*RowSecurity` commands apply to the table draft (`import.ts:2225-2239`); a command on a table that was not imported takes the existing missing-table skip. `FORCE` on a removed table is not special: the table's removal carries the state.
- **D5 — Diff.** Policies are table members reported after indexes and before the persistence entry, in name order: `policy-added`, `policy-removed`, and `policy-changed` carrying `before`/`after`. A policy is identified by its name within the table; a rename is a removal and an addition, consistent with the engine's no-guess-rename doctrine. `row-level-security-changed` carries the before/after state and is reported after the policy entries. Neither change affects column or constraint equality, and a policy-only change never recreates the table.
- **D6 — Plan phase and order.** Three transactional steps join the union: `create-policy { table, policy }`, `drop-policy { table, policy }`, and `alter-row-level-security { table, field: 'enabled' | 'forced', value: boolean }`, one step per changed bit. They occupy a new global phase between the table phases and the comment phase, because a policy needs its table and every policy must exist before RLS is enabled. Within the phase, tables are visited in identity order and each table emits, in order: (a) the negative state bits the target clears, `NO FORCE` before `DISABLE`; (b) policy drops in policy-name order; (c) policy creates in policy-name order; (d) the positive state bits the target sets, `ENABLE` before `FORCE`. A target that disables RLS but keeps `FORCE` emits only `DISABLE`; one that unforces but keeps RLS enabled emits only `NO FORCE`. A table the plan removes emits no policy steps: the drop takes them. A changed policy decomposes to a drop and a create — the in-place `ALTER POLICY` form is deferred — so a policy change on a table whose RLS stays enabled has a short window with the old policy gone; that is a named cost, and the terminal step order never widens it to a table-wide outage.
- **D7 — Render.** `CREATE POLICY <name> ON <table> [AS RESTRICTIVE] [FOR <command>] [TO <roles>] [USING (<expr>)] [WITH CHECK (<expr>)];` emits only non-default clauses, in PostgreSQL's grammar order. `DROP POLICY <name> ON <table>;` names both the policy and its table, so a schema-qualified table is unambiguous. `ALTER TABLE <table> DISABLE|ENABLE ROW LEVEL SECURITY;` and `ALTER TABLE <table> NO FORCE|FORCE ROW LEVEL SECURITY;` quote identifiers minimally. A policy drop is never synthesized for a removed table, and a policy create never precedes its table's create.
- **D8 — Workspace and vocabulary.** `policies` and `rowLevelSecurity` join the table serializer and parser; a pre-slice `model.json` without them reads as no policies and no state, and no format version is introduced ([#54](https://github.com/osama784/schemamill/issues/54)). `CONTEXT.md` gains **Policy** (a named per-table rule set granting or restricting commands for roles, with opaque expressions) and **Row-level security** (a table's enablement/force state) as part of the implementation, so the plan's terms are not coined in code first.

## Acceptance

- A dump carrying permissive and restrictive policies, every command, explicit and default roles, both expression clauses, and each `ALTER TABLE` row-security form imports to one sorted `Table.policies` array and the expected `rowLevelSecurity` state; a dump of the rendered target imports back to a model the diff considers unchanged.
- Diff reports add, remove, and change for policies and state; a policy-only change never recreates the table; plan steps appear in the dedicated phase, with drops, creates, enablement, and force in the pinned order.
- `ALTER POLICY`, a non-`CSTRING`/`PUBLIC` role spec, a malformed expression, and a policy or row-security command on an unimported table are flagged or skipped by exact wording — never silently dropped.
- The gated live scene applies a plan that adds, changes, and removes policies and flips enablement and force, then proves both dumps import to the same model and the catalog shows the expected `pg_policy` rows and `relrowsecurity`/`relforcerowsecurity` values.
- Workspace round-trip, CLI goldens, the five gates, and `pnpm docs:counts --check` are green; `CONTEXT.md`, the ADR, the plan, and a `[Unreleased]` changelog entry land with the slice.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root; the live suite passes on PostgreSQL 16.15 locally and on the CI's PostgreSQL 18.
- The live scene round-trips and its cross-import check is deep-equal; the catalog checks prove the applied database carries the intended policies and state.
- The plan, the ADR, the two `CONTEXT.md` terms, the changelog entry, and the tracker issue carry the ship note.

## Deferred

Named for the slices that own them, never silent:

- **Catalog introspection of policies and RLS state** — `packages/postgres/src/catalog.ts` reads no `pg_policy` row and no `relrowsecurity`/`relforcerowsecurity` column today; a model carrying policies is intentionally not what the catalog read returns yet. The live scene's introspection assertion is omitted, and the follower is recorded at bookkeeping.
- **Role and group membership, grants, and default privileges** — [#92](https://github.com/osama784/schemamill/issues/92). Policies keep role names opaque; `PUBLIC` is the only role meaning the model normalizes.
- **Policy expression semantic diff** — expressions compare as opaque text; `id > 0` and `0 < id` are different.
- **The `ALTER POLICY` authoring surface** — policy changes decompose to drop and create; an in-place alter that avoids the policy window is a follow-up.
- **RLS on partitions and inheritance** — [#142](https://github.com/osama784/schemamill/issues/142). A partitioned parent imports as a plain table with a partitioning flag today; its policies attach to that draft and inherit the same limit.
- **Policy comments** — comments on unmodeled families stay skipped in the [comments plan](./comments.md); adding the policy target rides that slice, and catalog comment reading is [#146](https://github.com/osama784/schemamill/issues/146).
- **Security labels** — unmodeled, as everywhere else.
- **RLS row filtering or policy evaluation** — the engine never decides whether a row is visible.

## Non-goals

- Modeling roles, role membership, or grants.
- Data migration, row filtering, or policy evaluation.
- A studio authoring surface for policies or RLS toggles.
- Re-litigating the table ownership model or adding policies to views and materialized views.
