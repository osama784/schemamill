import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CheckConstraint,
  ForeignKey,
  Index,
  TableIdentity,
  UniqueConstraint,
} from '@schemamill/core';

import {
  chooseNameAddition,
  indexElementNames,
  makeObjectName,
  pg18NotNullName,
  synthesizedCheckConstraintName,
  synthesizedForeignKeyName,
  synthesizedIndexName,
  synthesizedNotNullName,
  synthesizedPrimaryKeyName,
  synthesizedUniqueConstraintName,
  truncateIdentifier,
} from './names.ts';

/**
 * Tests for PostgreSQL's conventional-name mirror: the worked examples derive from the server
 * source (`makeObjectName`, `ChooseIndexNameAddition`, `ChooseForeignKeyConstraintNameAddition`,
 * `pg_mbcliplen` under UTF-8), so every expectation here is a byte-exact server form.
 */

/** A table identity named `name` in `public`. */
const table = (name: string): TableIdentity => ({ schema: 'public', name });

/** An unnamed non-unique index on `columns`, with optional `INCLUDE` and partial `WHERE`. */
const index = (columns: Index['columns'], include?: readonly string[], where?: string): Index => ({
  unique: false,
  columns,
  ...(include === undefined ? {} : { include }),
  ...(where === undefined ? {} : { where }),
});

/** An unnamed unique constraint on `columns`. */
const unique = (columns: readonly string[]): UniqueConstraint => ({ columns });

/** An unnamed check constraint with `expression`. */
const check = (expression: string): CheckConstraint => ({ expression });

/** An unnamed foreign key on `columns`, referencing `u.id`. */
const foreignKey = (columns: readonly string[]): ForeignKey => ({
  columns,
  referencedTable: table('u'),
  referencedColumns: ['id'],
});

test('truncateIdentifier leaves names of 63 bytes or fewer unchanged', () => {
  assert.equal(truncateIdentifier(''), '');
  assert.equal(truncateIdentifier('t'), 't');
  assert.equal(truncateIdentifier('a'.repeat(63)), 'a'.repeat(63));
  // 21 three-byte characters are exactly 63 bytes.
  assert.equal(truncateIdentifier('€'.repeat(21)), '€'.repeat(21));
});

test('truncateIdentifier clips to the longest 63-byte prefix', () => {
  assert.equal(truncateIdentifier('a'.repeat(64)), 'a'.repeat(63));
  // 32 two-byte characters are 64 bytes: the 32nd would cross the limit, so it is dropped.
  assert.equal(truncateIdentifier('é'.repeat(32)), 'é'.repeat(31));
  // A 64-byte mix: the clip stops before the 21st three-byte character, at 61 bytes.
  assert.equal(truncateIdentifier(`a${'€'.repeat(21)}`), `a${'€'.repeat(20)}`);
  // 16 four-byte characters are 64 bytes, so the clip keeps 15.
  assert.equal(truncateIdentifier('😀'.repeat(16)), '😀'.repeat(15));
});

test('truncateIdentifier is idempotent', () => {
  const long = `${'a'.repeat(70)}€${'b'.repeat(10)}`;
  const clipped = truncateIdentifier(long);
  assert.equal(truncateIdentifier(long), clipped);
  assert.equal(truncateIdentifier(clipped), clipped);
});

test('makeObjectName shrinks the longer part to fit 63 bytes', () => {
  // 1 + 1 + 57 + 4 = 63: the 100-byte column part gives up 6 bytes for the one-byte table.
  assert.equal(makeObjectName('t', 'x'.repeat(100), 'idx'), `t_${'x'.repeat(57)}_idx`);
  // 57 + 1 + 1 + 4 = 63: the 70-byte table gives up 6 bytes for the one-byte column.
  assert.equal(makeObjectName('t'.repeat(70), 'a', 'idx'), `${'t'.repeat(57)}_a_idx`);
  // 29 + 1 + 29 + 4 = 63: both parts shrink, alternating, and a tie shrinks name2.
  assert.equal(
    makeObjectName('t'.repeat(70), 'c'.repeat(40), 'idx'),
    `${'t'.repeat(29)}_${'c'.repeat(29)}_idx`,
  );
  // 29 + 1 + 28 + 5 = 63: `fkey` leaves 57 bytes, an odd budget, so the final tie is
  // observable — the source shrinks name2 and name1 keeps the extra byte.
  assert.equal(
    makeObjectName('a'.repeat(40), 'b'.repeat(40), 'fkey'),
    `${'a'.repeat(29)}_${'b'.repeat(28)}_fkey`,
  );
  // 58 + 5 = 63 with no second part: the table alone shrinks for `pkey`.
  assert.equal(makeObjectName('t'.repeat(70), null, 'pkey'), `${'t'.repeat(58)}_pkey`);
});

