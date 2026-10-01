# schemamill

> Model your database visually. Change it safely. Keep it local.

schemamill is a local-first studio for PostgreSQL schema change. One canonical model is the source of truth: import from DDL text or introspect a live database (read-only), capture snapshots, and compare a baseline to a target to see what actually changed, not which lines moved. The diff yields a migration plan, rendered as deterministic, reviewable migration SQL annotated with the hazards of applying it. Applying it is your call: schemamill generates, never applies, and never writes to a database.

**Status:** Early — the core engine and CLI are in place: import from pg_dump text, diff, plan with hazards, and deterministic migration SQL, verified against live PostgreSQL 16 and 18. Introspection, snapshots, and the studio come next.

## Where things live

- [`CONTEXT.md`](./CONTEXT.md) — the glossary: the vocabulary law for the project's language.
- [`docs/domain/`](./docs/domain/) — five one-pagers: the vision, the core domain, the ubiquitous language, the context map, and principles & refusals.
- [`docs/adr/`](./docs/adr/) — the accepted architecture decisions.
- [`docs/plans/`](./docs/plans/) — the slice plans: what each shipped slice set out to do, and where it landed.
- [`CHANGELOG.md`](./CHANGELOG.md) — the release history: what shipped, version by version.

**License:** MIT
