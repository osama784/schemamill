import assert from 'node:assert/strict';
import { test } from 'node:test';

import { preprocessDump } from './preprocess.ts';

/**
 * Tests for the dump preprocessor. Each test pins the array of statement slices (text, order,
 * start/end positions) and the diagnostics emitted for the psql-level constructs that are
 * stripped or consumed. Backslash-heavy fixtures use `String.raw` so the dump text is readable.
 */

test('splits statements on top-level semicolons only', () => {
  const dump = `SELECT ';' AS semi, "weird;name" FROM t; SELECT 'it''s; here';`;
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    [`SELECT ';' AS semi, "weird;name" FROM t;`, `SELECT 'it''s; here';`],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [
      { offset: 0, line: 1, column: 1 },
      { offset: 41, line: 1, column: 42 },
    ],
  );
  assert.deepEqual(
    statements.map((statement) => statement.end),
    [
      { offset: 40, line: 1, column: 41 },
      { offset: 62, line: 1, column: 63 },
    ],
  );
  assert.deepEqual(diagnostics, []);
});

test('keeps semicolons inside dollar-quoted function bodies', () => {
  const dump = [
    `CREATE FUNCTION public.bump(value integer) RETURNS integer`,
    `    LANGUAGE plpgsql`,
    `    AS $$`,
    `BEGIN`,
    `    -- semicolons; and 'quotes' stay inside the body`,
    `    value := value + 1;`,
    `    RETURN value;`,
    `END;`,
    `$$;`,
    ``,
    `SELECT bump(1);`,
  ].join('\n');
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    [dump.slice(0, dump.indexOf('$$;') + 3), 'SELECT bump(1);'],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [
      { offset: 0, line: 1, column: 1 },
      { offset: dump.indexOf('SELECT bump(1);'), line: 11, column: 1 },
    ],
  );
  assert.deepEqual(
    statements.map((statement) => statement.end),
    [
      { offset: dump.indexOf('$$;') + 3, line: 9, column: 4 },
      { offset: dump.indexOf('SELECT bump(1);') + 15, line: 11, column: 16 },
    ],
  );
  assert.deepEqual(diagnostics, []);
});

test('keeps semicolons inside nested block comments', () => {
  const dump = `/* outer /* inner ; */ still outer ; */ SELECT 1;`;
  const { statements, diagnostics } = preprocessDump(dump);

  assert.equal(statements.length, 1);
  const [statement] = statements;
  assert.ok(statement, 'the statement is present');
  assert.equal(statement.sql, dump);
  assert.deepEqual(statement.start, { offset: 0, line: 1, column: 1 });
  assert.deepEqual(statement.end, { offset: dump.length, line: 1, column: dump.length + 1 });
  assert.deepEqual(diagnostics, []);
});

test('honors backslash escapes in escape-prefixed strings', () => {
  const eString = String.raw`SELECT E'it\'s; fine', 'plain'; SELECT 2;`;
  assert.deepEqual(
    preprocessDump(eString).statements.map((statement) => statement.sql),
    [String.raw`SELECT E'it\'s; fine', 'plain';`, 'SELECT 2;'],
  );

  const unicodeString = String.raw`SELECT U&'d\0061t; a'; SELECT 3;`;
  assert.deepEqual(
    preprocessDump(unicodeString).statements.map((statement) => statement.sql),
    [String.raw`SELECT U&'d\0061t; a';`, 'SELECT 3;'],
  );
});

test('does not treat positional parameters as dollar quotes', () => {
  const dump = `SELECT $1, $2 FROM t WHERE id = $1; SELECT 2;`;
  const { statements } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT $1, $2 FROM t WHERE id = $1;', 'SELECT 2;'],
  );
});

test('strips psql meta-commands and keeps position accuracy', () => {
  const dump = [
    String.raw`\restrict abc123`,
    `CREATE TABLE public.users (id bigint);`,
    ``,
    String.raw`\unrestrict abc123`,
    `SELECT 1;`,
  ].join('\n');
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['CREATE TABLE public.users (id bigint);', 'SELECT 1;'],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [
      { offset: 17, line: 2, column: 1 },
      { offset: 76, line: 5, column: 1 },
    ],
  );
  assert.deepEqual(
    statements.map((statement) => statement.end),
    [
      { offset: 55, line: 2, column: 39 },
      { offset: 85, line: 5, column: 10 },
    ],
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      kind: diagnostic.kind,
      name: diagnostic.name,
      position: diagnostic.position,
    })),
    [
      {
        kind: 'psql-meta-command',
        name: String.raw`\restrict`,
        position: { offset: 0, line: 1, column: 1 },
      },
      {
        kind: 'psql-meta-command',
        name: String.raw`\unrestrict`,
        position: { offset: 57, line: 4, column: 1 },
      },
    ],
  );
});

test('strips an indented meta-command line', () => {
  const dump = String.raw`  \connect dbname` + '\nSELECT 1;';
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT 1;'],
  );
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.ok(diagnostic, 'the diagnostic is present');
  assert.equal(diagnostic.name, String.raw`\connect`);
  assert.deepEqual(diagnostic.position, { offset: 2, line: 1, column: 3 });
});

