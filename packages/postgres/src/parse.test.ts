import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDump } from './parse.ts';

/**
 * Tests for the per-statement parse leg. The dump fixtures are fabricated, not real client data;
 * expected positions are computed from the fixture text so they cannot drift from the layout.
 */

/**
 * Absolute position of `offset`, mirroring the line-break rules of `parse.ts`/`preprocess.ts`:
 * `\r\n` counts as one break, a bare `\r` is also a break, and an offset on the `\n` of a pair
 * resolves to the line the pair ends.
 */
const positionAt = (text: string, offset: number) => {
  let line = 1;
  let lineStart = 0;
  let index = 0;

  while (index <= text.length) {
    if (index === offset) return { offset, line, column: offset - lineStart + 1 };
    if (index === text.length) break;

    const character = text[index]!;
    if (character === '\n') {
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }
    if (character === '\r') {
      index += 1;
      if (text[index] === '\n') {
        if (index === offset) return { offset, line, column: offset - lineStart + 1 };
        index += 1;
      }
      line += 1;
      lineStart = index;
      continue;
    }
    index += 1;
  }

  return { offset, line, column: offset - lineStart + 1 };
};

const positionOf = (text: string, needle: string) => {
  const offset = text.indexOf(needle);
  assert.ok(offset >= 0, `fixture contains ${needle}`);
  return positionAt(text, offset);
};

