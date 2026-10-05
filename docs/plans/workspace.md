# Workspace container on disk — layout and root resolution

**Status:** planned (design-first) · **Last updated:** 2026-10-05

The workspace is the container that organizes a user's work on disk — "the unit the studio and the CLI work within" ([CONTEXT.md §Workspace](../../CONTEXT.md)). Today nothing on disk belongs to schemamill: every CLI invocation reads two DDL dumps by path (`schemamill compare <baseline> <target>`, `schemamill plan <baseline> <target>`) and persists no model. This slice defines and builds the container itself — the workspace directory layout, root resolution, and an `init` that creates one — so the CLI can locate a workspace's canonical model from anywhere below its root, and the later studio can reuse the same layout instead of inventing a second one. It is deliberately design-first: the layout decisions (root marker, file set, naming, model file shape) deserve a short brief and likely an ADR before implementation.

## Goal

A model lives in exactly one place on disk inside a workspace root; any command run below that root finds it without being told the path, and `init` creates a well-formed workspace that refuses to overwrite one that already exists.

## Scope

**In:**

- The workspace directory layout: the root marker that identifies a workspace, the files it holds at the root, and how a workspace directory is distinguished from an arbitrary one.
- Root resolution: an explicit path where the caller gives one, else walk up from the current working directory to the nearest workspace root; a named diagnostic and non-zero exit when none is found.
- `init`: create a workspace at a given path; refuse to half-overwrite or silently merge into an existing workspace.
- The minimal read/write surface the CLI needs to load the model from a resolved root; the model's on-disk representation is settled by this slice's brief and stays governed by [ADR 0002](../adr/0002-canonical-model.md)'s one-canonical-model rule.
- Package placement: layout and resolution logic sits framework-free (the later studio and the CLI both consume it); CLI wording stays in `@schemamill/cli`.

**Out, named — never silent:** command surfaces that consume the workspace beyond locating the model (no import/diff/plan rewiring beyond what finding the model requires), lock files, and file-format versioning or migrations.

**Deliberately shallow for now:** the brief settles the marker name and format, the model serialization shape, behavior on a corrupt or empty root, and whether resolution crosses filesystem boundaries. These are exactly the decisions that make this slice design-first; any structural one that survives review lands as an ADR under `docs/adr/`.

## Design notes

- Local-first ([ADR 0006](../adr/0006-local-first.md)): a workspace is a plain directory the user owns; no hidden global state outside it.
- Vocabulary is law: "workspace" is the only term; no project/folder synonyms (CONTEXT.md §Workspace).
- A resolved root is validated before use — a directory that matches the marker but carries no readable model reports which piece is missing, never a downstream parse failure.

## Done means

- A workspace can be created with `init`, found from a nested working directory, and its model read back; unit tests pin resolution, `init` refusal, the not-found path, and the corrupt-root path.
- CLI help and docs mention the workspace only where behavior actually exists.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Snapshots** — capturing, naming, listing, and comparing frozen model copies inside a workspace; its own slice and a separate stage of the safe-change loop.
- **Studio consumption** — the server and canvas reading and writing the workspace layout; owns any additional structure the studio needs beyond the container itself.
- **Multi-workspace handling** — selecting among several workspaces, a global workspace index, or cross-workspace operations.
- **Persistence beyond the container** — migration history, apply logs, caches, and lock files; the workspace holds the model, not a product database.
- **Workspace file-format versioning** — migrating older workspace files forward; addressed when a format actually changes.
