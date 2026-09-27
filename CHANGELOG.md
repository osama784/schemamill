# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **PostgreSQL parser foundation** — `@schemamill/postgres` pinned `libpg-query` (PostgreSQL 18 grammar, WASM) and gained a `pg_dump`-style dump preprocessor: psql meta-commands and `COPY … FROM stdin` data blocks were skipped and named, statements were split safely around dollar quotes, comments, and escaped strings, and every statement was parsed on its own so one bad statement never sinks a dump — parse failures were reported with positions.
- **Import dumps into the canonical model** — `@schemamill/postgres` gained `importDump`: a `pg_dump`-style dump was translated into the canonical model — tables, columns with as-written type and `DEFAULT` text, primary keys, foreign keys, schema-qualified identity — and everything outside the first-slice subset was skipped or flagged with a named, positioned diagnostic.
- **Diff two models** — `@schemamill/core` gained `diff(baseline, target)`: two canonical models were compared into a deterministic list of changes — tables added, removed, and changed, with nested column, primary-key, and foreign-key changes — matched by schema-qualified table identity and by column name, with no rename detection (renames read as remove plus add) and the stored `type` and `default` text compared exactly as written. Comparison output was independent of input array order, and payloads were returned as independent copies.

### Documentation

- **Branch/PR and changelog workflows** — adopted a feature-branch → `dev` → `main` flow with `gh` PRs and a Keep a Changelog–based `CHANGELOG.md`, captured as repo skills.
- **First-slice plan** — [`docs/plans/first-slice.md`](docs/plans/first-slice.md) scopes the first end-to-end path: read two PostgreSQL DDL dumps, compare, and render the migration plan as migration SQL.
