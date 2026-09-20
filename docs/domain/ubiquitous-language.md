# Ubiquitous Language

**Status:** drafted 2026-09-20 · living document

The definitions live in the root [CONTEXT.md](../../CONTEXT.md) — that is the normative glossary. This page curates it: the clusters the language falls into, and why each contested word was resolved the way it was.

## Term clusters

- **The model layer** — model, schema, table, column, relationship, foreign key, snapshot, baseline, target, diff, data.
- **Crossing the boundary** — import, introspection, DDL dump, apply.
- **The change engine** — migration plan, migration SQL, hazard, expand/contract, round-trip fidelity.
- **The product's shape** — safe-change loop, studio, canvas, workspace, and the two faces: studio for working visually, CLI for automation.

## Resolved conflicts

- **snapshot over version / state.** "Version" already means software releases and PostgreSQL server versions; "state" collides with UI state and doesn't say frozen. A snapshot is a point-in-time copy you can return to.
- **relationship over connection.** In database tools, "connection" means a session to the server — connection strings, pools, errors. The table-to-table noun is a relationship; "connect" survives as a UI verb.
- **migration plan + migration SQL over migration / changeset.** One artifact, two layers: the plan carries the analysis and hazards; the SQL is its reviewable rendering. "Changeset" belongs to other tools; bare "migration" is shorthand, not a term.
- **column over field.** PostgreSQL says column, the canvas says column; "field" would drift.
- **model vs schema, never conflated.** The schema is the real thing in a database; the model is our representation. One canonical model only means something if these stay apart.
- **import vs introspection, kept distinct.** Text in, or live catalog read? Different risks, different fidelity questions; the two words keep them apart.
- **PostgreSQL in definitions, "Postgres" in prose, never "PG".** The formal name is PostgreSQL; the short form is fine in flowing text.
- **workspace over project / folder.** "Project" is claimed by other tools and by everyday speech for many things; "folder" names storage, not the role. A workspace is the container that organizes a user's work on disk — the unit the studio and the CLI work within. Definition in [CONTEXT.md](../../CONTEXT.md).
