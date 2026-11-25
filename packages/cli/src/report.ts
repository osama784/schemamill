import { assertNever } from '@schemamill/core';
import type { Diagnostic } from '@schemamill/core';
import type { Command } from 'commander';

import { hasErrors } from './diagnostics.ts';
import { importSide, readDump, readStdin } from './run.ts';

/**
 * The `report` command: one DDL dump in, one reviewable import fidelity document on stdout.
 *
 * The document aggregates the importer's own diagnostics — nothing is re-derived from the model
 * or from stderr. Each finding is grouped by `(kind, code)` into one of five fixed groups, in the
 * canonical order below; empty groups are omitted. Rows inside a group keep the importer's
 * offset-sorted order: a group is filled by a stable walk, never a second sort. An unknown code
 * throws through `assertNever`, so a future importer finding fails loudly instead of vanishing.
 *
 * Wiring only for the CLI surface: the read/import plumbing and the exit predicate come from
 * `run.ts` and `diagnostics.ts`. A read or import failure prints its one `schemamill: …` stderr
 * line and leaves stdout empty; a parse-failure diagnostic is a row in the document, with empty
 * stderr and exit 1. The formatter is pure: no paths, roots, clocks, environment, or count lines
 * enter the bytes, so the same dump always renders identically.
 *
 * v1 limitation: the one-line-per-finding shape assumes object names and messages contain no tabs
 * or newlines. A quoted identifier carrying a control character is printed verbatim, which can
 * break that shape; the fixture avoids them and `report.test.ts` pins the actual behavior.
 */

/** The five fixed `(kind, code)` groups, in the report's canonical order. */
export type ReportGroupKey =
  | 'skip/unsupported-statement'
  | 'skip/psql-meta-command'
  | 'skip/copy-data'
  | 'flag/unsupported-attribute'
  | 'error/parse-failure';

/** The group order is a report decision, not a second sort of the importer's diagnostics. */
export const REPORT_GROUP_ORDER: readonly ReportGroupKey[] = [
  'skip/unsupported-statement',
  'skip/psql-meta-command',
  'skip/copy-data',
  'flag/unsupported-attribute',
  'error/parse-failure',
];

/** One non-empty group and its findings, in importer order. */
export interface ReportGroup {
  readonly key: ReportGroupKey;
  readonly diagnostics: readonly Diagnostic[];
}

/** Maps a diagnostic to its one fixed group, failing closed on any unmapped code. */
function groupKey(diagnostic: Diagnostic): ReportGroupKey {
  const code = diagnostic.code;
  switch (code) {
    case 'unsupported-statement':
      return 'skip/unsupported-statement';
    case 'psql-meta-command':
      return 'skip/psql-meta-command';
    case 'copy-data':
      return 'skip/copy-data';
    case 'unsupported-attribute':
      return 'flag/unsupported-attribute';
    case 'parse-failure':
      return 'error/parse-failure';
    default:
      return assertNever(code, 'report diagnostic code');
  }
}

/**
 * Groups diagnostics by `(kind, code)` in the canonical order, omitting empty groups.
 *
 * A single pass collects findings in arrival order; walking the fixed group order then emits the
 * blocks. The importer's diagnostics are already offset-sorted, so no comparison or locale sort
 * happens here. Every diagnostic is mapped first, so an unmapped code throws even when it would
 * otherwise land in a group that is not rendered.
 */
export function groupDiagnostics(diagnostics: readonly Diagnostic[]): readonly ReportGroup[] {
  const collected = new Map<ReportGroupKey, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = groupKey(diagnostic);
    const rows = collected.get(key);
    if (rows === undefined) collected.set(key, [diagnostic]);
    else rows.push(diagnostic);
  }

  const groups: ReportGroup[] = [];
  for (const key of REPORT_GROUP_ORDER) {
    const rows = collected.get(key);
    if (rows !== undefined) groups.push({ key, diagnostics: rows });
  }
  return groups;
}

/** One finding: `kind code<TAB>object<TAB>message (line:column)`, with no object for errors. */
function formatRow(diagnostic: Diagnostic): string {
  const label = `${diagnostic.kind} ${diagnostic.code}`;
  const object = diagnostic.kind === 'error' ? '' : `${diagnostic.object}\t`;
  // Every v1 diagnostic carries a position; the guard only keeps this total for synthetic input.
  const position = diagnostic.position;
  const suffix = position === undefined ? '' : ` (${position.line}:${position.column})`;
  return `${label}\t${object}${diagnostic.message}${suffix}`;
}

/** The deterministic document: one line per finding, blank-line separated groups. */
export function formatReport(diagnostics: readonly Diagnostic[]): string {
  const groups = groupDiagnostics(diagnostics);
  if (groups.length === 0) return 'No findings.\n';

  const blocks = groups.map((group) => group.diagnostics.map(formatRow).join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/** Registers `schemamill report` on `program`. */
export function registerReport(program: Command): void {
  program
    .command('report')
    .description('Report the import fidelity findings for one DDL dump.')
    .argument('<dump>', 'path to the DDL dump (- for stdin)')
    .action(async (dump: string) => {
      const ddl = dump === '-' ? await readStdin() : await readDump(dump);
      if (ddl === null) {
        process.exitCode = 1;
        return;
      }
      const imported = await importSide(ddl);
      if (imported === null) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(formatReport(imported.diagnostics));
      process.exitCode = hasErrors(imported.diagnostics) ? 1 : 0;
    });
}
