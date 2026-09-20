# Context Map

**Status:** drafted 2026-09-19 · living document

## Contexts

**schemamill** (one bounded context): the canonical model, import & introspection, and the change engine, delivered through the canvas studio and the CLI. Every schemamill subdomain lives inside this single context.

**PostgreSQL** (external, not owned): live databases and their textual forms (DDL dumps, migration files). It has its own vocabulary — catalog names, type and constraint semantics, lock modes — which schemamill never adopts.

## Subdomains (the problem space)

- **Core domain:** schema-change intelligence — the canonical model, import fidelity, semantic diff, and the hazard-annotated plan. Where investment and craft go.
- **Supporting subdomain:** presentation and projection — migration SQL rendering, export projections (DDL, markdown, JSON), import diagnostics.
- **Generic subdomain:** plumbing — CLI/server mechanics, packaging, proven parsing and catalog tooling.

## Relationships

- **schemamill ↔ PostgreSQL: Anti-Corruption Layer, both directions.** Inbound, introspection and DDL parsing translate PostgreSQL's model into the canonical model; no catalog or dialect vocabulary leaks in. Outbound, plans are rendered into PostgreSQL's language as SQL for the user to apply. The database is never written to; the user carries every change across the boundary.
- **Future engines:** additional ACL edges — a direction, not a promise.
- No Shared Kernel, no Conformist, no Customer/Supplier: there is nothing to share or conform to — only to translate.