test('makeObjectName clips a part at a character boundary when the byte count falls inside one', () => {
  // The table pre-clips to 63 bytes (21 three-byte characters) and shrinks to 57 for the
  // one-byte column: 57 bytes is 19 whole characters, so the clip keeps 19.
  assert.equal(makeObjectName('€'.repeat(25), 'a', 'idx'), `${'€'.repeat(19)}_a_idx`);
  // The column part pre-clips to 63 bytes and shrinks to 57, again 19 whole characters.
  assert.equal(makeObjectName('t', '€'.repeat(25), 'idx'), `t_${'€'.repeat(19)}_idx`);
  // A chosen count inside a character: 58 bytes leaves 19 whole characters (57 bytes).
  assert.equal(makeObjectName('€'.repeat(25), null, 'pkey'), `${'€'.repeat(19)}_pkey`);
});

test('chooseNameAddition joins parts with underscores until the running length reaches 64', () => {
  assert.equal(chooseNameAddition([]), '');
  assert.equal(chooseNameAddition(['a']), 'a');
  assert.equal(chooseNameAddition(['a', 'b', 'c']), 'a_b_c');
  // Each part pre-clips to 63 bytes; the part that brings the running length to 64 or more is
  // the last one appended — the loop stops before any later part.
  assert.equal(chooseNameAddition(['x'.repeat(100), 'a']), `${'x'.repeat(63)}_a`);
  assert.equal(chooseNameAddition(['a'.repeat(63), 'b', 'c']), `${'a'.repeat(63)}_b`);
  // The boundary is exact: 62 + 1 + 1 = 64 stops the loop, so `c` is not appended.
  assert.equal(chooseNameAddition(['a'.repeat(62), 'b', 'c']), `${'a'.repeat(62)}_b`);
});

test('synthesized names keep their short forms byte-identical', () => {
  assert.equal(synthesizedIndexName(table('t'), index(['a'])), 't_a_idx');
  assert.equal(synthesizedIndexName(table('t'), index(['a', 'b'])), 't_a_b_idx');
  assert.equal(synthesizedPrimaryKeyName(table('t')), 't_pkey');
  assert.equal(synthesizedForeignKeyName(table('t'), foreignKey(['a', 'b'])), 't_a_b_fkey');
  assert.equal(synthesizedUniqueConstraintName(table('t'), unique(['a'])), 't_a_key');
  assert.equal(synthesizedCheckConstraintName(table('t'), check('a > 0')), 't_a_check');
  assert.equal(synthesizedCheckConstraintName(table('t'), check('a > b')), 't_check');
  assert.equal(synthesizedNotNullName('t', 'c'), 't_c_not_null');
});

test('synthesized names predict the server form for long inputs', () => {
  const long = 't'.repeat(70);
  assert.equal(synthesizedIndexName(table(long), index(['a'])), `${'t'.repeat(57)}_a_idx`);
  assert.equal(synthesizedPrimaryKeyName(table(long)), `${'t'.repeat(58)}_pkey`);
  assert.equal(
    synthesizedForeignKeyName(table(long), foreignKey(['a'])),
    `${'t'.repeat(56)}_a_fkey`,
  );
  assert.equal(
    synthesizedUniqueConstraintName(table(long), unique(['a'])),
    `${'t'.repeat(57)}_a_key`,
  );
  assert.equal(
    synthesizedCheckConstraintName(table(long), check('a > 0')),
    `${'t'.repeat(55)}_a_check`,
  );
  assert.equal(synthesizedNotNullName(long, 'a'), `${'t'.repeat(52)}_a_not_null`);
});

