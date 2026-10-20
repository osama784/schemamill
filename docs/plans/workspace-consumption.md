# Workspace consumption — `compare` and `plan` read the workspace model

**Status:** built · **Last updated:** 2026-10-16

`compare` and `plan` now consume the workspace model: run anywhere below a workspace root, a command takes one dump path and the workspace fills the side no path names — a lone path is the target and the workspace fills the baseline, `--baseline-workspace` states that explicitly, and `--target-workspace` reverses the direction. The workspace container shipped in [#54](https://github.com/osama784/schemamill/issues/54) (merge `ff13928`; [ADR 0010](../adr/0010-workspace-container.md)): `resolveWorkspace` walks up from a starting path to the nearest `.schemamill/` marker and reads `.schemamill/model.json` as the bare canonical model, and `schemamill init [path]` creates one. This slice wires the first consumers; it shipped in [#78](https://github.com/osama784/schemamill/issues/78), whose ledger carries the frozen brief, the adversarial partner pass, and the evidence. That closes ADR 0010's deferral — consuming `resolveWorkspace` from `compare`/`plan`, including the `workspace-not-found` exit-1 mapping — and no new ADR was needed: the accepted one is immutable.

## Goal

`schemamill compare` and `schemamill plan` accept the workspace-resolved canonical model as a baseline or target side, so a command run anywhere below a workspace root can use the committed model without naming a dump, and every resolution failure reads as one named diagnostic and exit 1.

## Scope

**In — shipped:**

- The command surface: `[baseline] [target]` are optional positionals beside `--baseline-workspace` and `--target-workspace`, with the side rules below; an explicit path is never silently overridden.
- Resolution through core's `resolveWorkspace`, called from the CLI with the process cwd as the start path — never a second walk in the CLI — so the nearest marker wins and a corrupt nearest root is reported, not skipped.
- Diagnostic mapping: every `WorkspaceDiagnostic` code that can surface maps to one `schemamill: <message>` stderr line and exit 1, `workspace-not-found` included — the mapping ADR 0010 deferred to the first consuming command.
- CLI pins: spawn tests for the one-path runs (stdout byte-equal to the equivalent two-dump pair), the not-found path, and the six surfacing codes; usage errors and `--help` bytes pinned beside them.

**Out, named — never silent:** writing the workspace model — importing a dump into a workspace, an `init --from`, or any other population path is a later slice; a public writer API; snapshots; studio consumption; multi-workspace selection; and file-format versioning. Dump-only population is scheduled in [workspace-population.md](./workspace-population.md); live-database population remains deferred.

**Deliberately shallow for now:** resolution semantics themselves are ADR 0010's and are not re-litigated here; the surface answers the brief's three questions narrowly — the flag set above, at most one workspace side per invocation, and no side names in any output, so a workspace-backed run's stdout is byte-identical to the equivalent dump-backed run.

## Settled surface

**The side rules**, settled by the slice brief and evaluated in order R5 → R6 → R7 → R1–R4; every combination of paths and flags maps to exactly one rule:

- R1. Two paths and no flags: today's two-dump behavior, byte-identical.
- R2. One path and no flags: the path is the target, and the baseline resolves from the workspace. Commander fills the lone positional as `baseline`, so `mapSides` reassigns it.
- R3. One path with `--baseline-workspace` is R2's explicit form.
- R4. One path with `--target-workspace`: the path is the baseline, and the target resolves from the workspace.
- R5. Both flags, any path count: usage error `error: --baseline-workspace and --target-workspace cannot be combined`.
- R6. One flag with two paths: usage error `error: --baseline-workspace cannot be combined with two paths`, resp. `--target-workspace` — the flag would be unused, refused, never silently ignored.
- R7. Zero paths, with or without one flag: usage error `error: name at least one dump path (the workspace can fill the other side)` — no dump side, and with zero paths both sides would resolve from the same cwd to the same model.
- R8. A side resolves only when it has no path: the workspace side is `resolveWorkspace(process.cwd())` — the CLI never re-walks — so the nearest marker wins and a corrupt nearest root is reported, not skipped. At most one side resolves per invocation.
- R9. Sides are processed baseline → target, each resolved-or-read before the next; the first failure is the only report.

Usage errors are validated before any filesystem access and emitted through commander's error machinery in the pinned shape: the `error: …` message on stderr, exit 1, empty stdout.

**The failure mapping.** Six of the ten `WorkspaceDiagnostic` codes can surface (`workspace-target-not-directory`, `workspace-already-exists`, `workspace-inside-workspace`, and `workspace-io` are `init`-only). Each prints exactly one `schemamill: <message>` line on stderr — core's diagnostic verbatim — and exits 1 with empty stdout: the failure precedes any output, even when an import could otherwise have proceeded. The six, with the construction each pin uses:

- `workspace-not-found` — no marker up to the filesystem root; the message names the start path.
- `workspace-marker-invalid` — `.schemamill` exists but is not a directory (a regular file pins it).
- `workspace-inaccessible` — the marker cannot be inspected; a self-referential `.schemamill` symlink (ELOOP) pins it.
- `workspace-model-missing` — the marker directory holds no `model.json`.
- `workspace-model-unreadable` — `model.json` exists but cannot be read; a directory in its place (EISDIR) pins it.
- `workspace-model-invalid` — the model file does not parse or validate as a model; corrupt JSON and an unknown field each pin it.

The nearest marker always wins — a corrupt inner marker is reported, never skipped for a healthy outer workspace — and the first failure is the only report.

## Acceptance

- `compare` and `plan` accept a workspace-resolved model as a side, with the nearest root winning and an explicit path taking precedence; pinned by CLI tests spawning the built CLI in temp directories.
- Every workspace diagnostic that can surface maps to stderr + exit 1, `workspace-not-found` included, pinned per code.
- Existing command output is byte-identical when no workspace is involved, and help text mentions the workspace only where behavior exists.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- The CLI tests pin the new surface and the help wording landed with it; a workspace usage-docs page stays deferred.
- The five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Populating the workspace model** — writing the model into a workspace from a dump or a live database (an `init --from`, or any other population path); this slice reads the model, it never writes it. Dump-only population is scheduled in [workspace-population.md](./workspace-population.md); live-database population remains deferred.
- **A public writer API** — internal to `init` today; a consumer that writes the model needs its own design.
- **Snapshots, studio consumption, multi-workspace handling** — each its own slice per the [workspace plan](./workspace.md) §Deferred.
- **File-format versioning and the `docs/architecture.md` persistence sync** — still deferred by ADR 0010.
- **A workspace usage-docs page, Windows path edge cases, and `init`'s EACCES refinement** — each still deferred by [ADR 0010](../adr/0010-workspace-container.md).
