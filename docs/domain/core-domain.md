# Core Domain & Highlighted Core

**Status:** drafted 2026-09-19 · living document

*Distilled against the [Domain Vision Statement](./vision.md) — the vision decides what belongs in the core.*

## The core

The core is what earns the deepest investment: the parts that carry the promise — making schema change safe and reviewable. Everything else either supports them or can be borrowed.

**Domain core** (framework-free, shared by every surface):

- **Canonical model** — the one representation of a schema that every feature reads and writes. If it is right, everything else can be rebuilt; if it drifts, nothing else can be trusted.
- **Import & introspection** — DDL dumps and live catalog reads, with round-trip fidelity high enough that real schemas come back whole. This is the make-or-break gate: without it, nothing downstream means anything.
- **Change engine** — semantic diff (what actually changed) and migration planning (the SQL to get from a baseline to a target).

**Core surface:**

- **The canvas studio** — the primary interface where users meet the model, edit it, and watch change happen. First-class, not a thin viewer over the engine.
- **The CLI** — the same loop for automation and scripted workflows; also the cheapest place to exercise the engine.

## Highlighted core

The change engine reached through the canvas, with the hazard-annotated plan as its crown jewel. This is where the craft concentrates: given a baseline and a target, produce migration SQL that is deterministic, reviewable, and annotated with what could hurt when it runs. The workflow to perfect is the full loop — import or design → compare → plan → review.

## Core is a seat, not a badge

Different users will call different parts "the core of it": the modeler lives on the canvas, the release engineer lives in the plan, the automation user lives in the CLI. That perception is real and worth designing for, but it does not move the investment: the domain core above is the single engine every seat depends on.

## Pointers — not detailed here

- **Custom, but not core:** migration SQL rendering, export projections (DDL, markdown, JSON), import diagnostics and fidelity reports.
- **Borrow freely:** CLI and server plumbing, packaging, PostgreSQL parsing and catalog tooling where proven — the semantics stay ours, the mechanics do not have to be.
- **Not core, and not before the core loop stands:** data-level features (rows, querying), applying migrations, multi-engine abstraction, ORM coupling, AI features in v1, cosmetic polish as a differentiator.

## Hard problems (hot spots)

1. **Import fidelity long tail** — real dumps carry extensions, exotic objects, and dialect corners; covering the long tail is the gate everything else waits behind.
2. **Hazard model** — which operations rewrite or lock what, under which version, and how expand/contract sequencing avoids downtime.
3. **Object identity in diff** — deciding when two things across a baseline and a target are the same object (renames, moves, retypes) before judging what changed.
4. **Change ordering & atomicity** — dependency order (types, tables, foreign keys, indexes), what must be split into steps, and what cannot run inside one transaction.
5. **Version-aware semantics** — catalog shape, DDL support, and lock behavior differ across PostgreSQL majors; live work detects the server version, offline work states a target, and generation and hazard analysis answer for that version.
