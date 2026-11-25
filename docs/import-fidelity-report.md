# Import fidelity report

**Status:** built 2026-11-25 · living document

`schemamill report <dump>` reads one DDL dump — a file path, or `-` for stdin — and writes one deterministic, human-reviewable document to stdout: an aggregate of the findings the DDL importer already emitted for that dump, so a human can judge round-trip fidelity before accepting the resulting model. It adds no finding of its own and has no flags in v1. The [slice plan](./plans/import-fidelity-report.md) records the scope, and [ADR 0037](./adr/0037-import-fidelity-report-aggregates-diagnostics.md) records the decisions. The findings follow the Diagnostic DTO contract in [Structured JSON output](./json-output.md#diagnostic); this page describes the text projection, not a second contract for `kind`, `code`, `object`, `message`, or `position`.

## Command surface

```text
Usage: schemamill report [options] <dump>
```

The one positional is the dump to read: pass a path, or `-` to read the dump from stdin. The command writes the report to stdout and nothing else there — no workspace is required or changed, and no other command's output is mixed in. `report --help` prints the usage above. A dump that cannot be read or imported is a one-line failure on stderr with empty stdout; see [Streams and exit status](#streams-and-exit-status).

## Groups

Each finding is grouped by its `(kind, code)` pair. The fixed groups render in this canonical order; a group with no findings is omitted. Each code belongs to exactly one kind, so the pair is unambiguous. The group order is a report decision — it deliberately breaks global source offset order.

| Order | `kind` / `code` | Finding |
| --- | --- | --- |
| 1 | `skip/unsupported-statement` | A whole statement the importer does not carry into the model. |
| 2 | `skip/psql-meta-command` | A client meta-command in the dump, not schema DDL. |
| 3 | `skip/copy-data` | `COPY` payload data, which is Data and out of scope. |
| 4 | `flag/unsupported-attribute` | A supported object whose attribute was dropped and named. |
| 5 | `error/parse-failure` | Text the importer could not parse; never a clean report. |

## Document format

One line per finding, with literal tab delimiters:

```text
kind code<TAB>object<TAB>message (line:column)
```

The `object` column is omitted for error rows; the `(line:column)` suffix is omitted only when a finding has no position (v1 findings carry one). `line` and `column` are 1-based and source-relative, so they do not depend on where the dump lives on disk. Groups are separated by one blank line, and every row is self-describing — there is no header and no count line. A dump with no findings prints exactly `No findings.\n`. See [Limitations](#limitations) for the tab and control-character constraint.

## Object naming

The `object` column is not re-derived by the report: it reuses the [ADR 0031](./adr/0031-exclusion-diagnostic-object-names-the-table.md) rule that the object names the schema-qualified owning entity and the message carries the member detail, together with the related [#188](https://github.com/osama784/schemamill/issues/188) diagnostic-naming contract. The group and ordering decisions do not rename or omit any finding the importer emits.

## Determinism

The document contains no timestamp, dump path, workspace root, random identifier, environment read, count line, or locale-dependent sort. Findings keep the importer's offset-sorted dump order within each group through a stable filter — no second sort — and an unmapped diagnostic code fails closed rather than being dropped. Running the command again on the same dump, or on a byte-identical copy at another path, produces byte-identical stdout; byte-level goldens pin the document. There is no envelope and no version field: machine-readable projections own their versioning separately, so none is bolted onto this human text.

## Streams and exit status

| Case | stdout | stderr | Exit |
| --- | --- | --- | --- |
| Dump unreadable or import failed | empty | one `schemamill: …` line | 1 |
| Parse-failure finding | full document, with an `error/parse-failure` row | empty | 1 |
| Skip or flag findings only | full document | empty | 0 |
| No findings | `No findings.\n` | empty | 0 |

## Limitations

The one-line-per-finding shape assumes object names and messages contain no tabs or newlines. A quoted identifier carrying a control character, or a message containing an embedded tab, is printed verbatim and can break that shape; the command performs no silent rewrite. The report fixtures avoid such characters.

## Deferred

Named for the slices that own them, never silent:

- **Machine-readable report projections** (SARIF, JUnit, CI-native) — a different projection with its own versioning and no consumer yet; owned by the next slice out of [structured JSON's §Deferred](./plans/structured-json.md#deferred), not by this human document.
- **Introspection diagnostics parity** — a live catalog read is Introspection, never Import; catalog-read findings stay with their own owner (#71 and the folded #230).
- **A report for `export` envelopes** — `export` stays the bare canonical model ([ADR 0023](./adr/0023-export-projects-the-model.md)); this report neither wraps nor versions it.
- **Streaming very large dumps** — an in-memory aggregation is enough until a real large-dump consumer exists.
- **Fidelity scoring and a pass/fail gate** — v1 describes findings and never scores or judges them.
