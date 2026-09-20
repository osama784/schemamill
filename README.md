# schemamill

> Model your database visually. Change it safely. Keep it local.

schemamill is a local-first studio for PostgreSQL schema change. One canonical model is the source of truth: import from DDL text or introspect a live database (read-only), capture snapshots, and compare a baseline to a target to see what actually changed, not which lines moved. The diff yields a migration plan, rendered as deterministic, reviewable migration SQL annotated with the hazards of applying it. Applying it is your call: schemamill generates, never applies, and never writes to a database.

**Status:** Early — no implementation yet. The domain model, the glossary, and the accepted architecture decisions are in place; the code comes next.

## Where things live

- [`CONTEXT.md`](./CONTEXT.md) — the glossary: the vocabulary law for the project's language.
- [`docs/domain/`](./docs/domain/) — five one-pagers: the vision, the core domain, the ubiquitous language, the context map, and principles & refusals.
- [`docs/adr/`](./docs/adr/) — the accepted architecture decisions.

**License:** MIT
