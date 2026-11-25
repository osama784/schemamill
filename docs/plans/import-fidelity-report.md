# Import fidelity report — aggregate the importer's diagnostics for one DDL dump

**Status:** built · **Last updated:** 2026-11-25

**Size:** M. One brief: the aggregation and the CLI surface share one ordering rule and one vocabulary, and a split would let the document drift from the diagnostics it reports. The docs page may be written alongside the code or pinned by goldens first and written at the end of the slice; it is not a separate slice.

[`core-domain.md`](../domain/core-domain.md) (`:32`) names "import diagnostics and fidelity reports" as a custom-but-not-core capability, [`context-map.md`](../domain/context-map.md) (`:14`) places import diagnostics in the supporting presentation/projection subdomain, and [`vision.md`](../domain/vision.md) (`:26`) sets round-trip fidelity as the make-or-break bar. [`architecture.md`](../architecture.md) (`:42`, `:75`) gives that report a home at `DdlImporter` — DDL text → model plus diagnostics — without fixing its surface, behind the dialect seam ([ADR 0004](../adr/0004-postgresql-only-dialect-seam.md)). This slice is that report: a deterministic, human-reviewable aggregate of the DDL importer's skip/flag findings plus parse failures for one DDL dump, so a human can judge fidelity before accepting a model. It is distinct from the per-object diagnostics channel the importer already emits (`Diagnostic`, `packages/core/src/diagnostic.ts:45-75`, printed as stderr by `formatDiagnostics`, `packages/cli/src/diagnostics.ts:29-41`) and from the versioned JSON envelope proposed in [structured JSON](./structured-json.md), which defers SARIF, JUnit, and CI-native diagnostics to its [§Deferred](./structured-json.md#deferred). The canonicalization precedents that make a report meaningful are [ADR 0013](../adr/0013-generated-names-and-omitted-declarations-round-trip.md), [ADR 0014](../adr/0014-catalog-index-canonicalization.md), [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md), and [ADR 0028](../adr/0028-catalog-constraint-and-index-comments.md); this slice reports, it does not change any of them.

## Goal

Emit a deterministic, human-reviewable report that aggregates the DDL importer's skip/flag findings plus parse failures for one DDL dump, so a human can judge round-trip fidelity before accepting the resulting model.

## Scope

**In:**

- Aggregation of the importer's existing diagnostics for one dump into grouped, ordered report entries.
- A CLI report surface that reads a DDL dump and writes the human-readable document to stdout.
- Deterministic group order and entry order, pinned by byte-for-byte goldens.
- A docs page describing the surface, grouping, naming rule, and determinism contract.
- Golden and determinism tests.
- Two new headwords in `CONTEXT.md`: **Diagnostic** and **Report artifact**.
- A new ADR 0037, the next sequential number under [`docs/adr/README.md`](../adr/README.md).
- A `[Unreleased]` changelog entry.

