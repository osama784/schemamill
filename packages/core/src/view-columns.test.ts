import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sameViewColumns, viewColumnIncompatibility, viewColumnsVerifiable } from './index.ts';
import type { ViewOutputColumn } from './model.ts';

/**
 * Tests for the view output-column preflight: the positive-evidence rule, canonical type text,
 * appending, and the four incompatible cases. An absent or unverifiable side is never grounds for
 * a destructive rewrite.
 */

/** Output columns from `[name, type]` pairs, in order. */
const columns = (...pairs: readonly (readonly [string, string])[]): ViewOutputColumn[] =>
  pairs.map(([name, type]) => ({ name, type }));

test('viewColumnsVerifiable requires a name and a canonical non-empty type on every entry', () => {
  assert.equal(viewColumnsVerifiable(undefined), false);
  assert.equal(viewColumnsVerifiable([]), false);
  assert.equal(viewColumnsVerifiable(columns(['a', 'integer'])), true);
  assert.equal(viewColumnsVerifiable(columns(['a', 'integer'], ['b', '   '])), false);
  assert.equal(viewColumnsVerifiable(columns(['a', ''])), false);
  assert.equal(viewColumnsVerifiable(columns(['', 'integer'])), false);
  assert.equal(viewColumnsVerifiable(columns(['', ''])), false);
});

test('viewColumnIncompatibility keeps replace-view for an absent or unverifiable side', () => {
  const verifiable = columns(['a', 'integer']);
  const unverifiable = columns(['a', '']);
  assert.deepStrictEqual(viewColumnIncompatibility(undefined, verifiable), { kind: 'compatible' });
  assert.deepStrictEqual(viewColumnIncompatibility(verifiable, undefined), { kind: 'compatible' });
  assert.deepStrictEqual(viewColumnIncompatibility(undefined, undefined), { kind: 'compatible' });
  assert.deepStrictEqual(viewColumnIncompatibility(unverifiable, verifiable), {
    kind: 'compatible',
  });
  assert.deepStrictEqual(viewColumnIncompatibility(verifiable, unverifiable), {
    kind: 'compatible',
  });
  assert.deepStrictEqual(
    viewColumnIncompatibility(columns(['a', 'integer'], ['b', '']), verifiable),
    {
      kind: 'compatible',
    },
  );
});

test('viewColumnIncompatibility appends trailing columns and canonicalizes type text', () => {
  assert.deepStrictEqual(
    viewColumnIncompatibility(columns(['a', 'integer']), columns(['a', 'integer'], ['b', 'text'])),
    { kind: 'compatible' },
  );
  assert.deepStrictEqual(
    viewColumnIncompatibility(
      columns(['a', '  CHARACTER   VARYING(10) ']),
      columns(['a', 'character varying(10)']),
    ),
    { kind: 'compatible' },
  );
  assert.deepStrictEqual(
    viewColumnIncompatibility(columns(['a', 'INTEGER']), columns(['a', 'integer'])),
    { kind: 'compatible' },
  );
});

test('viewColumnIncompatibility reports a renamed existing column', () => {
  assert.deepStrictEqual(
    viewColumnIncompatibility(
      columns(['a', 'integer'], ['b', 'text']),
      columns(['x', 'integer'], ['b', 'text']),
    ),
    { kind: 'renamed', column: 'a', reason: 'renamed to x' },
  );
});

test('viewColumnIncompatibility reports a dropped existing column', () => {
  assert.deepStrictEqual(
    viewColumnIncompatibility(columns(['a', 'integer'], ['b', 'text']), columns(['a', 'integer'])),
    { kind: 'dropped', column: 'b', reason: 'dropped' },
  );
});

test('viewColumnIncompatibility reports a reordered existing column', () => {
  assert.deepStrictEqual(
    viewColumnIncompatibility(
      columns(['a', 'integer'], ['b', 'text']),
      columns(['b', 'text'], ['a', 'integer']),
    ),
    { kind: 'reordered', column: 'b', reason: 'reordered from position 2 to 1' },
  );
});

test('viewColumnIncompatibility reports a retyped existing column', () => {
  assert.deepStrictEqual(
    viewColumnIncompatibility(columns(['a', 'integer']), columns(['a', 'text'])),
    { kind: 'retyped', column: 'a', reason: 'retyped from integer to text' },
  );
});

test('sameViewColumns ignores type whitespace and case but not order or names', () => {
  assert.equal(sameViewColumns(undefined, undefined), true);
  assert.equal(sameViewColumns(undefined, columns(['a', 'integer'])), false);
  assert.equal(sameViewColumns(columns(['a', ' INTEGER ']), columns(['a', 'integer'])), true);
  assert.equal(
    sameViewColumns(
      columns(['a', 'integer'], ['b', 'text']),
      columns(['b', 'text'], ['a', 'integer']),
    ),
    false,
  );
  assert.equal(sameViewColumns(columns(['a', 'integer']), columns(['x', 'integer'])), false);
});