test('consumes a COPY FROM stdin data block and resumes splitting after it', () => {
  const dump = [
    `--`,
    `-- Data for Name: users; Type: TABLE DATA; Schema: public;`,
    `--`,
    ``,
    `COPY public.users (id, name) FROM stdin;`,
    '1\talice',
    '2\tback\\slash',
    '\\\\.', // a data line containing `\\.`: a literal backslash-dot pair, not a terminator
    "4\t'quoted; semicolons'",
    '\\.', // the one and only terminator
    `SELECT count(*) FROM public.users;`,
  ].join('\n');
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT count(*) FROM public.users;'],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [{ offset: 158, line: 11, column: 1 }],
  );
  assert.deepEqual(
    statements.map((statement) => statement.end),
    [{ offset: 192, line: 11, column: 35 }],
  );
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.ok(diagnostic, 'the diagnostic is present');
  assert.equal(diagnostic.kind, 'copy');
  assert.equal(diagnostic.name, 'COPY public.users');
  assert.deepEqual(diagnostic.position, { offset: 66, line: 5, column: 1 });
  assert.match(diagnostic.message, /consumed 4 data lines/);
  assert.match(diagnostic.message, /terminating/);
});

test('names a quoted relation in the copy diagnostic', () => {
  const dump = 'COPY "odd name" (id) FROM stdin;\n\\.\nSELECT 1;';
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT 1;'],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [{ offset: 36, line: 3, column: 1 }],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.kind, 'copy');
  assert.equal(diagnostics[0]?.name, 'COPY "odd name"');
});

test('reports an unterminated COPY data block at end of input', () => {
  const dump = 'COPY public.users (id) FROM stdin;\n1\talice\n2\tbob\n';
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(statements, []);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.ok(diagnostic, 'the diagnostic is present');
  assert.equal(diagnostic.kind, 'copy');
  assert.equal(diagnostic.name, 'COPY public.users');
  assert.deepEqual(diagnostic.position, { offset: 0, line: 1, column: 1 });
  assert.match(diagnostic.message, /unterminated/);
  assert.match(diagnostic.message, /2 data lines/);
});

test('returns nothing for empty and comment-only input', () => {
  for (const dump of ['', ';', '-- banner\n-- more\n\n/* block ; */\n', '-- banner\n;']) {
    const { statements, diagnostics } = preprocessDump(dump);
    assert.deepEqual(statements, [], `no statements for ${JSON.stringify(dump)}`);
    assert.deepEqual(diagnostics, [], `no diagnostics for ${JSON.stringify(dump)}`);
  }
});

test('tracks line and column positions across multi-line statements', () => {
  const dump = `SELECT 1;\nSELECT\n  2;\n\nSELECT 3;`;
  const { statements } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT 1;', 'SELECT\n  2;', 'SELECT 3;'],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [
      { offset: 0, line: 1, column: 1 },
      { offset: 10, line: 2, column: 1 },
      { offset: 23, line: 5, column: 1 },
    ],
  );
  assert.deepEqual(
    statements.map((statement) => statement.end),
    [
      { offset: 9, line: 1, column: 10 },
      { offset: 21, line: 3, column: 5 },
      { offset: 32, line: 5, column: 10 },
    ],
  );
  for (const statement of statements) {
    assert.equal(
      dump.slice(statement.start.offset, statement.end.offset),
      statement.sql,
      'slice text matches its source span',
    );
  }
});

test('treats CRLF as one line break and preserves slice text', () => {
  const dump = 'SELECT\r\n  1;\r\nSELECT 2;\r\n';
  const { statements } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT\r\n  1;', 'SELECT 2;'],
  );
  assert.deepEqual(
    statements.map((statement) => statement.start),
    [
      { offset: 0, line: 1, column: 1 },
      { offset: 14, line: 3, column: 1 },
    ],
  );
  assert.deepEqual(
    statements.map((statement) => statement.end),
    [
      { offset: 12, line: 2, column: 5 },
      { offset: 23, line: 3, column: 10 },
    ],
  );
});

test('emits a final statement without a semicolon', () => {
  const dump = `SELECT 1;\nSELECT 2`;
  const { statements } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['SELECT 1;', 'SELECT 2'],
  );
  assert.deepEqual(statements[1]?.start, { offset: 10, line: 2, column: 1 });
  assert.deepEqual(statements[1]?.end, { offset: 18, line: 2, column: 9 });
});

test('leaves a COPY TO stdout statement as an ordinary slice', () => {
  const dump = `COPY public.users TO stdout;\nSELECT 1;`;
  const { statements, diagnostics } = preprocessDump(dump);

  assert.deepEqual(
    statements.map((statement) => statement.sql),
    ['COPY public.users TO stdout;', 'SELECT 1;'],
  );
  assert.deepEqual(diagnostics, []);
});
