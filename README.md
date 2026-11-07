<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/brand/exports/readme/lockup-horizontal-480-transparent-dark.png 1x, ./docs/brand/exports/readme/lockup-horizontal-960-transparent-dark.png 2x">
    <source media="(prefers-color-scheme: light)" srcset="./docs/brand/exports/readme/lockup-horizontal-480-transparent-light.png 1x, ./docs/brand/exports/readme/lockup-horizontal-960-transparent-light.png 2x">
    <img alt="schemamill" src="./docs/brand/exports/readme/lockup-horizontal-480-transparent-light.png" width="480">
  </picture>
</p>

# Schemamill

schemamill is a local-first studio for PostgreSQL schema change: one canonical model is the source of truth — import a schema from DDL text, compare a baseline to a target, and see what actually changed rather than which lines moved. The diff yields a semantic migration plan rendered as deterministic, reviewable migration SQL annotated with the hazards of applying it. It generates, never applies, and never writes to a database. **Model your database. Change it safely. Keep it local.**

## Status

Early. The engine and the CLI are released through v0.7.0: DDL import (tables, columns, primary and foreign keys, sequences, identity columns, constraints, indexes, comments, views, and extensions), semantic diff, deterministic migration SQL with hazards and transaction boundaries, a workspace (`init`, `compare`, `plan`, `export`), and live catalog introspection in the engine, verified against live PostgreSQL locally and in CI.

Not released yet: a CLI command for live-database introspection (the engine exposes a live-tested `catalogReader`, but no command consumes it yet), snapshots, and the studio UI. Nothing is published to npm.

## Install from source

Prerequisites:

- Node.js `^22.22.3 || ^24.15.0 || >=26.0.0` (from `engines` in `package.json`)
- pnpm `12.5.1` (from `packageManager` in `package.json`)

Nothing is published to npm yet, so install from a clone:

```sh
git clone https://github.com/osama784/schemamill.git
cd schemamill
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --help
```

The last command prints the usage and the four commands the CLI carries:

```text
Usage: schemamill [options] [command]

Commands:
  compare [options] [baseline] [target]  Print the diff and any hazards between a baseline and a target.
  export [options]                       Print the workspace model as DDL or canonical JSON.
  init [options] [path]                  Create a workspace in a directory.
  plan [options] [baseline] [target]     Print the migration plan and its SQL between a baseline and a target.
```

## Quickstart

From the clone root, write two small dumps in a throwaway directory — a baseline and a target:

```sh
mkdir -p /tmp/schemamill-quickstart

cat > /tmp/schemamill-quickstart/baseline.sql <<'SQL'
CREATE TABLE public.users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
SQL

cat > /tmp/schemamill-quickstart/target.sql <<'SQL'
CREATE TABLE public.users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    display_name text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_email_lookup ON public.users (email);
SQL
```

Compare them:

```sh
node packages/cli/dist/index.js compare /tmp/schemamill-quickstart/baseline.sql /tmp/schemamill-quickstart/target.sql
```

```text
~ table public.users
    + column display_name text
    + index users_email_lookup (email)
```

Generate the plan and its SQL:

```sh
node packages/cli/dist/index.js plan /tmp/schemamill-quickstart/baseline.sql /tmp/schemamill-quickstart/target.sql
```

```text
2 steps in one transaction:
 1. add-column    public.users.display_name text
 2. create-index  public.users: index users_email_lookup (email)

BEGIN;
ALTER TABLE public.users ADD COLUMN display_name text;
CREATE INDEX users_email_lookup ON public.users USING btree (email);
COMMIT;
```

### A workspace

A workspace keeps one canonical model in `.schemamill/model.json`, so a dump can be compared against the model instead of another dump. Initialize it from the baseline, then plan the target against it:

```sh
SCHEMAMILL="$PWD/packages/cli/dist/index.js"

node "$SCHEMAMILL" init /tmp/schemamill-quickstart/workspace --from /tmp/schemamill-quickstart/baseline.sql

cd /tmp/schemamill-quickstart/workspace
node "$SCHEMAMILL" plan ../target.sql
node "$SCHEMAMILL" export
```

`plan` prints the same two-step migration, and `export` prints the workspace model as the DDL that builds it (pass `--format json` for the canonical JSON model).

## Scope and refusals

PostgreSQL-only, local, and deliberate about its limits: not a database client, not a migration runner, no ORM coupling, no AI features, no cloud, no multi-database support. The point is that a change is reviewable before it touches anything real.

## Where things live

- [`CONTEXT.md`](./CONTEXT.md) — the glossary: the vocabulary law for the project's language.
- [`docs/domain/`](./docs/domain/) — five one-pagers: the vision, the core domain, the ubiquitous language, the context map, and principles & refusals.
- [`docs/adr/`](./docs/adr/) — the accepted architecture decisions.
- [`docs/plans/`](./docs/plans/) — the slice plans: what each slice set out to do, and where it landed.
- [`docs/brand/`](./docs/brand/) — the brand kit: marks, wordmark, exports and the brand sheet; conventions in [`DESIGN.md`](./DESIGN.md).
- [`CHANGELOG.md`](./CHANGELOG.md) — the release history: what shipped, version by version.

**License:** MIT
