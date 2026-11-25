import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Diagnostic } from '@schemamill/core';
import { importDump } from '@schemamill/postgres';

import { formatReport, groupDiagnostics, REPORT_GROUP_ORDER } from './report.ts';

/**
 * Unit tests for the report document's pure core: the aggregation of import diagnostics into the
 * five fixed groups and the deterministic line formatter. The CLI's stream/exit behavior and the
 * byte-exact document live in `cli.test.ts` and `goldens.test.ts`; here the fixture is read only to
 * prove the formatter is a one-for-one projection of the importer's own diagnostics.
 */

/** The diagnostic-rich fixture, read verbatim from the checked-in LF bytes. */
const DUMP = readFileSync(
  fileURLToPath(new URL('../test/fixtures/report-fidelity.sql', import.meta.url)),
  'utf8',
);

/** The one-for-one tuple the brief pins: kind, code, object, message, line, column. */
type FindingTuple = readonly [string, string, string | undefined, string, number, number];

/** Parses a report back into tuples, using the tab delimiter between object and message. */
function tuples(report: string): FindingTuple[] {
  const parsed: FindingTuple[] = [];
  for (const line of report.split('\n')) {
    if (line === '') continue;
    const cells = line.split('\t');
    const labelled = cells[0]!;
    const space = labelled.indexOf(' ');
    const positioned = /^(.*) \((\d+):(\d+)\)$/.exec(cells.at(-1)!);
    assert.ok(positioned, `a report row must carry a line:column position: ${line}`);
    parsed.push([
      labelled.slice(0, space),
      labelled.slice(space + 1),
      cells.length === 3 ? cells[1] : undefined,
      positioned[1]!,
      Number(positioned[2]),
      Number(positioned[3]),
    ]);
  }
  return parsed;
}

/** Multiset comparison: order is deliberately ignored here, but not in the ordering tests below. */
const byTuple = (left: FindingTuple, right: FindingTuple): number =>
  JSON.stringify(left).localeCompare(JSON.stringify(right));

/** A source position for synthetic diagnostics; one line and column per call keeps rows distinct. */
const at = (line: number) => ({ offset: line, line, column: 1 });

function skipped(
  code: 'unsupported-statement' | 'psql-meta-command' | 'copy-data',
  object: string,
  line: number,
): Diagnostic {
  return {
    kind: 'skip',
    code,
    object,
    message: `skipped ${object}`,
    position: at(line),
  };
}

function flagged(line: number): Diagnostic {
  return {
    kind: 'flag',
    code: 'unsupported-attribute',
    object: 'app.like',
    message: 'dropped LIKE clause from app.like',
    position: at(line),
  };
}

function failed(line: number): Diagnostic {
  return {
    kind: 'error',
    code: 'parse-failure',
    message: 'syntax error',
    position: at(line),
  };
}

test('the fixture exercises all five diagnostic codes', async () => {
  const imported = await importDump(DUMP);

  assert.deepEqual([...new Set(imported.diagnostics.map((diagnostic) => diagnostic.code))].sort(), [
    'copy-data',
    'parse-failure',
    'psql-meta-command',
    'unsupported-attribute',
    'unsupported-statement',
  ]);
});

test('report rows are a one-for-one projection of importDump diagnostics', async () => {
  const imported = await importDump(DUMP);
  const expected = imported.diagnostics
    .map((diagnostic): FindingTuple => [
      diagnostic.kind,
      diagnostic.code,
      diagnostic.kind === 'error' ? undefined : diagnostic.object,
      diagnostic.message,
      diagnostic.position!.line,
      diagnostic.position!.column,
    ])
    .sort(byTuple);
  const actual = tuples(formatReport(imported.diagnostics)).sort(byTuple);

  assert.equal(actual.length, imported.diagnostics.length, 'no finding is dropped or duplicated');
  assert.deepEqual(actual, expected);
});

test('groups use the canonical order and empty groups are omitted', () => {
  const diagnostics = [
    failed(5),
    flagged(4),
    skipped('copy-data', 'COPY app.t', 3),
    skipped('psql-meta-command', '\\echo', 2),
    skipped('unsupported-statement', 'app.v', 1),
  ];
  const groups = groupDiagnostics(diagnostics);

  assert.deepEqual(
    groups.map((group) => group.key),
    [...REPORT_GROUP_ORDER],
  );
  assert.equal(
    formatReport(diagnostics).split('\n\n').length,
    5,
    'five blocks, one blank line apart',
  );

  const onlyOne = groupDiagnostics([skipped('copy-data', 'COPY app.t', 1)]);

  assert.deepEqual(
    onlyOne.map((group) => group.key),
    ['skip/copy-data'],
  );
});

test('rows within a group keep the importer order rather than being sorted again', () => {
  const first = skipped('unsupported-statement', 'app.z_v_idx', 1);
  const second = skipped('unsupported-statement', 'app.a_v_idx', 2);
  const groups = groupDiagnostics([first, second]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.diagnostics, [first, second]);
  assert.deepEqual(
    tuples(formatReport([first, second])).map((tuple) => tuple[2]),
    ['app.z_v_idx', 'app.a_v_idx'],
  );
});

test('an unmapped diagnostic code throws instead of vanishing', () => {
  const future = {
    kind: 'skip',
    code: 'future-code',
    object: 'app.x',
    message: 'a future finding',
    position: at(1),
  } as unknown as Diagnostic;

  assert.throws(() => groupDiagnostics([future]), /Unhandled report diagnostic code: future-code/);
  assert.throws(() => formatReport([future]), /Unhandled report diagnostic code: future-code/);
});

test('a clean import prints exactly No findings. with a trailing newline', () => {
  assert.equal(formatReport([]), 'No findings.\n');
});

test('a control character in an object name is printed verbatim (v1 limitation)', () => {
  const object = 'public.we\tird';
  const message = `skipped CREATE TRIGGER ${object}`;
  const diagnostic: Diagnostic = {
    kind: 'skip',
    code: 'unsupported-statement',
    object,
    message,
    position: at(1),
  };

  const line = formatReport([diagnostic]).trimEnd();

  assert.ok(line.includes(message), 'the message is never silently rewritten');
  // The tab appears twice — in the object field and again inside the verbatim message.
  assert.equal(line.split('\t').length, 5, 'embedded tabs break the one-line shape in v1');
});
