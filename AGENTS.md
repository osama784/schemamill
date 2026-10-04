# AGENTS.md

Schemamill is a local-first studio for database schemas: one canonical model, import from DDL or a live database, semantic diffs, and reviewable migration SQL.

`CONTEXT.md` is the vocabulary law: use its terms in code, docs, issues, and commits; when a term is missing or wrong, fix `CONTEXT.md` rather than coining a synonym. Deeper material lives in `docs/domain/` (vision, principles, context map), `docs/adr/` (durable decisions), and `docs/plans/` (slice plans and deferred items).

## Repository map

- `packages/core` — the canonical model, diff, plan, and hazard analysis; framework-free ([ADR 0005](docs/adr/0005-framework-free-core.md)).
- `packages/postgres` — DDL import/parsing and migration SQL rendering.
- `packages/cli` — the `schemamill` command-line entry point.
- `packages/server` — the studio's server.

Behavioral contracts are pinned by unit tests, CLI goldens, and the gated live-PG suite; read the nearest tests before changing behavior.

## Commands

Run from the repo root; all five gates must be green before a PR:

- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm format:check` — `pnpm format` writes fixes

Scope a gate to one package with `pnpm --filter @schemamill/<pkg> <script>`.

`@schemamill/postgres` carries a live-PostgreSQL harness (`src/live-pg.test.ts`, scenes in `src/live-scenes.ts`) gated on `SCHEMAMILL_TEST_PG_URL`: unset, the live tests skip with a reason; set but unreachable, they fail loudly. A local scratch cluster is available for gated runs — see the latest handoff notes or ask the user for its URL. CI runs Node 24 and 26, plus a `verify-postgres` job on Node 24 against a `postgres:18` service with PostgreSQL 18 client tools.

## Git rules

Load `.agents/skills/branch-pr-flow/SKILL.md` before committing, pushing, opening a PR, or releasing.

- `main` is release-only. Work lands on `dev` through a feature branch and a PR.
- Merge commits only. Never amend, rebase, reset, or force-push.
- Stage explicit paths only. Never `git add -A`.
- Keep the user's uncommitted files untouched in every session: `skills-lock.json` stays modified and unstaged; the untracked `.agents/skills/{codebase-design,pr}/` directories stay untracked. Never stage, revert, clean, or delete them.
- Use conventional commit messages, one workstream per commit. Write the message to a file and pass `-F` — shell backtick expansion has mangled an inline message before.
- Add a `CHANGELOG.md` entry under `[Unreleased]` as each user-facing change lands; version cuts follow `.agents/skills/changelog-flow/SKILL.md`.

## Workflow

- Design-review-first for non-trivial work: build a design tree, gather facts, present numbered questions with recommendations, then get approval on a written brief before implementing.
- Keep a tracker issue as the ledger for a slice: brief, implementation notes, review findings, and the ship note all land there.
- Structural decisions get an ADR under `docs/adr/`; terminology follows `CONTEXT.md`.
- Plans list what they defer, by name, in their `Deferred` section; pick deferred work up from there, never silently.
- Verify adversarially: mutation checks, live evidence, falsification. A surviving mutation is an untested rule.
- Docs claims about tests must match the actual test names and behavior; check the wording against the suite.
- Keep mutating agents serialized (git contention); parallelize read-only and GitHub-only work.
- GitHub issues and PRs are the durable record across sessions; `/tmp/opencode` is ephemeral.

## Done means

- All five gates green on the final tree; CI re-runs them on Node 24 and 26.
- A `[Unreleased]` changelog entry for every user-facing change.
- Brief, evidence, and ship note recorded on the tracker issue.
- No stray files staged or committed, and the user's uncommitted files untouched.

## Factory

`.factory/` is the factory's local workbench (`state.md`, `journal.md`, `handoffs/`) — git-excluded, never committed, and never edited from non-factory sessions.

Queue items are GitHub issues labeled `factory:ready`, `factory:doing`, `factory:proposed`, `factory:blocked`, or `factory:needs-human`; the factory proposes (`factory:proposed`) and works (`factory:ready`) but never self-approves. Escalations arrive as `factory:needs-human` issues. The factory runs one item at a time on a single branch.

Factory conventions and the pipeline: `/home/lenovo/projects/factory/docs/design.md`.
