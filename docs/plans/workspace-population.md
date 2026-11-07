# Workspace population — `init --from` imports a DDL dump

**Status:** built · **Last updated:** 2026-10-22

Plain `schemamill init [path]` creates a workspace and writes the canonical model's exact empty bytes to `.schemamill/model.json` ([ADR 0010](../adr/0010-workspace-container.md); `initWorkspace` in [`packages/core/src/workspace.ts`](../../packages/core/src/workspace.ts)), and `compare`/`plan` read that model as a side ([workspace consumption](./workspace-consumption.md), [#78](https://github.com/osama784/schemamill/issues/78)). The workspace now has its first inbound path: `schemamill init [path] --from <dump|->` reads a DDL dump through the existing `importDump` and writes the resulting canonical model into the workspace, so `compare` and `plan` work on a workspace the user did not hand-edit. It shipped in [#113](https://github.com/osama784/schemamill/issues/113) as the dump-only tracer bullet named as deferred by [workspace-consumption.md §Deferred](./workspace-consumption.md) and [#78](https://github.com/osama784/schemamill/issues/78)'s out-of-scope. The writer stayed internal for that slice — `init` alone wrote the model at creation — and the public writer landed in [#120](https://github.com/osama784/schemamill/issues/120) ([workspace-writer.md](./workspace-writer.md)); the marker stays tool-managed ([`packages/core/src/workspace.ts`](../../packages/core/src/workspace.ts)); "Population" is the slice name inherited from those plans, while the operation is an **Import** in [CONTEXT.md §Import](../../CONTEXT.md). Live-database population, snapshots, studio, multi-workspace, and migration history stay deferred (§[Deferred](#deferred)).

## Goal

One command creates a workspace whose `.schemamill/model.json` is the canonical model imported from a DDL dump, so `compare` and `plan` run on a workspace the user did not hand-edit, with every import diagnostic on stderr and no workspace written when the import cannot be trusted.

## Scope

**In:**

- `schemamill init [path] --from <dump|->` on the existing `init` command: the same target path, workspace creation, refusals, and success line; the only new behavior is the imported model instead of the empty one.
- Writing the imported model through core's writer at creation time — no CLI-side JSON, no second serializer, no new parser: the CLI reads the dump, calls `importDump` (`packages/postgres/src/import.ts`), and passes the returned `Model` to `initWorkspace`.
- Dump input from a file path or `-` for stdin; a read failure, thrown import, or import `error` diagnostic prints on stderr and exits 1 with no workspace created.
- Import diagnostics on stderr under the existing skip/flag/error vocabulary: a counts line whenever there are findings, per-finding lines for errors, and per-finding lines for skip/flag under `--verbose`; skip/flag-only imports still create the workspace and exit 0.
- The existing-workspace refusal: never overwrite, never merge, never rewrite an existing model; the repair hint stays the only path.
- Tests: core unit pins for the import seam, CLI spawn pins for file/stdin/diagnostics/refusal, and an end-to-end assertion that a workspace created by `init --from` produces byte-identical `compare`/`plan` output to the equivalent two-dump run. Existing compare/plan goldens stay untouched.
- Docs: a `[Unreleased]` changelog entry; this plan is built; the workspace-consumption plan's population item records dump-only population as shipped, with live-database population still deferred.

**Out, named — never silent:**

- Live-database population (`--from-url`) — it is Introspection, not Import, and needs the `catalogReader` seam, connection/transport failure handling, and live-PG evidence ([ADR 0011](../adr/0011-introspection-transport.md)); a later slice.
- A public writer API — **shipped in [#120](https://github.com/osama784/schemamill/issues/120)** ([workspace-writer.md](./workspace-writer.md)): `writeWorkspaceModel` replaces an existing workspace's model atomically. Overwrite/merge policy, locking, and a stable format contract remain deferred; this slice only writes the imported model at creation.
- Snapshots, studio consumption, multi-workspace handling, and migration history — each its own slice per the [workspace plan](./workspace.md) §Deferred.
- A workspace usage-docs page, file-format versioning, Windows path edge cases, and `init`'s EACCES refinement — still deferred by [ADR 0010](../adr/0010-workspace-container.md).

**Deliberately shallow for now:** import behavior, the model shape, the diagnostic vocabulary, and resolution semantics are unchanged and not re-litigated. No new object families, no provenance in `.schemamill/`, no version envelope, no new ADR: this is an import surface over the decisions ADR 0010 already records.

## Decisions

**D1 — The surface is `init [path] --from <dump|->`; plain `init` is unchanged.**

Before this slice, `init` had one optional positional, `[path]` (default `.`), and no options: its action called `initWorkspace(resolve(path))` and printed `Initialized workspace at <absolute path>` ([`packages/cli/src/init.ts`](../../packages/cli/src/init.ts)). It already creates the workspace, claims the marker, refuses an existing one, refuses nesting, and cleans up a failed model write (ADR 0010). The import path belongs on that command: a separate `import` command would have to create-or-write, duplicate the marker/refusal/cleanup logic, and answer what it means when the workspace exists. `--from <dump>` composes as an additive option: the target path semantics, the refusals, and the success line are the existing ones; only the model bytes differ. `-` is special only as the `--from` value, never as the target path. `--from` without a value is Commander's usage error (exit 1, no filesystem access). `--verbose` is added to `init` for the import diagnostics (D4).

**D2 — An existing workspace is refused; never overwritten or merged.**

`initWorkspace` refuses any existing `.schemamill` entry — file or directory — with `workspace-already-exists` and the documented repair hint `remove <target>/.schemamill to re-create it`, and refuses a target inside an existing workspace with `workspace-inside-workspace` ([`packages/core/src/workspace.ts`](../../packages/core/src/workspace.ts); ADR 0010). Keep both refusals verbatim. The model is the user's source of truth and is meant to be committed; overwriting it would destroy reviewable changes, and merging has no overlap policy — a schema is not a set of independent facts, so a silent union or last-writer-wins is exactly the wrong default. `init --from` on a workspace that already has a model — including the empty model a plain `init` left — exits 1 with empty stdout, leaves the model bytes untouched, and prints the existing repair hint. That repair is destructive (it removes the committed model), so a user replacing the model by hand should commit or back up first; re-importing into an existing workspace is a separate slice with a deliberate policy. Because the import runs before creation (D3), the refusal is evaluated only after the dump is read, and read and import failures are reported before the workspace check — so an error dump never reaches the repair hint; the read has no side effects, no write occurs, and a preflight would add another public check purely to save work on an error path.

**D3 — Read the dump first, then create; `--from <path>` or `--from -` for stdin.**

`--from <path>` reads the whole file with `readFile(path, 'utf8')`, matching `compare`/`plan`'s `readDump` ([`packages/cli/src/run.ts`](../../packages/cli/src/run.ts)). `--from -` drains `process.stdin` to EOF with async iteration, so a pipe works on every supported platform; do not use `/dev/stdin` or `readFile(0, 'utf8')`, whose behavior on non-blocking/TTY descriptors is platform-specific. `packages/cli/src/run.ts` already owns this plumbing: export its `readDump` and `importSide`, add `readStdin` beside them, and have `init.ts` call those helpers instead of duplicating a reader or an import wrapper. The read and throw mappings stay in `run.ts` and are reused, not moved: `readDump` keeps `schemamill: cannot read <path>: <reason>`, `importSide` keeps `schemamill: <message>`, and `readStdin` uses the matching `cannot read stdin` line. A read failure exits 1 and leaves the target untouched. The text goes through the existing `importDump(ddl): Promise<ReadResult<Model, Diagnostic>>` — the same entry point `compare` and `plan` use, not a parallel parser or a new import mode. Only after a clean import does the CLI call `initWorkspace(resolve(path), imported.model)`, so a failed read or import creates no target directory, no marker, and no model. The whole dump is held in memory, exactly as `compare`/`plan` already do; streaming is not this slice.

**D4 — Diagnostics are stderr-only; an `error` refuses the workspace, `skip`/`flag` do not.**

The import result is the existing `ReadResult<Model, Diagnostic>` with `skip`, `flag`, and `error` findings ([`packages/core/src/diagnostic.ts`](../../packages/core/src/diagnostic.ts)). Reuse `formatDiagnostics` ([`packages/cli/src/diagnostics.ts`](../../packages/cli/src/diagnostics.ts)) with one new label, `source:`, so the lines read `source: 2 skipped, 1 flagged` and `source: [error] <message> (<line>:<column>)`; the existing `baseline:` and `target:` bytes are unchanged. Behavior:

| Outcome                 | stderr                                         | exit | Workspace |
| ----------------------- | ---------------------------------------------- | ---- | --------- |
| dump read failure       | `schemamill: cannot read …`                    | 1    | none created |
| `importDump` throws     | `schemamill: <message>`                        | 1    | none created |
| any `error` diagnostic  | counts line + every `[error]` line             | 1    | none created |
| `skip`/`flag` only      | counts line; each line under `--verbose`       | 0    | written   |
| clean import            | empty                                          | 0    | written   |
| existing workspace, clean or skip/flag import | repair hint (after any counts line) | 1 | existing bytes untouched |
| target inside a workspace | `schemamill: <target> is inside the workspace at <root>` | 1 | none created |

`none created` means no workspace is created; a pre-existing workspace's model is never modified (the inside-a-workspace refusal may leave the created target directory behind).

An `error` is a parse failure; the returned model may be missing a statement. A persistent workspace must not claim to be a faithful import of a dump that did not parse, so `init --from` refuses to write on any error — stricter than `compare`/`plan`, which still print their artifact with exit 1 because they persist nothing. A dump whose every statement is skipped is not an error: it imports the empty model, prints the counts line, exits 0, and creates the workspace; that is Import's existing contract, not a failure. Stdout carries only the success line on success and is empty on every failure; diagnostics never share stdout with it (the same stream split as `compare`/`plan`). `--verbose` lists skip/flag findings; errors always print.

**D5 — The writer stays internal; the smallest seam is an optional model on `initWorkspace`.**

`serializeModel` is exported from `packages/core/src/workspace.ts` for tests but is deliberately not re-exported by `packages/core/src/index.ts`; keep it that way. Give `initWorkspace` one optional second parameter, `initWorkspace(targetPath: string, model: Model = EMPTY_MODEL)`, and have it write `serializeModel(model)` after the existing atomic marker claim. That reuses the canonical sorting, declaration order, omitted-optional handling, trailing newline, and failed-write cleanup; the default preserves the exact empty-model bytes and every existing caller and test. The CLI passes `imported.model`; it never writes JSON itself, never imports a deep `dist/` path, and never gains a second serializer. The alternative — exporting `serializeModel` and letting the CLI write after `initWorkspace` returns — would create a half-built workspace on a write failure and put the writer outside core; this seam keeps creation and import one operation. This is not the deferred public writer: it can write the imported model only while creating a new workspace, never read-modify-write an existing one. The `writeWorkspaceModel` API and atomic replacement have since shipped in [#120](https://github.com/osama784/schemamill/issues/120) ([workspace-writer.md](./workspace-writer.md)); overwrite/merge policy and locking remain deferred. [#134](https://github.com/osama784/schemamill/issues/134) supersedes the re-export half of this decision: `serializeModel` is re-exported as the read-only export projection, while `writeWorkspaceModel` remains the only persistence path and the CLI still gains no second serializer.

**D6 — Success output is unchanged; the model stays bare; no new ADR.**

Both forms print exactly `Initialized workspace at <absolute path>` on stdout and exit 0; the dump source is not echoed, and counts stay on stderr. Keeping one success shape preserves the existing CLI pin and scriptability, and `--from -` already tells the user what they piped. No source path, hash, or timestamp is recorded: `.schemamill/model.json` stays the bare canonical model with no wrapper and no extra files, per ADR 0010, and provenance belongs to a future snapshot/format decision. The help changes are the usage line `init [options] [path]`, the `--from <dump>` description (including `-` for stdin), and `--verbose`; `USAGE` is re-pinned and an `INIT_HELP` pin is added. No new ADR: ADR 0010 already fixes the layout, the bare model, and init's refusal semantics, and this slice adds an import option plus a CLI flag rather than a new structural rule.

**D7 — Pins are core unit, CLI spawn, and the existing goldens; no live-PG evidence.**

The unit pin is `packages/core/src/workspace.test.ts`: an imported model is written as canonical bytes and read back through `resolveWorkspace` without loss, the default still writes the exact empty model, and the existing refusal tests stay green. The CLI pins are in `packages/cli/src/cli.test.ts`, which spawns the built `dist/index.js`: file and stdin input produce identical model bytes; `compare`/`plan` from inside the workspace created by `init --from` are byte-identical to the two-dump run; an existing workspace leaves its model untouched; an `error` diagnostic leaves no marker; a skip/flag dump writes the workspace and prints the counts; read failures exit 1, and a thrown import uses the same `schemamill: <message>` mapping as a code path; `--from` without a value exits 1 with Commander's usage error and touches no filesystem; `--help`/`USAGE` bytes are re-pinned. `packages/cli/src/goldens.test.ts` stays unchanged — the new CLI pin asserts workspace-vs-two-dump equality, not new golden bytes. Live-PG evidence is not needed and should not be added: this path never calls `catalogReader` or `psql` and does not read `SCHEMAMILL_TEST_PG_URL`; it exercises `importDump`, whose model and diagnostic contract is already pinned by `packages/postgres/src/import.test.ts` and the dump-backed CLI goldens. The gated suite (`packages/postgres/src/live-pg.test.ts`) is a PostgreSQL round-trip harness — every scene dumps and re-imports both databases, and some scenes assert introspection — but it never touches the CLI or the workspace seam, so a live scene here would prove PostgreSQL behavior, not this slice. `--from-url` is where live evidence becomes mandatory.

## Slice

One tracer bullet — one branch, one PR, one tracker issue, one mutating session; no parallel mutating work. The supply pass files the tracker issue with this plan linked; this plan plus that issue is the brief.

Shipped in [#113](https://github.com/osama784/schemamill/issues/113); the ordered steps below are the authored plan.

**W1. `init --from` — a DDL dump becomes the workspace model.**

Ordered steps:

1. **Core seam.** Add the optional `model` parameter to `initWorkspace`; keep `serializeModel` internal. Add unit pins for imported-model canonical bytes, round-trip resolution, and the unchanged default.
2. **CLI source.** Add `--from <dump>` and `--verbose` to `init`; read a file through the exported `readDump` or stdin through `readStdin` beside it in `packages/cli/src/run.ts`; import through the exported `importSide`; call `initWorkspace(resolve(path), imported.model)`.
3. **Diagnostics and refusals.** Extend the formatter label to `source`; print counts/errors on stderr; refuse to write on `error`; map read/throw failures; keep the existing-workspace refusal and repair hint.
4. **End-to-end pin.** Create a temp workspace from a fixture dump; run `compare` and `plan` with the lone target path from inside it; assert byte-equality with the two-dump run; add the stdin, refusal, error, skip/flag, and read-failure cases.
5. **Docs and ledger.** Add the `[Unreleased]` changelog entry; mark this plan built and record the ship note on the tracker issue; amend [workspace-consumption.md](./workspace-consumption.md) §Deferred's population item to record that dump-only population ships in this slice while live-database population remains deferred. No `packages/postgres` or `packages/server` changes are expected.

## Verification

**Acceptance:**

1. `schemamill init --from <fixture>` in a fresh directory exits 0, prints the exact success line, and `resolveWorkspace(root)` returns a model deep-equal to `importDump` of the same text; the model file is `serializeModel`'s canonical bytes.
2. From inside that workspace (and from a nested directory), `schemamill compare <target-dump>` and `schemamill plan <target-dump>` print stdout byte-identical to `schemamill compare <baseline-dump> <target-dump>` and `schemamill plan <baseline-dump> <target-dump>`, with the same exit code and empty stderr. This is the tracer's load-bearing claim: a workspace the user did not hand-edit drives the existing consumers.
3. `schemamill init --from -` with the same dump on stdin produces byte-identical `model.json` and command output.
4. Plain `schemamill init` still writes the exact empty model and prints the same line; the existing init and workspace tests are unchanged.
5. A second `init --from` on the same workspace exits 1, prints the repair hint, leaves stdout empty, and leaves the model bytes untouched; a target inside an existing workspace gets `workspace-inside-workspace`.
6. A dump with a parse error exits 1, prints the counts/error lines, leaves stdout empty, and leaves no `.schemamill` at the target; a dump with only skips/flags exits 0, writes the workspace, and prints the counts line (details under `--verbose`); a missing file exits 1 with no workspace, and a thrown import uses the same `schemamill: <message>` mapping (a code path; no deterministic spawn fixture is invented for it).
7. `init --help` pins the new usage and options; `compare`/`plan` help and all existing goldens are unchanged.
8. `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.

**Test surfaces:**

- `packages/core/src/workspace.test.ts` — existing `initWorkspace creates the target directory and the exact empty model`, the refusal tests, and the writer/round-trip tests; add imported-model pins beside them.
- `packages/cli/src/cli.test.ts` — existing init scenes (`init creates a workspace in a directory, exit 0`; `a second init refuses the existing workspace with the repair hint, exit 1`; `init refuses a directory inside an existing workspace, exit 1`), the one-path workspace scenes, and the `USAGE`/help pins; add the `--from` matrix.
- `packages/cli/src/goldens.test.ts` — unchanged; the new CLI pin asserts workspace-vs-two-dump equality, not new golden bytes.
- `packages/postgres/src/import.test.ts` — unchanged; it is the import contract this slice reuses.
- `packages/postgres/src/live-pg.test.ts` — no new scene; the suite is unaffected (D7).

**Falsification:** at least two hand mutations must fail a pin, with the original restored hash-verified: (a) pass `EMPTY_MODEL` instead of the imported model to `initWorkspace` — the workspace-backed `compare`/`plan` equality must fail; (b) allow an existing marker to be overwritten — the second-init bytes/refusal test must fail; optionally (c) write on an `error` diagnostic — the no-marker test must fail. The core change sits under the mutation harness (`packages/core/stryker.config.mjs` mutates `src/**/*.ts`); `pnpm mutation:core` is optional supporting evidence, not one of the five gates.

**Gates:** the five root commands above on the final tree; CI re-runs them on Node 24 and 26.

## Done means

- All five gates — `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` — pass on the final tree.
- An `[Unreleased]` changelog entry records the new `init --from` surface.
- This plan is marked built, with the ship note on the tracker issue.
- No stray files are staged or committed, and no goldens changed.

## Deferred

Named for the slices that own them, never silent:

- **Live-database population (`--from-url`)** — Introspection through `catalogReader` ([ADR 0011](../adr/0011-introspection-transport.md)): connection/transport failure split, read-only posture, password visibility, and live-PG evidence. Its own slice; it is not an Import and must not reuse the dump flag.
- **A public writer API** — shipped in [#120](https://github.com/osama784/schemamill/issues/120) ([workspace-writer.md](./workspace-writer.md)): `writeWorkspaceModel` writes or updates a model in an existing workspace and replaces it atomically. Overwrite/merge policy, locking, and a stable format contract remain deferred. The optional model parameter in D5 is not that API.
- **Re-importing, overwriting, or merging an existing workspace** — a deliberate policy (maybe `--force` or a diff preview), including what an empty model means; the repair hint is the only path until then.
- **Snapshots** — capturing, naming, listing, and comparing frozen model copies in a workspace; its own slice per the [workspace plan](./workspace.md) §Deferred.
- **Studio consumption** — the server and canvas reading/writing the workspace layout; owns any structure beyond the container.
- **Multi-workspace handling** — selecting among several workspaces, a global index, or cross-workspace operations.
- **Migration history** — apply logs, history, caches, and lock files; the workspace holds the model, not a product database.
- **Source provenance** — recording the dump path, hash, or import time in the workspace; needs a format and snapshot decision, and would require a second file or field, breaking the bare-model rule today.
- **File-format versioning** — migrating older workspace files forward; the reader accepts bare today and will accept bare and wrapped when an envelope becomes necessary.
- **A workspace usage-docs page, Windows path edge cases, and `init`'s EACCES refinement** — still deferred by [ADR 0010](../adr/0010-workspace-container.md).

## Non-goals

- Not a new `import` command, a paste surface, or a multi-dump merge; one `--from` dump per invocation.
- No database connection, no `psql`, no Introspection, no `--from-url`.
- No changes to `importDump`, the diagnostic vocabulary, the model shape, `diff`, `plan`, or `renderSql`; import coverage stays exactly as it is.
- No changes to the workspace layout, marker, resolution, or refusal semantics; ADR 0010 is the record and is not re-litigated.
- No provenance field, version envelope, extra file, or snapshot in `.schemamill/`.
- No studio/server work; no overwrite, merge, or re-import of an existing workspace.
- No new ADR; the decisions above are implementation choices within ADR 0010.

## Open questions

- **Vocabulary.** "Population" is not a CONTEXT.md term; this plan uses **Import** for the operation and keeps "workspace population" only as the slice name inherited from the two workspace plans. Recommendation: no new term — Import is sufficient. If the human wants a distinct term for importing into a workspace at creation time, add it to `CONTEXT.md` before implementation rather than coining it in code or docs.
