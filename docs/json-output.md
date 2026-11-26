# Structured JSON output

**Status:** built 2026-11-23 · living document

`schemamill compare --json` and `schemamill plan --json` write exactly one JSON document to stdout. The document is a stable, versioned projection of the same diff and migration plan the human commands compute; it introduces no new change, step, hazard, or diagnostic semantics. Without `--json`, both commands keep their human stdout, stderr wording, and exit codes byte-for-byte. `schemamill export --format json` is a different artifact — bare canonical model bytes, not wrapped or versioned ([ADR 0023](./adr/0023-export-projects-the-model.md)).

This page is the contract: every field, every DTO key set, the byte rules, and the stream/exit matrix. [ADR 0033](./adr/0033-json-output-envelope.md) records why the envelope and versioning rule are shaped this way, and the [slice plan](./plans/structured-json.md) records what shipped.

## The envelope

Every document starts with these fields in this order. The example is a `compare` document; a `plan` document differs only in `command` and `result`.

```json
{
  "schemaVersion": 1,
  "command": "compare",
  "schemamill": { "version": "0.7.0" },
  "workspace": null,
  "sides": {
    "baseline": {
      "source": "dump",
      "path": "baseline.sql",
      "model": { "tables": 2, "sequences": 0, "views": 1, "extensions": 0 }
    },
    "target": {
      "source": "dump",
      "path": "target.sql",
      "model": { "tables": 2, "sequences": 1, "views": 2, "extensions": 1 }
    }
  },
  "diagnostics": { "baseline": [], "target": [] },
  "result": { "changes": [] }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | `1` today; see [Versioning](#versioning). |
| `command` | `"compare"` \| `"plan"` | Which command produced the document. |
| `schemamill.version` | string | The schemamill version exported by core — the same value `--version` prints; no separate version read is performed. |
| `workspace` | `{ "root": string }` \| `null` | The resolved workspace root when either side came from a workspace; `null` when neither did. There is no `modelFile` field. |
| `sides.baseline`, `sides.target` | side object | Provenance and model counts for each side, described below. |
| `diagnostics.baseline`, `diagnostics.target` | diagnostic array | Every import finding for that side, in dump order; a workspace side contributes an empty array. |
| `result` | compare result or plan result | The command-specific projection, described below. |

A side object has:

| Field | Type | Meaning |
| --- | --- | --- |
| `source` | `"dump"` \| `"workspace"` | How the side was sourced. |
| `path` | string, optional | Present exactly for a dump, with the path the command received; omitted for a workspace. |
| `model.tables`, `model.sequences`, `model.views`, `model.extensions` | integer | Counts of the four modeled families, written in that order. No other family is counted. |

A `plan` result carries the semantic plan in this order; rendered migration SQL is deliberately not embedded (`plan` still renders for validation — see [Streams, verbose, and exit status](#streams-verbose-and-exit-status)):

| Command | `result` fields |
| --- | --- |
| `compare` | `changes` — Change objects in diff order. Nothing else; hazards belong to plan's result alone. |
| `plan` | `targetVersion` (integer), `steps` (Step objects), `groups` (Group objects), `hazards` (Hazard objects), in that order. |

A group is `{ "start": number, "end": number, "transactional": boolean }`: a half-open range of indices into `result.steps`, in plan order, marking one unit that applies together.

## DTOs

Each DTO is built explicitly by `packages/cli/src/json.ts`; no internal class crosses the boundary. A `?` in a field list marks an optional key that is omitted when absent, never emitted as `null`. Embedded model values — a table, column, sequence, view, extension, index, constraint (including an exclusion constraint's optional `elements`, `accessMethod`, `where`, `deferrable`, `initiallyDeferred`, and `comment`), or identity — reuse the field names and optional-field omission of `serializeModel`; step payloads are flattened exactly as the core union reads. The recursive key set of each kind is pinned by the mapper's contract checks, and the dispatch is exhaustive: a new core kind fails the build until it is mapped here too.

### Change

`result.changes` holds Change objects in diff order. Each object has a `kind` discriminant plus these fields:

| `kind` | Additional fields |
| --- | --- |
| `table-added`, `table-removed` | `table` |
| `table-changed` | `table`, `changes` |
| `sequence-added`, `sequence-removed` | `sequence` |
| `sequence-changed` | `sequence`, `changes` |
| `view-added`, `view-removed` | `view` |
| `view-changed` | `view`, `changes`, `before`, `after` |
| `view-index-added`, `view-index-removed` | `owner`, `index` |
| `view-index-changed` | `owner`, `before`, `after` |
| `extension-added`, `extension-removed` | `extension` |
| `extension-changed` | `extension`, `changes` |
| `comment-changed` | `target`, `before?`, `after?` |

On an added or removed family, `table`, `sequence`, `view`, and `extension` carry the full model payload. On a `*-changed` change they carry just the identity (`schema` and `name`; an extension is identified by `name` alone). The `changes` array of `table-changed` holds TableChange objects; the `changes` array of `sequence-changed`, `view-changed`, and `extension-changed` holds field pairs `{ field, before?, after?, converted? }`, where `converted` appears only on identity and sequence field changes.

TableChange objects, nested under `table-changed`:

| `kind` | Additional fields |
| --- | --- |
| `column-added`, `column-removed` | `column` |
| `column-changed` | `name`, `fields`, `identity?`, `attributes?` |
| `primary-key-added`, `primary-key-removed` | `primaryKey` |
| `primary-key-changed` | `before`, `after` |
| `foreign-key-added`, `foreign-key-removed` | `foreignKey` |
| `foreign-key-changed` | `before`, `after` |
| `unique-constraint-added`, `unique-constraint-removed` | `uniqueConstraint` |
| `unique-constraint-changed` | `before`, `after` |
| `check-constraint-added`, `check-constraint-removed` | `checkConstraint` |
| `check-constraint-changed` | `before`, `after` |
| `exclusion-constraint-added`, `exclusion-constraint-removed` | `exclusionConstraint` |
| `exclusion-constraint-changed` | `before`, `after` |
| `index-added`, `index-removed` | `index` |
| `index-changed` | `before`, `after` |
| `persistence-changed` | `before?`, `after?` |

An `identity` on `column-changed` is an IdentityChange: `added`, `removed`, and `recreated` carry an `identity`; `changed` carries `fields`. A `target` on `comment-changed` (and on the `comment` step) is a CommentTarget:

| `target.kind` | Additional fields |
| --- | --- |
| `table` | `table` |
| `column` | `table`, `column` |
| `not-null` | `table`, `column` |
| `sequence` | `sequence` |
| `view` | `view`, `materialized` |
| `extension` | `extension` |
| `index` | `table`, `index` |
| `primary-key` | `table`, `primaryKey` |
| `unique-constraint` | `table`, `uniqueConstraint` |
| `check-constraint` | `table`, `checkConstraint` |
| `exclusion-constraint` | `table`, `exclusionConstraint` |
| `foreign-key` | `table`, `foreignKey` |

An embedded `column` payload carries the optional `notNullComment` field beside `notNullName` when the column declares a not-null constraint comment ([ADR 0038](./adr/0038-not-null-constraint-comments-travel-the-model.md)); both keys are omitted when absent. The `not-null` target carries the whole column, not just its name, so a renderer can resolve the constraint by `notNullName ?? synthesizedNotNullName` when a generated name was stripped on import; its comment key is `[schema, table, 'not-null', column]`, distinct from the plain column target's key.

A view-index change or index step names its owner with `kind: "table"` (`table`) or `kind: "materialized-view"` (`view`); an ordinary view cannot own an index.

### Step

`result.steps` holds Step objects in plan order. Each object has a `kind` discriminant plus these fields:

| `kind` | Additional fields |
| --- | --- |
| `create-schema` | `schema` |
| `create-table` | `table` |
| `drop-table` | `table` |
| `add-column`, `drop-column` | `table`, `column` |
| `alter-column` | `table`, `name`, `fields`, `attributes?` |
| `drop-not-null`, `add-not-null` | `table`, `column`, `name?` |
| `alter-persistence` | `table`, `persistence?` |
| `add-identity` | `table`, `name`, `identity` |
| `drop-identity` | `table`, `name` |
| `alter-identity` | `table`, `name`, `fields` |
| `add-primary-key`, `drop-primary-key` | `table`, `primaryKey` |
| `add-foreign-key`, `drop-foreign-key` | `table`, `foreignKey` |
| `add-unique-constraint`, `drop-unique-constraint` | `table`, `uniqueConstraint` |
| `add-check-constraint`, `drop-check-constraint` | `table`, `checkConstraint` |
| `add-exclusion-constraint`, `drop-exclusion-constraint` | `table`, `exclusionConstraint` |
| `create-index`, `drop-index`, `create-index-concurrently`, `drop-index-concurrently` | `owner`, `index` |
| `create-sequence` | `sequence` |
| `drop-sequence` | `sequence` |
| `alter-sequence` | `sequence`, `fields` |
| `create-extension` | `extension` |
| `alter-extension` | `extension`, `fields` |
| `drop-extension` | `extension` |
| `create-view`, `replace-view` | `view` |
| `drop-view` | `view`, `materialized` |
| `comment` | `target`, `text?` |

A `table`, `sequence`, `view`, or `extension` field on a create step carries the full model payload; on the matching drop or alter step it carries the identity. A `fields` array holds field pairs as described under Change. `alter-sequence` and `alter-extension` carry field pairs in their `fields` arrays, and `alter-identity` carries identity field pairs (which may include `converted`).

### Hazard

`result.hazards` holds Hazard objects in plan order. `step` is a zero-based index into `result.steps`, and `entity` is the annotated object:

| `kind` | Additional fields |
| --- | --- |
| `increment-zero` | `step`, `entity`, `increment` |
| `cache-nonpositive` | `step`, `entity`, `cache` |
| `bounds-inverted` | `step`, `entity`, `minValue`, `maxValue` |
| `start-out-of-bounds` | `step`, `entity`, `start`, `minValue`, `maxValue` |
| `bound-out-of-type-range` | `step`, `entity`, `dataType`, `field`, `value` |
| `bound-tightened` | `step`, `entity`, `field`, `before`, `after` |
| `table-rewrite` | `step`, `entity`, `persistence?` |

The `entity` payload is one of `kind: "sequence"` (`sequence`), `kind: "identity-column"` (`table`, `column`), or `kind: "table"` (`table`). Hazard kinds and wording are unchanged from the human command; the document only projects them.

### Diagnostic

`diagnostics.baseline` and `diagnostics.target` hold Diagnostic objects in dump order, baseline before target. Every finding is present regardless of `--verbose`.

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"error"` \| `"skip"` \| `"flag"` | The finding's severity/family. |
| `code` | string | Stable machine label; human stderr deliberately omits it. |
| `object` | string, optional | Present for `skip` and `flag`, naming the skipped statement/object or the object that lost a feature; omitted for `error`. |
| `message` | string | Factual, human-facing finding text. |
| `position` | `{ line, column, offset }`, optional | Omitted when the source does not locate the finding. When present, all three components are present. |

