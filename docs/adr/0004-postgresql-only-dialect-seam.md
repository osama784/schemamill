# 0004 — PostgreSQL only in v1, behind a dialect seam

**Date/Status:** 2026-09-20 · proposed

**Context:** Tooling in this space commonly goes broad and shallow, covering many engines at the expense of any one. Here the fidelity gate is the long tail of real PostgreSQL dumps — extensions, exotic objects, dialect corners — and version-aware semantics already differ across PostgreSQL majors in catalog shape, DDL support, and lock behavior. The domain docs record "no multi-DB in v1" and "engine-general in shape, PostgreSQL in depth" ([principles & refusals](../domain/principles-and-refusals.md), [vision](../domain/vision.md)). This ADR records the v1 scope and how future engines are expected to enter.

**Decision:** v1 supports PostgreSQL only. The architecture keeps a dialect seam open: PostgreSQL's vocabulary and semantics are translated at the boundary and nothing Postgres-specific leaks into the canonical model. Additional engines are a direction, not a promise, and earn their way in through the seam once PostgreSQL depth is earned. The seam's mechanics are deliberately not specified here.

**Consequences:** Every feature can assume PostgreSQL semantics in v1, and fidelity work concentrates on one engine. The seam must stay open without becoming premature abstraction. Adding an engine later is translation and semantics work behind the seam, not a rewrite; the shape stays engine-general because the model never assumes PostgreSQL.