test('parses a dump statement by statement and isolates a failure in the middle', async () => {
  const lines = [
    String.raw`\restrict abc123`,
    `SET statement_timeout = 0;`,
    `SET client_encoding = 'UTF8';`,
    `CREATE TABLE public.users (`,
    `    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,`,
    `    name text NOT NULL,`,
    `    settings jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `);`,
    `CREATE FUNCTION public.bump(value integer) RETURNS integer`,
    `    LANGUAGE plpgsql`,
    `    AS $$`,
    `BEGIN`,
    `    -- semicolons; stay inside the body`,
    `    RETURN value + 1;`,
    `END;`,
    `$$;`,
    `CREATE TABLE public.broken (id bigint UNSIGNED);`,
    `INSERT INTO public.users (name) VALUES ('alice; bob');`,
    `SELECT count(*) FROM public.users;`,
    `COPY public.users (id, name) FROM stdin;`,
    '1\talice',
    '2\tback\\slash',
    '\\.',
    `SELECT 2;`,
    String.raw`\unrestrict abc123`,
  ];
  const dump = lines.join('\n');
  const result = await parseDump(dump);

  const expectedSql = [
    `SET statement_timeout = 0;`,
    `SET client_encoding = 'UTF8';`,
    lines.slice(3, 8).join('\n'),
    lines.slice(8, 16).join('\n'),
    `INSERT INTO public.users (name) VALUES ('alice; bob');`,
    `SELECT count(*) FROM public.users;`,
    `SELECT 2;`,
  ];

  assert.deepEqual(
    result.statements.map((statement) => statement.sql),
    expectedSql,
  );
  for (const statement of result.statements) {
    assert.equal(statement.result.stmts?.length, 1, `${statement.sql} parses to one statement`);
    assert.equal(
      dump.slice(statement.start.offset, statement.end.offset),
      statement.sql,
      'the statement span matches the dump',
    );
  }
  assert.equal(
    result.statements.at(-1)?.sql,
    'SELECT 2;',
    'statements after the failure are still parsed',
  );

  assert.equal(result.failures.length, 1);
  const [failure] = result.failures;
  assert.ok(failure, 'the failure is present');
  assert.deepEqual(failure.position, positionOf(dump, `CREATE TABLE public.broken`));
  assert.deepEqual(failure.cursor, positionOf(dump, 'UNSIGNED'));
  assert.match(failure.message, /syntax error at or near "UNSIGNED"/);

  assert.deepEqual(
    result.diagnostics.map(({ kind, name, position }) => ({ kind, name, position })),
    [
      {
        kind: 'psql-meta-command',
        name: String.raw`\restrict`,
        position: positionOf(dump, String.raw`\restrict`),
      },
      {
        kind: 'copy',
        name: 'COPY public.users',
        position: positionOf(dump, 'COPY public.users'),
      },
      {
        kind: 'psql-meta-command',
        name: String.raw`\unrestrict`,
        position: positionOf(dump, String.raw`\unrestrict`),
      },
    ],
  );
});

test('maps the error cursor through multibyte characters in the same statement', async () => {
  const dump = [
    `SELECT 'héllo wörld' AS greeting;`,
    `SELECT '😀😀' AS emoji;`,
    `INSERT INTO public.t (name) VALUES ('😀😀 wörld') RETURNING;`,
    `SELECT 2;`,
  ].join('\n');
  const result = await parseDump(dump);

  assert.deepEqual(
    result.statements.map((statement) => statement.sql),
    [`SELECT 'héllo wörld' AS greeting;`, `SELECT '😀😀' AS emoji;`, 'SELECT 2;'],
  );

  assert.equal(result.failures.length, 1);
  const [failure] = result.failures;
  assert.ok(failure, 'the failure is present');
  assert.deepEqual(failure.position, positionOf(dump, 'INSERT INTO public.t'));

  // libpg-query reports a code point offset (the two emoji count once each); the expected dump
  // position is the UTF-16 offset of the offending `;`, so this pins the conversion.
  const cursorOffset = dump.indexOf('RETURNING;') + 'RETURNING'.length;
  assert.equal(dump[cursorOffset], ';', 'fixture cursor points at the semicolon');
  assert.deepEqual(failure.cursor, positionAt(dump, cursorOffset));
  assert.equal(failure.cursor?.line, 3);
  assert.match(failure.message, /syntax error at or near ";"/);
});

test('reports failures in dump order with CRLF-accurate positions', async () => {
  const dump = [
    `SET statement_timeout = 0;`,
    `CREATE TABLE public.first_broken (id bigint UNSIGNED);`,
    `SELECT 1;`,
    `CREATE TABLE public.second_broken (id bigint UNSIGNED);`,
    `SELECT 2;`,
  ].join('\r\n');

  const result = await parseDump(dump);

  assert.deepEqual(
    result.statements.map((statement) => statement.sql),
    ['SET statement_timeout = 0;', 'SELECT 1;', 'SELECT 2;'],
  );

  assert.equal(result.failures.length, 2);
  const [first, second] = result.failures;
  assert.ok(first && second, 'both failures are reported');

  const firstBrokenOffset = dump.indexOf('CREATE TABLE public.first_broken');
  const firstUnsignedOffset = dump.indexOf('UNSIGNED');
  const secondBrokenOffset = dump.indexOf('CREATE TABLE public.second_broken');
  const secondUnsignedOffset = dump.indexOf('UNSIGNED', firstUnsignedOffset + 1);

  assert.deepEqual(first.position, positionAt(dump, firstBrokenOffset));
  assert.deepEqual(first.cursor, positionAt(dump, firstUnsignedOffset));
  assert.deepEqual(second.position, positionAt(dump, secondBrokenOffset));
  assert.deepEqual(second.cursor, positionAt(dump, secondUnsignedOffset));

  // `\r\n` counts as one line break, so the two failing statements sit on lines 2 and 4.
  assert.deepEqual(
    [first.position.line, first.cursor?.line, second.position.line, second.cursor?.line],
    [2, 2, 4, 4],
  );
  assert.equal(first.position.column, 1);
  assert.equal(second.position.column, 1);
  assert.ok(
    (first.cursor?.offset ?? 0) < secondBrokenOffset,
    'failures are reported in dump order',
  );

  assert.match(first.message, /syntax error at or near "UNSIGNED"/);
  assert.match(second.message, /syntax error at or near "UNSIGNED"/);
});

test('returns empty results for empty and whitespace-only input', async () => {
  for (const text of ['', '   \n\t\n', '-- comment only\n']) {
    const result = await parseDump(text);
    assert.deepEqual(
      result,
      { statements: [], failures: [], diagnostics: [] },
      JSON.stringify(text),
    );
  }
});

test('reports a merged slice that parses to several statements as one failure', async () => {
  // With a custom `UESCAPE`, PostgreSQL closes the `U&'…'` literal at the quote the splitter
  // treats as backslash-escaped, so libpg-query sees three statements in one preprocessor slice.
  const dump = String.raw`SELECT U&'a\' UESCAPE '!'; SELECT 1; SELECT 'tail';`;
  const result = await parseDump(dump);

  assert.deepEqual(result.statements, []);
  assert.deepEqual(result.failures, [
    {
      position: { offset: 0, line: 1, column: 1 },
      message: 'expected one statement, parsed 3',
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
});
