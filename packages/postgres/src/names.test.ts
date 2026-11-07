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
  makeObjectName,
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

/** An unnamed non-unique index on `columns`. */
const index = (columns: readonly string[]): Index => ({ unique: false, columns });

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
