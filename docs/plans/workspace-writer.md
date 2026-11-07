# Workspace writer — model persistence writes atomically

**Status:** built · **Last updated:** 2026-10-28

`writeWorkspaceModel` writes a `Model` into an existing workspace's `.schemamill/model.json`, atomically, through the same resolution walk `compare` and `plan` use. It shipped in [#120](https://github.com/osama784/schemamill/issues/120) as the public seam snapshots ([#81](https://github.com/osama784/schemamill/issues/81)) and the studio ([#83](https://github.com/osama784/schemamill/issues/83)) consume; the durable decision is [ADR 0020](../adr/0020-model-persistence-writes-atomically.md). `init` and `init --from` write through the same private helper, so their bytes and messages are unchanged.

## Goal

A consumer holding a `Model` and a path inside an existing workspace can persist it without owning a serializer, a temp-file protocol, or a diagnostic mapping, and a failed write leaves the previous model intact.

## Decisions

- **D1 — API and result.** `writeWorkspaceModel(startPath, model): Promise<WorkspaceWriteResult>`, value-exported from core; the union mirrors `WorkspaceInitResult` and carries the resolved root. ADR 0020 records why the name and union are the public contract.
- **D2 — Shared walk, not the model read.** `findWorkspaceRoot` is the extracted lexical walk behind `resolveWorkspace`; the writer uses it alone, so a corrupt or missing model is repaired instead of blocking the write, and a non-workspace fails `workspace-not-found` without creating anything.
- **D3 — Temp file plus rename.** `serializeModel` bytes go to a uniquely named temp in `.schemamill/` and are renamed over `model.json`, so a failed write preserves the previous file and cleans the temp; the write is unconditional, with no merge policy, locking, or format versioning.
- **D4 — One helper shared with `init`.** `initWorkspace` and `writeWorkspaceModel` call the same private `writeModelFile`; `init` keeps its marker-removal cleanup, and its output stays byte-identical.
- **D5 — `workspace-io` reused.** Temp-write and rename failures return the existing code with the existing `cannot write <path>: <reason>` message; the walk reuses the three resolution codes and no code was added.

[ADR 0020](../adr/0020-model-persistence-writes-atomically.md) carries the full rationale, alternatives, permission-mode consequence, and residuals.

**Vocabulary audit.** `CONTEXT.md` gained no entry: a writer is an API, not domain vocabulary. The workspace, the model, and persistence are already defined there, and naming a function in the vocabulary law would put an implementation seam where the domain belongs. No existing term was wrong or missing for this slice.

## Slice

Three workstreams on one branch, one PR, one tracker issue ([#120](https://github.com/osama784/schemamill/issues/120)); the commits are the record:

- **W1 — Core writer and tests** (`feat(core): write models into existing workspaces atomically`): the walk extraction, `writeWorkspaceModel`, `WorkspaceWriteResult`, the shared helper, the `index.ts` value export, and the writer tests in `packages/core/src/workspace.test.ts`. Existing resolution and init tests are untouched.
- **W2 — Docs** (`docs: record the workspace writer`): ADR 0020, this plan, and the retrofits in `workspace-population.md` and `workspace-consumption.md` that retire the "public writer deferred" claims.
- **W3 — Evidence**: the scoped mutation run and its triage, recorded on the tracker issue; a kill-test commit only if a survivor needs one.

## Verification

**Test matrix.** `packages/core/src/workspace.test.ts` pins the contract: a successful write emits exactly `serializeModel(model)` and round-trips through `resolveWorkspace`; an overwrite replaces the previous bytes and leaves no `*.tmp` in `.schemamill/`; the hard-link test links the old `model.json` to a sibling, writes a new model, and asserts the sibling keeps the old bytes — the discriminator between temp-plus-rename and an in-place `writeFile`; a nested start path resolves to the workspace root; a non-workspace directory fails `workspace-not-found` and creates no marker, directory, or temp; a corrupt model and a marker without a model are both repaired and then read back through `resolveWorkspace`; a temp-create failure returns `workspace-io` with the `cannot write <modelPath>: ` prefix, the previous bytes intact, and no temp left; a rename failure (a directory at `model.json`) returns `workspace-io`, cleans the temp, and leaves the destination entry untouched; and the writer is imported from `./index.ts`, so the public re-export is exercised at runtime and by typecheck.

**Gates.** `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass on the final tree; CI re-runs them on Node 24 and 26. The slice is core-only: no live-PG run, no scene or golden change.

**Changelog.** No `[Unreleased]` entry is deliberate: the package is private, the writer has no CLI surface and changes no output, and the issue's acceptance says an entry is warranted only when CLI output changes. The omission is recorded in the ship note rather than left to inference.

## Deferred

Named for the slices that own them, never silent:

- **fsync and durability** — a successful write survives a process crash but not necessarily a machine crash.
- **Crash-time temp cleanup** — a crash between the temp write and the rename can leave a `*.tmp` in `.schemamill/`; no cleanup policy ships here.
- **Windows rename-over-existing behavior** — unverified; the repo already defers Windows path edges.
- **Permission-mode preservation** — the rename installs the temp inode, so a restrictive or read-only `model.json` is replaced and its mode is dropped; overwrite policy owns the fix.
- **Overwrite/merge policy** — the writer replaces unconditionally; a merge needs an overlap policy the model does not have.
- **Locking and concurrency** — unique temp names prevent collisions, but concurrent writers are last-wins.
- **A stable format contract and versioning** ([#54](https://github.com/osama784/schemamill/issues/54)) — the writer emits the bare canonical model; an envelope waits for the format decision.
- **Snapshots** ([#81](https://github.com/osama784/schemamill/issues/81)) and **studio consumption** ([#83](https://github.com/osama784/schemamill/issues/83)) — the consumers this seam exists for; each its own slice.
- **A CLI write surface** — no command updates an existing workspace's model; `init --from` still refuses one.
