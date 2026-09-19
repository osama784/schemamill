# Domain Vision Statement

**Status:** drafted 2026-09-19 · living document

> **Summary:** schemamill is a local-first database modeling studio: one canonical schema model, shaped on an interactive canvas, imported from existing databases, compared across versions, and exported as reviewable, hazard-annotated migration SQL.

**Tagline:** Model your database visually. Change it safely. Keep it local.

## Who it is for

The solo or embedded backend developer who owns the schema and answers for it in production. Its author is its first user — dogfooding on a real production schema from the start.

## The core domain: the safe-change loop

Schema change is the moment of risk; schemamill exists to make it boring. The product is one loop, in four stages:

1. **Design** — author tables and relationships on an interactive canvas. The canonical model is the source of truth; the canvas is one view of it.
2. **Import** — bring in what already exists: DDL dumps or live introspection. Imported schemas become navigable, connected models rather than text.
3. **Compare** — capture versions of the schema and diff them semantically: what actually changed, not which lines moved.
4. **Ship** — export migration SQL that is deterministic, reviewable, and annotated with the hazards of applying it — lock risk, expand/contract sequencing, and similar. Applying it stays your call: schemamill never writes to your database.

## What makes it different

- **Hazard-annotated output.** Migration SQL that tells you what could hurt when you run it.
- **Deterministic, reviewable artifacts.** The same model produces the same output; every artifact reviews like code.
- **Round-trip fidelity.** Import, edit, and re-export a real schema without losing meaning.
- **Postgres-native depth first.** Engine-general in shape, PostgreSQL in depth; the dialect seam leaves room for other engines later — a direction, not a promise.
- **Local-first.** Your schema is sensitive; the tool runs on your machine, and the model stays in one canonical place.

## Shape

One domain core, two faces: a CLI for automation and scripted workflows, and a local studio — canvas, navigation, diff review — for working visually. Both surfaces are first-class; how deep each reaches in v1 is scoped in Phase C.

## Direction, not promises

The canonical model and deterministic outputs are designed to be consumed by other tools and agents; an agent-facing interface (for example, an MCP server) is a plausible extension. AI features are neither promised nor forbidden — they are simply not in v1. Additional engines may follow the Postgres dialect seam once the Postgres depth is earned.

## What it is not

- Not a database client: no data browsing, no query editor — schemamill works on structure, not rows.
- Not a migration runner: it generates SQL; applying it is yours.
- Not cloud or SaaS: nothing leaves your machine.
- Never writes to your database: introspection reads only.

## Open questions

- V1 depth split between studio and CLI (deferred to Phase C scope).
