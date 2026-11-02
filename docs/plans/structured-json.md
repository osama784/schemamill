# Structured JSON for compare and plan

**Status:** proposed (supply pass 2026-11-02) · **Last updated:** 2026-11-02

**Size:** M. The brief may split into J1 (the envelope and `compare --json`) and J2 (`plan --json`) if the DTO tables grow, but one brief is recommended: both commands share one envelope, one diagnostics shape, and one mapper, and a split would let the two documents drift before the versioning rule is settled.

The [vision](../domain/vision.md) (`:25`) puts deterministic, reviewable artifacts beside the safe-change loop, and the [core-domain map](../domain/core-domain.md) (`:20`) makes the CLI the automation face of that loop. `schemamill export --format json` already prints the canonical model as bare JSON (`packages/cli/src/export.ts:37-51`; [ADR 0023](../adr/0023-export-projects-the-model.md) D2), but `compare` and `plan` only print human text: `compare` formats changes and hazards (`packages/cli/src/compare.ts:61-68`), and `plan` formats the plan, hazards, and migration SQL (`packages/cli/src/plan.ts:82-99`), with the wording in `packages/cli/src/format.ts:78-80`, `:89-128`, and `:148-156`. A machine consumer today has to parse terminal prose. This slice gives both commands a versioned, documented JSON document without changing a byte of the human output.

## Goal

`schemamill compare --json` and `schemamill plan --json` emit one stable, parseable, documented JSON document on stdout: a versioned envelope with command, tool, workspace, and model metadata; the semantic changes for `compare`; the ordered steps, transaction groups, and hazards for `plan`; and every import diagnostic in structured form. Human output, stderr diagnostics, and exit codes stay exactly as they are.

## Scope

**In:**

- A `--json` flag on `compare` and `plan` only.
- A versioned envelope: `schemaVersion`, `command`, the schemamill version, optional workspace metadata, per-side source and model metadata, and per-side diagnostics.
- `compare`'s `result.changes`: the semantic diff projected into documented DTOs.
- `plan`'s `result`: `targetVersion`, ordered `steps`, transaction `groups`, and `hazards`.
- Explicit DTO mapping in one module, deterministic ordering, stable field names, `[]` for every empty array, no timestamps, and a documented versioning rule.
- `docs/json-output.md` as the contract, CLI help, JSON goldens, determinism tests, and a `[Unreleased]` changelog entry; an ADR records the envelope and versioning decision.

**Out, named — never silent:** JSON for `init` or introspection; SARIF, JUnit, or other CI formats; a schema-publishing or registry policy; streaming a large diff; studio or HTTP API consumption; the rendered migration SQL inside the plan document; and a checked-in JSON Schema file. The existing `export --format json` bytes, and every human `compare`/`plan` golden, stay untouched.

**Deliberately shallow for now:** the document is a projection of the same `diff` and `plan` results the human commands already compute. It introduces no new change, step, hazard, or diagnostic semantics, and it never guesses a rename or normalizes a model value that the human path would not.

## Decisions

- **D1 — One envelope, command-specific result.** Every document is:
  ```json
  {
    "schemaVersion": 1,
    "command": "compare",
    "schemamill": { "version": "0.6.0" },
    "workspace": {
      "root": "/abs/path",
      "modelFile": "/abs/path/.schemamill/model.json"
    },
    "sides": {
      "baseline": {
        "source": "dump",
        "path": "baseline.sql",
        "model": { "tables": 2, "sequences": 0, "views": 1, "extensions": 0 }
      },
      "target": {
        "source": "workspace",
        "model": { "tables": 2, "sequences": 0, "views": 1, "extensions": 1 }
      }
    },
    "diagnostics": { "baseline": [], "target": [] },
    "result": { "changes": [] }
  }
  ```
  `command` is `"compare"` or `"plan"`; `schemamill.version` is the CLI's version (`packages/core/src/index.ts:2`, printed by `packages/cli/src/index.ts:23`); `workspace` is `null` when neither side used a workspace, otherwise the resolved root and model path (`packages/core/src/workspace.ts:94-97`); each side's `source` is `"dump"` or `"workspace"`, with `path` present only for a dump and `model` the four family counts. `diagnostics` is per side, so a consumer never has to guess a provenance; every array is present and `[]` when empty. A plan replaces `changes` with `{ "targetVersion": 13, "steps": [], "groups": [], "hazards": [] }`. The rendered migration SQL is deliberately not embedded — see D6.