test('the PostgreSQL 18 not-null formula agrees with the import formula under UTF-8', () => {
  // PostgreSQL 18's ChooseConstraintName joins the unqualified relation name, the column, and
  // `not_null`, clipping both name parts at UTF-8 boundaries. The import formula mirrors the same
  // budget, so a name the server generates is the name the importer canonicalizes away.
  const pairs: readonly (readonly [string, string])[] = [
    ['t', 'c'],
    ['Mixed Case', 'café'],
    ['t'.repeat(70), 'a'],
    ['t', 'a'.repeat(70)],
    ['t'.repeat(40), 'a'.repeat(40)],
    ['é'.repeat(40), 'ß'.repeat(20)],
    ['t'.repeat(52), '🙂'.repeat(20)],
  ];
  for (const [tableName, column] of pairs) {
    assert.equal(pg18NotNullName(tableName, column), synthesizedNotNullName(tableName, column));
  }
});

test('the PostgreSQL 18 not-null name spends 53 bytes on the relation and column, never the label', () => {
  assert.equal(pg18NotNullName('t', 'c'), 't_c_not_null');
  assert.equal(pg18NotNullName('t'.repeat(70), 'a'), `${'t'.repeat(52)}_a_not_null`);
  assert.equal(pg18NotNullName('t', 'a'.repeat(70)), `t_${'a'.repeat(52)}_not_null`);
  // The longer part shrinks first; a tie alternates, ending one byte shorter on the relation.
  assert.equal(
    pg18NotNullName('x'.repeat(30), 'y'.repeat(30)),
    `${'x'.repeat(27)}_${'y'.repeat(26)}_not_null`,
  );
  // A multibyte character is never split: 52 of the 53 available bytes fits 26 two-byte letters.
  assert.equal(pg18NotNullName('é'.repeat(40), 'z'), `${'é'.repeat(26)}_z_not_null`);
});

test('indexElementNames labels columns, function calls, nullif, and opaque expressions', () => {
  assert.deepEqual(indexElementNames(index(['a', 'b'])), ['a', 'b']);
  const labels: readonly [string, string][] = [
    ['lower(email)', 'lower'],
    ['public.upper(name)', 'upper'],
    ['nullif(a, b)', 'nullif'],
    ['a + b', 'expr'],
    ['(lower(x))', 'lower'],
    ['"MixedCase"(x)', 'MixedCase'],
    ['lower(x)::text', 'expr'],
    ["lower(x) || 'y'", 'expr'],
    ['CASE WHEN a THEN b ELSE c END', 'expr'],
  ];
  for (const [expression, label] of labels) {
    assert.deepEqual(indexElementNames(index([{ expression }])), [label], expression);
  }
});

test('indexElementNames appends INCLUDE and dedupes with numeric suffixes', () => {
  assert.deepEqual(
    indexElementNames(
      index(['c', { expression: 'a + b' }, { expression: 'lower(x)' }], ['c', 'd']),
    ),
    ['c', 'expr', 'lower', 'c1', 'd'],
  );
  assert.deepEqual(indexElementNames(index([{ expression: 'a + b' }, { expression: 'c + d' }])), [
    'expr',
    'expr1',
  ]);
  // A literal `expr1` column cannot collide with a generated suffix.
  assert.deepEqual(
    indexElementNames(index([{ expression: 'a + b' }, { expression: 'c + d' }, 'expr1'])),
    ['expr', 'expr1', 'expr11'],
  );
});

test('indexElementNames truncates each label to fit 63 bytes minus its suffix', () => {
  const long = 'a'.repeat(70);
  assert.deepEqual(indexElementNames(index([long, long])), ['a'.repeat(63), `${'a'.repeat(62)}1`]);
  assert.deepEqual(indexElementNames(index([{ expression: `${'f'.repeat(70)}(x)` }])), [
    'f'.repeat(63),
  ]);
});

test('synthesizedIndexName uses element labels and INCLUDE, never the partial WHERE', () => {
  assert.equal(
    synthesizedIndexName(table('t'), index([{ expression: 'lower(email)' }, 'a'], ['c'], 'a > 0')),
    't_lower_a_c_idx',
  );
  assert.equal(synthesizedIndexName(table('t'), index([{ expression: 'a + b' }])), 't_expr_idx');
  assert.equal(
    synthesizedIndexName(
      table('t'),
      index([{ expression: 'lower(a)' }, { expression: 'upper(b)' }], ['lower_c']),
    ),
    't_lower_upper_lower_c_idx',
  );
});
