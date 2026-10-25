<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/brand/exports/readme/lockup-horizontal-480-transparent-dark.png 1x, ./docs/brand/exports/readme/lockup-horizontal-960-transparent-dark.png 2x">
    <source media="(prefers-color-scheme: light)" srcset="./docs/brand/exports/readme/lockup-horizontal-480-transparent-light.png 1x, ./docs/brand/exports/readme/lockup-horizontal-960-transparent-light.png 2x">
    <img alt="schemamill" src="./docs/brand/exports/readme/lockup-horizontal-480-transparent-light.png" width="480">
  </picture>
</p>

> Model your database. Change it safely. Keep it local.

schemamill is a local-first studio for PostgreSQL schema change. One canonical model is the source of truth: import a schema from DDL text, compare a baseline to a target, and see what actually changed — not which lines moved. The diff yields a migration plan, rendered as deterministic, reviewable migration SQL annotated with the hazards of applying it.

Applying it is your call: **schemamill generates, never applies, and never writes to a database.**

**Status:** Early — the engine and the CLI are released through v0.6.0: DDL import (tables, columns, primary and foreign keys, sequences, identity columns, constraints, indexes), semantic diff, and deterministic migration SQL with hazards and transaction boundaries, verified against live PostgreSQL locally and in CI. Not released yet: live-database introspection, snapshots, and the studio UI. Nothing is published to npm.

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
