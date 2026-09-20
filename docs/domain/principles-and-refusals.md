# Principles & Refusals

**Status:** drafted 2026-09-20 · living document

The [vision](./vision.md) says what schemamill is for; this page says what it stands on, and what it will not become. Refusals come in two kinds: **constitutional** — never, by identity — and **v1-scoped** — deliberately deferred, revisited only on purpose.

## Principles

**Postgres-native depth.** Engine-general in shape, PostgreSQL in depth. Depth first, breadth later: other engines earn their way in through the dialect seam, not ahead of it.

**Local-first.** A schema is sensitive; the tool runs on your machine, and nothing leaves it.

**Deterministic, reviewable output.** The same model produces the same artifacts, and every artifact reviews like code.

**One canonical model.** One representation of a schema that every feature reads and writes — canvas, CLI, diff, plan. Views may come and go; the model wins.

**Fidelity first.** A real schema must survive the round trip before anything else matters. Import fidelity is the gate the rest of the product queues behind.

**Docs-as-code.** Decisions, language, and design live as versioned documents — these pages, the glossary, the ADRs — not in heads or chat logs.

## Refusals — constitutional

**Not a database client.** No data browsing, no query editor; schemamill works on structure, never rows.

**Not a migration runner.** It generates the SQL; applying it is the user's job — the user owns the change.

**Never writes to your database.** Introspection reads only; no DDL execution, no mutation, ever.

**Not cloud or SaaS.** No hosted service, no accounts, no uploads. Local by construction.

## Refusals — v1-scoped

**No ORM coupling.** Schemas are modeled as themselves — no ORM schemas, runtime libraries, or framework integration.

**No AI features in v1.** Neither promised nor forbidden; simply not in v1.

**No multi-DB in v1.** PostgreSQL only, with the dialect seam held open — a direction, not a promise.
