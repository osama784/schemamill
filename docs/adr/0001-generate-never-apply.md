# 0001 — Generate, never apply

**Date/Status:** 2026-09-20 · accepted

**Context:** Tools in this space are typically migration runners: they connect to a database with write credentials and execute DDL on the user's behalf. Execution is where the risk concentrates — locks, rewrites, downtime — and it requires handing the tool write access to a live database. schemamill's documented refusals ([principles & refusals](../domain/principles-and-refusals.md)) state "Not a migration runner" and "Never writes to your database". Generating instead of applying is also what makes deterministic review and local-first operation possible: the artifact can be inspected before anything happens, and producing it needs no write access. A decision was needed because a database tool is normally expected to execute what it generates.

**Decision:** schemamill generates migration SQL; it never applies changes and never writes to a database. Introspection is read-only, always. The user reviews the generated SQL and carries every change across the boundary — the user owns the change.

**Consequences:** No write-privileged database credentials are needed anywhere in the product. Because schemamill will not act, it must communicate what could hurt when the SQL is applied: hazard annotations carry that weight. It cannot verify that what the user applied matches the plan. Any future feature requiring database writes contradicts this ADR.