`position.line` and `position.column` are 1-based; `position.offset` is a 0-based index into the source text in UTF-16 code units (the same convention core's `SourcePosition` uses). A CRLF pair counts as one line break.

## Byte rules

- **Empty arrays stay empty.** Every documented array is always present and serializes as `[]` when it has no entries — including `result.changes`, `result.steps`, `result.groups`, `result.hazards`, and both diagnostic arrays.
- **Optionals are omitted, not nulled.** A missing optional key is absent from the object; the only `null` the document ever writes is `workspace: null` when neither side came from a workspace.
- **Deterministic order.** Changes follow diff order; steps follow plan order; groups follow group order; hazards follow plan order; each side's findings follow dump order, baseline before target. Object keys are inserted in the order shown on this page. No clock, random identifier, filesystem walk, or locale sort enters the document.
- **Canonical rendering.** `stringifyJsonDocument` writes two-space indentation and exactly one trailing newline (`\n`). The document is emitted at one final write site, after all validation, so a failure never leaves partial JSON on stdout.

## Variable fields in goldens

Three values are machine-specific and therefore normalized only when a golden is compared: `schemamill.version` becomes `<VERSION>`, a workspace `root` becomes `<WORKSPACE_ROOT>`, and a dump side's `path` becomes `<DUMP_PATH>`. The mapper has no normalization option — production always writes the real resolved values. Normalizing these three fields keeps the goldens invariant across checkouts and releases while the remaining bytes stay pinned.

## Versioning

`schemaVersion` is the integer `1`. It bumps when a field is removed or renamed, a field's type or meaning changes, an enumerated value's meaning changes, or the envelope's required shape changes. It does not bump for an additive optional field or an additive new `command` value. Consumers must ignore unknown keys: additive changes are compatible, and a breaking change is a new integer, never a silent reshape of version 1. Consumers should branch on `command` before reading `result`, since the result shape is command-specific.

This rule applies to the `compare` and `plan` documents only. The `export --format json` projection stays bare canonical model bytes with no envelope or version ([ADR 0023](./adr/0023-export-projects-the-model.md)); [ADR 0033](./adr/0033-json-output-envelope.md) records the decision.

## Streams, verbose, and exit status

With `--json`, stdout carries exactly one document plus its trailing newline and no human text. Diagnostics stay on stderr in their existing wording: a counts line whenever there are findings, every `error` line always, and `skip`/`flag` lines only under `--verbose`. The document always carries every `error`, `skip`, and `flag` finding whether or not `--verbose` was passed, so `--json --verbose` produces stdout identical to `--json` alone and grows only stderr.

| Situation | stdout | stderr | Exit | Document? |
| --- | --- | --- | --- | --- |
| Usage error (bad flag, bad side/flag combination, invalid `--target-version`) | empty | Commander's error text | 1 | No |
| Dump read or workspace-resolution failure | empty | one `schemamill: …` line | 1 | No |
| Plan-time contract error (`SequenceOwnershipError`) | empty | one `schemamill: …` line | 1 | No |
| Import returns a model with an `error` finding | one document | existing diagnostic lines | 1 (from the imported pair) | Yes |
| Plan's rendered SQL is refused (the document omits SQL) | one document | existing `schemamill: refusing to render …` line | 1 | Yes |
| Clean success | one document | unchanged diagnostic lines | 0 (from the imported pair) | Yes |

The exit status on a successful document is the imported pair's status: 1 when either side reported an `error` finding, otherwise 0; a render refusal overrides it with 1. `plan` still calls `renderSql` for validation even though the document does not embed the SQL, so a refusal cannot disappear under `--json`. The no-document paths are handled at the top of each action before the human path runs; without `--json`, that human path — including where each stderr line is written — is unchanged.
