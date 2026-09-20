# 0006 — Local-first: nothing leaves the machine

**Date/Status:** 2026-09-20 · accepted

**Context:** A schema is sensitive. The domain docs state that the tool runs on the user's machine and nothing leaves it, and refuse cloud or SaaS ([principles & refusals](../domain/principles-and-refusals.md), [vision](../domain/vision.md)). Those refusals cover a hosted service, accounts, and uploads, but are silent on telemetry and offline operation. This ADR records the full extent of the promise so that later conveniences — analytics, accounts, sync — cannot erode it by accident.

**Decision:** schemamill runs on the user's machine. No hosted service, no accounts, no uploads, no telemetry. Core functions work with no internet connection; the studio's localhost server is part of the local product, not a service. The model and its snapshots stay local by construction.

**Consequences:** No collaboration, sync, or sharing features, and no account system to build. No field telemetry: diagnostics rely on user reports and reproducible local artifacts. Packaging and updates must be self-contained and work offline. A hosted component would contradict this ADR.
