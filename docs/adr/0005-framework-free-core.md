# 0005 — Framework-free core, NestJS at the server edge

**Date/Status:** 2026-09-20 · proposed

**Context:** The domain docs state that the core is framework-free and shared by every surface ([core domain](../domain/core-domain.md)). This ADR records the concrete stack boundary that follows. The core carries the semantics, and framework coupling there would tie the engine to one surface and to a framework's upgrade cycle; the CLI also exists to exercise the engine cheaply, which requires the engine to run without a server. The boundary is a deliberate shape, not an incidental arrangement.

**Decision:** The domain core is plain TypeScript, framework-free, shared by every surface. NestJS is used only for the studio's local server. The CLI is a thin plain-TypeScript surface over the same core. No decorators, dependency injection, or framework types below the server boundary.

**Consequences:** The core is testable and runnable without a framework, and wiring stays explicit at the edges. The codebase carries two idioms — plain core, NestJS server — so the boundary must be enforced. The studio's server framework can change without touching the core.
