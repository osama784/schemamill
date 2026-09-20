# 0003 — Changes are snapshot diffs, not an accumulated migration history

**Date/Status:** 2026-09-20 · proposed

**Context:** The dominant model in this space treats accumulated migration files as the record and a database's shape as the sum of its history. That brings ordering, drift, and bookkeeping problems: the files become a second source of truth, and what actually changed is buried in line-level noise. schemamill's promise is semantic comparison — "what actually changed, not which lines moved" ([vision](../domain/vision.md)). A decision was needed on what records a change and how migration SQL is derived.

**Decision:** Snapshots are first-class: capture, name, list, compare. A comparison is between a baseline and a target — roles assigned per comparison, not fixed properties; the target is usually the live model. A change is computed by diffing: diff → migration plan (ordered changes, hazard annotations) → migration SQL (deterministic rendering). Migration SQL is derived per comparison and regenerable — if every generated migration SQL file were lost, the snapshots would reproduce them. DDL and migration files enter only through import, as DDL text. schemamill does not own, track, or maintain an applied-migration history.

**Consequences:** Comparisons are not limited to consecutive snapshots: an older snapshot compared directly to the live model yields one migration SQL covering all changes since. schemamill has no knowledge of what the user actually applied — reality is observed read-only through introspection, and keeping the model true to the database is the user's discipline. Anything the model cannot represent cannot be diffed or planned — structure only, never data. Determinism makes regeneration trustworthy.