**Out, named — never silent:** the structured-JSON compare/plan envelope (#176) and its diagnostics DTOs — that projection owns its own versioning and stays with [structured JSON](./structured-json.md); export DDL and JSON projections ([ADR 0023](../adr/0023-export-projects-the-model.md)); live catalog-read diagnostics (#71 and the folded #230) — a catalog read is introspection, never import ([ADR 0011](../adr/0011-introspection-transport.md)); render refusals and hazards (#102); any new import skip or flag semantics; and report formats for `init` or introspection, deferred in [structured JSON's §Deferred](./structured-json.md#deferred). Each stays with its owner; none is absorbed into this report.

**Deliberately shallow for now:** the report describes, never repairs. It offers no auto-fix, no fidelity score, no pass/fail gate, and no streaming writer for very large dumps. It reports what the importer already found; it does not decide whether the resulting model is acceptable.

## Decisions

- **D1 — A dedicated CLI surface, human-readable form.** The brief chooses between a dedicated command and a flag on an existing command; the recommendation is a dedicated command that reads one DDL dump through the same import path the other commands use (`init --from`, `compare`) and writes one deterministic human-readable document to stdout. Keeping it a separate command leaves stdout free of any other artifact and keeps the existing command goldens untouched (command wiring, `packages/cli/src/index.ts:20-28`; shared import plumbing, `packages/cli/src/run.ts`). JSON and CI-native formats are a different projection, not a second form of this document — SARIF and JUnit are explicitly deferred in [structured JSON's §Deferred](./structured-json.md#deferred). No machine-consumable output is produced in v1.

- **D2 — Import-only source for v1.** The report consumes findings produced by DDL-text import only. Catalog and introspection findings come from a different source, stay behind the other door of the seam ([ADR 0011](../adr/0011-introspection-transport.md), [`architecture.md`](../architecture.md):43), and remain with #71 and the folded #230. Following `CONTEXT.md`, a live catalog read is **Introspection** and a dump or script is **Import** — a catalog read is never called an import and never mixed into this report. A later introspection report needs its own owner and shape.

- **D3 — No envelope or version field in v1.** The first report is byte-stable and human-readable; it carries no `schemaVersion`, no tool metadata, and no machine envelope. Versioning waits for a machine consumer: [export](./export.md#deferred) defers a versioned JSON envelope, and [structured JSON](./structured-json.md) is where the integer-bump rule is settled first. Adding a version field to a human-only document would freeze formatting in a schema before any consumer needs it.

- **D4 — Reuse the importer's diagnostics channel, unchanged.** The report aggregates the existing `Diagnostic` union (`skip`, `flag`, `error`; `packages/core/src/diagnostic.ts:45-75`) — there is no parallel collection path, no new kind, no new code, and no re-derivation of a finding from the model. Every entry follows [ADR 0031](../adr/0031-exclusion-diagnostic-object-names-the-table.md)'s rule that the object names the schema-qualified owning entity and the message carries the member detail, and the related #188 diagnostic-naming contract recorded in [import long tail](./import-long-tail.md)'s Traps: a table, sequence, view, or matview names `schema.name`, a named index names `schema.index`, an unnamed index keeps its owning `schema.table`, a constraint names `schema.table`, with extensions and whole-object `COMMENT ON` targets as the named exceptions. Skip and flag semantics do not change; [ADR 0030](../adr/0030-constraint-backed-index-comments-are-flagged.md)'s "flagged, not carried" precedent stands, and the report presents that flag rather than relitigating it.

- **D5 — Determinism by construction.** Entries are grouped by family and reason, then ordered by source order of the dump within each group; the grouping is fixed and the within-group order is the importer's own dump order. No timestamps, absolute paths, resolved workspace roots, random IDs, environment reads, or locale-dependent sorting enter the document. The docs carry no literal test, scene, or skip counts: [docs-counts.md](../docs-counts.md) scans all Markdown under `docs/` recursively, plus the root docs files, and a literal count claim fails `pnpm test`. Goldens pin the bytes so a second run on the same dump, or the same dump at a different path, is identical.

- **D6 — Vocabulary comes from `CONTEXT.md`, not from synonyms.** Per `AGENTS.md`, this slice adds **Diagnostic** and **Report artifact** as headwords in `CONTEXT.md` rather than coining a term in code first. **Import**, **DDL dump**, **Round-trip fidelity**, **Model**, **Schema**, and **Export** are used exactly as `CONTEXT.md` defines them: fidelity is never called accuracy or completeness, a **Schema** is never called a model and vice versa, and a live catalog read is never called an import. The report's docs page and the ADR use the same words.

## Acceptance

- A dump exercising the long-tail families produces a report that groups every skip and flag by family and reason, names each finding's owning object by the #188/[ADR 0031](../adr/0031-exclusion-diagnostic-object-names-the-table.md) rule, and preserves dump order within each group; no finding the importer emits is omitted or renamed.
- The report's findings are exactly the importer's findings for the same dump — same kinds, same codes, same messages, same objects — proving the aggregation adds no second collection path.
- A parse failure appears as a diagnostic in the report and is never presented as a clean report; the command's exit behavior follows the CLI's existing error handling.
- Two runs over the same dump produce byte-identical stdout, and copying the dump to another path does not change the bytes; goldens pin the document and a determinism test reruns and compares it.
- `CONTEXT.md` carries the **Diagnostic** and **Report artifact** headwords, and the docs page documents the surface, grouping, object naming, and determinism contract without literal test, scene, or skip counts.
- The five gates and `pnpm docs:counts --check` are green; ADR 0037, this plan, a `[Unreleased]` changelog entry, and the tracker issue land with the slice.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.
- Evidence: report goldens pin the document for a dump covering the named diagnostic families, a determinism test proves repeat-run and path-independence byte equality, and a test proves the aggregated entries match the importer's diagnostics one-for-one; `pnpm docs:counts --check` and the docs link check are green.
- The plan, ADR 0037, the report docs page, the two `CONTEXT.md` headwords, the changelog entry, and the tracker issue carry the ship note.

## Deferred

Named for the slices that own them, never silent:

- **Machine-readable report projections (SARIF, JUnit, CI-native)** — a different projection with its own versioning and no consumer yet; owned by the next slice out of [structured JSON's §Deferred](./structured-json.md#deferred), not by this human document.
- **Introspection diagnostics parity** — #71; catalog-read findings stay with the introspection owner and the folded #230, behind [ADR 0011](../adr/0011-introspection-transport.md).
- **A report for `export` envelopes** — deferred in [export](./export.md#deferred); export stays the bare canonical model ([ADR 0023](../adr/0023-export-projects-the-model.md)), and this slice neither wraps nor versions it.
- **Streaming very large dumps** — own slice; an in-memory aggregation is enough until a real large-dump consumer exists.
- **Fidelity scoring and a pass/fail gate** — own slice; v1 describes findings and never scores or judges them.

## Non-goals

- Changing import, diff, or skip/flag semantics.
- Applying migrations or reading a live catalog.
- Workspace snapshots or merging findings across multiple dumps.
- Re-litigating [ADR 0004](../adr/0004-postgresql-only-dialect-seam.md), [ADR 0011](../adr/0011-introspection-transport.md), [ADR 0016](../adr/0016-catalog-constraint-canonicalization.md), [ADR 0030](../adr/0030-constraint-backed-index-comments-are-flagged.md), or [ADR 0031](../adr/0031-exclusion-diagnostic-object-names-the-table.md).
- A machine-readable or versioned report document in v1.
