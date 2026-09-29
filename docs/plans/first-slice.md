# First slice — import, compare, plan, render

**Status:** planned, not yet built · **Last updated:** 2026-09-24

The first end-to-end path through the engine, from the command line: read two PostgreSQL DDL dumps, compare them, and render the migration plan as migration SQL. Generation only — nothing is applied by schemamill, and nothing is persisted ([ADR-0001](../adr/0001-generate-never-apply.md)). The dialect seam this attaches to is described in [`docs/architecture.md`](../architecture.md).

## Scope

**In:** tables, columns (name, type, `NOT NULL`, `DEFAULT`), primary keys, foreign keys; the PostgreSQL schema (namespace) is part of table identity.

**Out, named in diagnostics — never silent:** unique, check, and exclude constraints; every index; sequences and identity semantics (a `serial` column's `nextval(…)` default survives as default text); views; triggers; functions; enum, domain, and composite definitions; extensions; comments; grants; row-level security; partitioning; inheritance; tablespaces.

**Deliberately shallow for now:** column types are stored as written (whitespace-normalized text) — semantic equivalence such as `int` vs `integer` needs catalog knowledge and lands later. Renames read as remove + add; hazard annotations, persistence, introspection, and the studio arrive in later slices.

## Commands

- `schemamill compare <baseline> <target>` — prints the diff.
- `schemamill plan <baseline> <target>` — prints the migration plan and its migration SQL.

## Approach

- **Parsing:** PostgreSQL 18's own grammar via `libpg-query` (WASM) inside `@schemamill/postgres`, behind the `DdlImporter` declaration in core, plus a dump preprocessor (psql meta-commands, `COPY … FROM stdin` blocks, statement splitting) and per-statement parsing so one bad statement never sinks a dump.
- **Diagnostics:** everything skipped or flagged is named, with positions.
- **Rendering:** deterministic — the same models produce the same SQL.

## Workstreams

1. **Parser foundation** — the grammar dependency under Node 24/ESM, the dump preprocessor, and a parse canary.
2. **Import** — translation into the canonical model at the scope above, with skip-and-name diagnostics.
3. **Model & compare** — the payload shapes and the diff between two models.
4. **Migration plan & rendering** — dependency-ordered steps and deterministic SQL.
5. **Command-line surface** — `compare` and `plan`, wired through the CLI package.
6. **Verification & dogfood** — golden tests, a scratch-PostgreSQL harness that applies the generated SQL to a disposable database and checks the result, a CI job once the harness is stable, and one pass on real dumps.

## Done means

- Golden tests cover diff and rendering; generated SQL applies cleanly to a disposable PostgreSQL 18 and the resulting schema matches the target.
- `compare` and `plan` run end to end from the shell on real dumps.

## Non-goals

Everything not listed under Scope — including hazards, snapshots on disk, introspection, and the studio — is a later slice. Direction, not a commitment: this plan can change; the code and the changelog are the record of what actually shipped.
