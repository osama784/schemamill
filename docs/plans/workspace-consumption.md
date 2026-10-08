# Workspace consumption — `compare` and `plan` read the workspace model

**Status:** planned · **Last updated:** 2026-10-08

The workspace container shipped in [#54](https://github.com/osama784/schemamill/issues/54) (merge `ff13928`; [ADR 0010](../adr/0010-workspace-container.md)): `resolveWorkspace` walks up from a starting path to the nearest `.schemamill/` marker and reads `.schemamill/model.json` as the bare canonical model, and `schemamill init [path]` creates one — but no command consumes it yet. `compare` and `plan` still take two DDL dump paths. ADR 0010's consequences name this deferral: consuming `resolveWorkspace` from `compare`/`plan`, including the `workspace-not-found` exit-1 mapping; #54's frozen brief (§D10) lists it with the same wording, and the `[Unreleased]` changelog entry for the workspace slice ends "The first consuming command … deferred". This slice wires the first consumers.

## Goal

`schemamill compare` and `schemamill plan` accept the workspace-resolved canonical model as a baseline or target side, so a command run anywhere below a workspace root can use the committed model without naming a dump, and every resolution failure reads as one named diagnostic and exit 1.

## Scope

**In:**

- The command surface for selecting the workspace model as a side — settled by the brief (a flag, an omitted path, or both), with an explicit path never silently overridden.
- Resolution through core's `resolveWorkspace`, called from the CLI with the process cwd as the start path — never a second walk in the CLI — so the nearest marker wins and a corrupt nearest root is reported, not skipped.
- Diagnostic mapping: every `WorkspaceDiagnostic` code that can surface maps to one `schemamill: <message>` stderr line and exit 1, `workspace-not-found` included — the mapping ADR 0010 deferred to the first consuming command.
- CLI goldens: a workspace-backed scene (a temp workspace whose model is one side against a dump fixture), the not-found path, and the corrupt-root paths.

**Out, named — never silent:** writing the workspace model — importing a dump into a workspace, an `init --from`, or any other population path is a later slice; a public writer API; snapshots; studio consumption; multi-workspace selection; and file-format versioning.

**Deliberately shallow for now:** the brief settles the surface shape (flag versus omitted argument), whether both sides may resolve to workspaces, and how the display names the side; resolution semantics themselves are already decided by ADR 0010 and are not re-litigated here.

## Acceptance

- `compare` and `plan` accept a workspace-resolved model as a side, with the nearest root winning and an explicit path taking precedence; pinned by CLI tests spawning the built CLI in temp directories.
- Every workspace diagnostic that can surface maps to stderr + exit 1, `workspace-not-found` included, pinned per code.
- Existing command output is byte-identical when no workspace is involved, and help text mentions the workspace only where behavior exists.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Done means

- The CLI goldens and unit tests pin the new surface, and the workspace usage page or help wording lands where the plan's brief places it.
- The five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Populating the workspace model** — writing the model into a workspace from a dump or a live database; this slice reads the model, it never writes it.
- **A public writer API** — internal to `init` today; a consumer that writes the model needs its own design.
- **Snapshots, studio consumption, multi-workspace handling** — each its own slice per the [workspace plan](./workspace.md) §Deferred.
- **File-format versioning and the `docs/architecture.md` persistence sync** — still deferred by ADR 0010.