- **D2 — DTOs, not `JSON.stringify` of internal values.** A single mapper in `packages/cli/src/json.ts` constructs each document variant explicitly. Changes reuse the `kind` vocabulary and payload names of `Change` and `TableChange` (`packages/core/src/diff.ts:178-232`, `:235-325`); steps reuse the `kind` vocabulary and payload names of `Step` (`packages/core/src/plan.ts:317-437`); groups reuse `TransactionGroup` (`plan.ts:263-281`); hazards reuse `Hazard` (`packages/core/src/hazard.ts:22-84`). Embedded model values use the same field names and optional-field omission as `serializeModel` (`packages/core/src/workspace.ts:278-285`), but the envelope never embeds a bare model document and never reuses export's top level. A step's payload is flattened into the step object, exactly as the TypeScript union reads; an absent optional field is omitted rather than emitted as `null`. A deep key-whitelist test pins every documented field and fails if an internal addition leaks into the document.
- **D3 — Determinism.** Changes stay in `diff` order; steps in plan order; groups in `TransactionGroup` order; hazards in plan order; each side's diagnostics in dump order, baseline before target. Object keys are inserted in the documented order, and the tests pin the bytes, so two runs over the same inputs are identical. No timestamps, random IDs, locale sorting, or environment reads enter the document. `workspace.root` and a dump's `path` are the inputs the command already resolved or received; JSON goldens normalize them to stable placeholders rather than hiding them.
- **D4 — Diagnostics are complete; `--verbose` stays a stderr control.** The document always carries every diagnostic — `error`, `skip`, and `flag` — regardless of `--verbose`, so a machine consumer sees the same fidelity report the model does. `--verbose` continues to control only the human stderr lines (`packages/cli/src/diagnostics.ts:29-41`, `packages/cli/src/run.ts:132-147`). `--json --verbose` is legal and produces the same stdout document as `--json`; only stderr grows. Each diagnostic DTO is `{ kind, code, message, position? }`, with `position` as `{ line, column }` when present; the machine-readable `code` that human output intentionally omits is included.
- **D5 — Streams and exit codes are unchanged.** With `--json`, stdout carries exactly one JSON document plus a trailing newline and no human text; diagnostics stay on stderr in their existing wording. A read or workspace-resolution failure before a model exists prints its one stderr line, leaves stdout empty, and exits 1, so there is never partial JSON. An import that returns a model with an `error` diagnostic emits the document and exits 1. A plan whose SQL the renderer refuses still emits the document, prints the existing refusal line on stderr, and exits 1; because the document omits SQL, the command still calls `renderSql` for validation so the refusal cannot disappear under `--json`. A malformed invocation is Commander's existing usage error, with empty stdout.
- **D6 — No SQL in the document in v1.** The plan document carries the semantic plan — steps, groups, hazards, and the declared `targetVersion` — not the rendered SQL. The SQL is a projection whose bytes and refusals already have their own contract ([target version plan](./target-version.md)); embedding it would make every SQL-formatting change a JSON schema event and duplicate a large artifact. `plan` still renders for validation, and a consumer that needs the SQL runs `plan` without `--json`; an optional `sql` field is a named follow-up, not a silent gap.
- **D7 — Versioning and documentation.** `schemaVersion` is the integer `1`. Removing or renaming a field, changing a field's meaning or type, changing an `enum` value's meaning, or changing the envelope's required shape bumps it; adding a new optional field or a new additive `command` does not, and consumers must ignore unknown keys. `docs/json-output.md` documents the envelope, every DTO, the empty-array and omitted-field rules, the ordering, the versioning rule, and the exit-code behavior; the CLI help names the flag. The export JSON remains bare model JSON and is not versioned by this document.

## Acceptance

- `compare --json` on a fixture with table, column, constraint, index, sequence, view, extension, and comment changes emits a parseable document whose `result.changes` mirrors the human diff's order and content; `compare --json` on identical sides emits `"changes": []`.
- `plan --json` on a multi-group fixture emits parseable `steps`, `groups`, and `hazards`; group ranges tile the step list; step indices in hazards are zero-based and refer to the same list; an empty plan emits `"steps": []`, `"groups": []`, and `"hazards": []`.
- Every document carries `schemaVersion: 1`, the correct `command`, the schemamill version, side metadata, and complete per-side diagnostics; `--json --verbose` changes stderr only.
- A read failure leaves stdout empty and exits 1; an import error emits the document and exits 1; a render refusal emits the document, the existing stderr line, and exits 1.
- The human `compare` and `plan` goldens are byte-identical without `--json`; the help goldens change only by the new flag line.
- The five gates and `pnpm docs:counts --check` are green; `docs/json-output.md`, the ADR, the plan, and a `[Unreleased]` changelog entry land with the slice.

## Done means

- `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` pass from the repo root.
- JSON goldens for both commands and the determinism, empty-array, human-output, and exit-code tests pass; the live suite is unaffected and green.
- The plan, the ADR, `docs/json-output.md`, the changelog entry, and the tracker issue carry the ship note.

## Deferred

Named for the slices that own them, never silent:

- **JSON for `init` and introspection** — the other commands keep human output; each needs its own document shape and an owner.
- **SARIF, JUnit, and CI-native diagnostics** — a different projection with its own versioning; no consumer exists yet.
- **Schema publishing and a compatibility policy beyond the integer bump** — a registry, a checked-in JSON Schema, and deprecation windows are follow-ups.
- **Streaming large diffs** — the document is built in memory; a streaming writer is deferred until a real large-schema consumer exists.
- **Studio and HTTP API consumption** — the server is not a consumer in v1; the DTOs live in the CLI and can move to a shared seam when one appears.
- **Rendered SQL inside the plan document** — D6; an optional `sql` field is the named follow-up.
- **A JSON Schema file and generated field documentation** — `docs/json-output.md` is the contract for now; generated schema artifacts wait for the publishing decision.
- **JSON for `export` envelopes or versioning** — export stays the bare canonical model ([ADR 0023](../adr/0023-export-projects-the-model.md)); this slice neither wraps nor versions it.
- **Model-family counts beyond tables, sequences, views, and extensions** — the four keys are the stable v1 metadata; a future family adds an additive count with its own slice.

## Non-goals

- New diff or plan semantics, new hazards, or new diagnostics.
- Changing human output, stderr wording, or exit codes.
- Breaking or wrapping the existing `export --format json` output.
- A new library API for the studio; this is a CLI document first.
- Pretty-printing choices beyond the canonical two-space JSON and trailing newline.
