# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **PostgreSQL parser foundation** — `@schemamill/postgres` now pins `libpg-query` (PostgreSQL 18 grammar, WASM) and can ingest `pg_dump`-style files: psql meta-commands and `COPY … FROM stdin` data blocks are skipped and named, statements are split safely around dollar quotes, comments, and escaped strings, and each statement is parsed on its own so one bad statement never sinks a dump — parse failures are reported with positions.

### Documentation

- **Branch/PR and changelog workflows** — adopted a feature-branch → `dev` → `main` flow with `gh` PRs and a Keep a Changelog–based `CHANGELOG.md`, captured as repo skills.
- **First-slice plan** — [`docs/plans/first-slice.md`](docs/plans/first-slice.md) scopes the first end-to-end path: read two PostgreSQL DDL dumps, compare, and render the migration plan as migration SQL.
