# 0002 — One canonical model is the source of truth

**Date/Status:** 2026-09-20 · accepted

**Context:** A schema tool can operate directly on DDL or SQL text, or let each feature keep its own partial picture of the schema. Both alternatives diverge: text-level operations compare lines instead of meaning, and features with separate representations produce incoherent diffs and plans. The domain docs already state "one canonical model" as a principle ([principles & refusals](../domain/principles-and-refusals.md)) and keep model and schema strictly apart ([CONTEXT.md](../../CONTEXT.md)). This ADR records the architectural consequence: every feature reads and writes the same representation.

**Decision:** A single canonical model represents a schema, and every feature — canvas, CLI, diff, migration plan, import, export — reads and writes that one representation. The model is not the schema: the schema is what really exists in PostgreSQL; the model is our representation of it. DDL text and SQL are boundary translations — import sources and rendered outputs — never a second source of truth.

**Consequences:** Every feature is rebuildable if the model is right, and untrustworthy if it drifts. Import (parsing and introspection) translates PostgreSQL's vocabulary into the model without leaking it. The model's completeness bounds what can be diffed or planned (see ADR-0003). Canvas and CLI are views over the model, not owners of it.
