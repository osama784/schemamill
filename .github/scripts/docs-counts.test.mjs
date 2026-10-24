import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyToken,
  countAlwaysOnLiveSubtests,
  countPostgresTests,
  deriveActuals,
  extractLineClaims,
  findStaleClaims,
  formatReport,
  isScannedDoc,
  loadActuals,
  parseTablePhases,
  resolveExitCode,
  stripParentheses,
} from './docs-counts.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Copied verbatim from the docs at base fe55f35. Extraction is independent of freshness: these
// fixtures pin the literal lines and the historical 315, not today's actual.
const CONSTRAINTS_INDEXES_63 =
  "- **Live PostgreSQL evidence** — the gated suite on PostgreSQL 16.15 is 315 tests across 45 scenes, 3 skipped — the three PostgreSQL 18 scenes, skipped by name — and all 45 run on the CI's PostgreSQL 18. Five scenes are new and each round-trips build → migrate → dump → import → empty diff: `constraint-create` (named and unnamed, single- and multi-column unique and check constraints, canonicalized to table level, with `pg_constraint` name spot-checks and an import check that no constraint-backed index is modeled as a standalone `Index`), `index-create` (a plain and a unique standalone index; raw target SQL adds a partial and an expression index the model cannot represent, and the import skips them whole and by name so the migrated and target imports still agree), `index-concurrently` (a transactional column add, a standalone `CREATE INDEX CONCURRENTLY`, and a second transactional index create; the plan partitions them `wrapped / standalone / wrapped`, the catalog proves the built index `indisvalid`, and both imports prove `CONCURRENTLY` never survives a dump), `unnamed-index-round-trip` (a target declaring an unnamed single-column, multi-column, and `CONCURRENTLY`-built index; `pg_indexes` pins the server-generated `t_a_b_idx`, `t_age_idx`, and `t_note_idx`, and both imports prove every index came back unnamed with its structure intact), and `non-public-index-drop` (an `app.probe` table whose named and server-named indexes the target removes; the scene's setup SQL creates the `app` schema in both databases, and the migration's `<schema>.<name>` drops apply under `psql ON_ERROR_STOP=1` and round-trip to an empty diff).";
const CONSTRAINTS_INDEXES_43 =
  'Eight new step kinds: `add-unique-constraint`, `drop-unique-constraint`, `add-check-constraint`, `drop-check-constraint`, `create-index`, `drop-index`, and the non-transactional `create-index-concurrently` and `drop-index-concurrently`. The step union is twenty-six kinds.';
const CONSTRAINTS_INDEXES_45 =
  "The table phases are now eighteen, nine more than the first slice's nine. Drops sit in table phases 2–4 in the order `drop-index` → `drop-check-constraint` → `drop-unique-constraint`, after `drop-foreign-key` and before `drop-table`, so a constraint or index on a surviving table leaves before the table or column drops that would take its columns away. Creates sit in phases 15–17 in the order `add-unique-constraint` → `add-check-constraint` → `create-index`, after `add-primary-key` and before `add-foreign-key`, so every member attaches only once its columns exist. Changed constraints and indexes decompose into the matching drop and add halves; a removed table or column carries its constraints and indexes away in that drop, so no separate drop step is emitted for them. The step-union comment in `plan.ts` carries the full numbering.";
const CONSTRAINTS_INDEXES_61 =
  '- **Unit and golden tests** — core tests pin the model ordering, the constraint and index pairing (ordered-column identity, cancellation including the name, absent-versus-empty names, duplicate-name indexes, flag-only no-ops), the added-table decomposition, and the eighteen-phase order; `packages/postgres/src/render.test.ts` pins the eight rendered forms, the synthesized drop names, the schema-qualified index drops, and the one-blank-line separator between groups, with the new goldens `constraints.sql`, `indexes.sql`, `index-concurrent.sql`, and `multi-group.sql`; `packages/cli/src/format.test.ts` pins the multi-group header, section lines, and continuous numbering.';
const IDENTITY_69 =
  'On PostgreSQL 16.15 the live suite is 315 tests across 45 scenes, 3 skipped — the three PostgreSQL 18 scenes skip with a named reason — and the `verify-postgres` CI job runs the same harness against PostgreSQL 18, where all 45 run.';
const IDENTITY_22 = '4. **Table operations** — the nine table phases, unchanged.';
const INTROSPECTION_ATTRIBUTES_5 =
  "The tracer shipped in [#55](https://github.com/osama784/schemamill/issues/55) (merge `d3ca120`; [ADR 0011](../adr/0011-introspection-transport.md)): `catalogReader` reads tables, columns, and primary keys in one read-only `psql` batch, and catalog state it meets but cannot represent — defaults, generation, identity, persistence, explicit collation, storage, and compression — is flagged, never silent. [#71](https://github.com/osama784/schemamill/issues/71) collects the follow-ups and #55's frozen brief (§D10) names the same list. This slice shipped in [#77](https://github.com/osama784/schemamill/issues/77), its durable decisions recorded in [ADR 0015](../adr/0015-column-attributes-travel-the-model.md): column defaults and the attribute representation now travel the whole path — `Column` carries `collation`, `storage`, and `compression`, each present only when something states it, and `Table` carries `persistence` (`unlogged`; absent means `LOGGED`) — import reads a dump's default text, inline `COLLATE` and `STORAGE`/`COMPRESSION` qualifiers, post-data `SET STORAGE`/`SET COMPRESSION`, `CREATE UNLOGGED TABLE`, and `SET LOGGED`/`SET UNLOGGED`, the plan renders `CREATE UNLOGGED TABLE`, inline `COLLATE`, and post-data `ALTER TABLE ONLY … SET STORAGE`/`SET COMPRESSION` with their `DEFAULT`/`default` resets, with a merged `TYPE` statement restating what a type change resets, and the catalog reads `pg_attrdef`/`pg_get_expr` defaults and the explicit-only attribute state. Introspection cannot recover declarations — the catalog reports effective state, not the DDL that produced it — so canonicalization rules are part of the design, and the dump-import congruence (an introspected model `diff`-empty and deep-equal against the dump import) is the acceptance bar, now met for the covered states: on PostgreSQL 16.15 the gated suite is 315 tests across 45 scenes, 3 skipped — the three PostgreSQL 18 scenes, skipped by name — and all 45 run on the CI's PostgreSQL 18. The new `column-attributes` scene (minServerMajor 16) round-trips defaults added, changed, and removed, collations added, changed between the system and a user spelling, and removed, storage changes and a removal, `pglz` compression added and removed, a simultaneous type-and-collation change, and persistence flipped both ways, with the physical catalog values checked, and `introspection-flags` pins the covered flags gone and the deferred set kept.";
const INTROSPECTION_32 =
  "- The tracer scene is green in the gated suite, and a live run summary (PostgreSQL versions, scene names, pass counts) is recorded on the slice's tracker issue — [#55](https://github.com/osama784/schemamill/issues/55) carries the local PostgreSQL 16.15 run (34 scenes at the time) and the CI `verify-postgres` run on PostgreSQL 18. The suite has since grown to 45 scenes; on PostgreSQL 16.15 it is 315 tests with the three PostgreSQL 18 scenes skipping by name, and all 45 run on the CI's PostgreSQL 18.";
const TRANSACTIONS_9 =
  "**In:** `Plan.groups: readonly TransactionGroup[]`; `TransactionGroup = { start, end, transactional }` — half-open indices into `steps`, with non-empty groups tiling `0..steps.length` in order and `transactional: false` marking a standalone group that applies outside a transaction; the compile-time exhaustive `TRANSACTIONAL: Record<Step['kind'], boolean>` classification beside the step union, now covering all twenty-six kinds; the coalescing function `groupSteps` and its predicate parameter as the test seam; `plan()` computing the groups once; `renderSql` walking the groups and wrapping each transactional one; the `plan` command's transaction-labeled headers, single-group and multi-group; and the always-on live rollback proof and its falsification.";
const TRANSACTIONS_17 =
  "Transaction safety is a property of a step's kind, decided beside the step union. `TRANSACTIONAL` is a `Record<Step['kind'], boolean>` — compile-time exhaustive, so adding a kind to the union without classifying it fails the build — and all twenty-six current kinds are covered: the two concurrent index kinds, `create-index-concurrently` and `drop-index-concurrently`, are `false`, and the other twenty-four are transactional — `create-table`, `drop-table`, `add-column`, `drop-column`, `alter-column`, `drop-not-null`, `add-not-null`, `alter-persistence`, `add-identity`, `drop-identity`, `alter-identity`, `add-primary-key`, `drop-primary-key`, `add-foreign-key`, `drop-foreign-key`, `add-unique-constraint`, `drop-unique-constraint`, `add-check-constraint`, `drop-check-constraint`, `create-index`, `drop-index`, `create-sequence`, `drop-sequence`, and `alter-sequence`.";
const TRANSACTIONS_33 =
  "- **Unit tests** — `packages/core/src/plan.test.ts` pins the classification (all twenty-six kinds listed, the twenty-four transactional asserted `true` and the two concurrent kinds `false`, their keys exactly `TRANSACTIONAL`'s), coalescing with a synthetic classification (`[T, T, F, T]` → `[{ 0, 2, true }, { 2, 3, false }, { 3, 4, true }]`), tiling and non-emptiness, an all-transactional step list as one group, an all-standalone classification as one group per step, an empty step list as no groups, and the plan-level partition; `assertPlan` computes the expected groups for every existing plan case.";
const TRANSACTIONS_44 =
  '- The classification test names all twenty-six kinds, and every unit test above passes.';

const SEQUENCES_21_REWRITE =
  "3. **Table operations** — the first slice's nine phases have grown to eighteen table phases.";

function claimsOf(line) {
  return extractLineClaims(line)
    .claims.map((claim) => `${claim.name}=${claim.value}`)
    .sort();
}

function errorsOf(line) {
  return extractLineClaims(line).errors.map((error) => error.message);
}

test('extracts every claim on the four live-count lines', () => {
  const live = ['allRun=45', 'liveScenes=45', 'liveSkipped=3', 'liveTests=315', 'pg18Scenes=3'];

  assert.deepEqual(claimsOf(CONSTRAINTS_INDEXES_63), live);
  assert.deepEqual(claimsOf(IDENTITY_69), live);
  assert.deepEqual(claimsOf(INTROSPECTION_ATTRIBUTES_5), live);
  assert.deepEqual(claimsOf(INTROSPECTION_32), [
    'allRun=45',
    'liveScenes=45',
    'liveTests=315',
    'pg18Scenes=3',
  ]);
});

test('strips parenthetical history before matching', () => {
  assert.match(INTROSPECTION_32, /\(34 scenes at the time\)/);
  assert.doesNotMatch(stripParentheses(INTROSPECTION_32), /\(34 scenes at the time\)/);
  assert.ok(!claimsOf(INTROSPECTION_32).includes('liveScenes=34'));
  assert.deepEqual(
    claimsOf('The suite has since grown to 45 scenes; on PostgreSQL 16.15 it is 315 tests.'),
    ['liveScenes=45', 'liveTests=315'],
  );
});

test('extracts the table-phase claims and no comparison deltas', () => {
  assert.deepEqual(claimsOf(CONSTRAINTS_INDEXES_45), ['tablePhases=18']);
  assert.deepEqual(claimsOf(CONSTRAINTS_INDEXES_61), ['tablePhases=18']);
  assert.deepEqual(claimsOf(IDENTITY_22), ['tablePhases=9']);
  assert.deepEqual(claimsOf(SEQUENCES_21_REWRITE), ['tablePhases=18']);

  assert.deepEqual(claimsOf("nine more than the first slice's nine"), []);
  assert.deepEqual(claimsOf('eight plan step kinds'), []);
  assert.deepEqual(claimsOf('five new scenes'), []);
});

test('extracts the step-kind and transactional claims', () => {
  assert.deepEqual(claimsOf(CONSTRAINTS_INDEXES_43), ['stepKinds=26']);
  assert.deepEqual(claimsOf(TRANSACTIONS_9), ['stepKinds=26']);
  assert.deepEqual(claimsOf(TRANSACTIONS_17), ['stepKinds=26', 'transactional=24']);
  assert.deepEqual(claimsOf(TRANSACTIONS_33), ['stepKinds=26', 'transactional=24']);
  assert.deepEqual(claimsOf(TRANSACTIONS_44), ['stepKinds=26']);
});

test('ignores changelog-like snapshots and non-scanned files', () => {
  assert.deepEqual(
    claimsOf(
      '- **Live suite** — 290/41/2 on PostgreSQL 16.15 ([#77](https://github.com/osama784/schemamill/issues/77)).',
    ),
    [],
  );
  assert.equal(isScannedDoc('CHANGELOG.md'), false);
  assert.equal(isScannedDoc('docs/adr/0016-catalog-constraint-canonicalization.md'), false);
  assert.equal(isScannedDoc('docs/plans/identity.md'), true);
});

test('parses digits and number words 0 through 99, and errors on unknown words', () => {
  assert.deepEqual(classifyToken('twenty-six'), { value: 26 });
  assert.deepEqual(classifyToken('twenty-four'), { value: 24 });
  assert.deepEqual(classifyToken('eighteen'), { value: 18 });
  assert.deepEqual(classifyToken('nine'), { value: 9 });
  assert.deepEqual(classifyToken('zero'), { value: 0 });
  assert.deepEqual(classifyToken('ninety-nine'), { value: 99 });
  assert.deepEqual(classifyToken('315'), { value: 315 });
  assert.deepEqual(classifyToken('the'), { stopword: true });
  assert.deepEqual(classifyToken('many'), { error: '"many" is not a number' });

  assert.deepEqual(errorsOf('The step union is many kinds.'), [
    'stepKinds: "many" is not a number',
  ]);
  assert.deepEqual(claimsOf('The step union is many kinds.'), []);
});

test('table-phase parser requires a contiguous numbered list', () => {
  const contiguous = [
    '/**',
    ' * The table phases inside phase 4 are numbered as before:',
    ' *',
    ' * 1. drop-foreign-key',
    ' *    a wrapped description',
    ' * 2. drop-index',
    ' * 3. add-column',
    ' *',
    ' * Within a phase, steps keep their order.',
    ' */',
  ].join('\n');
  assert.equal(parseTablePhases(contiguous), 3);

  const gapped = contiguous.replace(' * 3. add-column', ' * 4. add-column');
  assert.throws(() => parseTablePhases(gapped), /table phases are not contiguous/);
  assert.throws(
    () => parseTablePhases('/** no numbered list here */'),
    /table phase heading not found/,
  );
});

test('counts postgres tests and always-on live subtests', () => {
  const sources = [
    [
      "test('one', () => {});",
      "  test('two', { skip: false }, () => {});",
      "// test('not a top-level call');",
      "  t.test('not top level either', () => {});",
    ].join('\n'),
    "test('three', () => {});",
  ];
  assert.equal(countPostgresTests(sources), 3);

  const liveSource = [
    "test('outer', async (t) => {",
    '  for (const scene of scenes) {',
    '    await t.test(scene.name, async () => {});',
    '  }',
    "  await t.test('one', async () => {});",
    "  await t.test('two', async () => {});",
    '});',
  ].join('\n');
  assert.equal(countAlwaysOnLiveSubtests(liveSource), 2);
});

test('derives the live-suite total from its printed components', () => {
  const actuals = deriveActuals({
    transactional: { a: true, b: true, c: false },
    scenes: [{ name: 'a' }, { name: 'b', minServerMajor: 18 }],
    tablePhases: 18,
    postgresTests: 269,
    alwaysOnLiveSubtests: 3,
  });

  assert.equal(actuals.stepKinds, 3);
  assert.equal(actuals.transactional, 2);
  assert.equal(actuals.concurrent, 1);
  assert.equal(actuals.skippedOnPg16, 1);
  assert.equal(actuals.liveSuiteTests, 269 + 2 + 3);
});

test('formats actuals, stale claims, errors, and the summary', () => {
  const actuals = {
    stepKinds: 26,
    transactional: 24,
    concurrent: 2,
    tablePhases: 18,
    scenes: 45,
    postgresTests: 269,
    alwaysOnLiveSubtests: 3,
    liveSuiteTests: 317,
    skippedOnPg16: 3,
  };
  const claims = [
    { name: 'liveTests', value: 315, file: 'docs/plans/x.md', line: 7 },
    { name: 'tablePhases', value: 18, file: 'docs/plans/y.md', line: 9 },
  ];
  const stale = findStaleClaims(claims, actuals);
  assert.deepEqual(stale, [claims[0]]);

  const lines = formatReport({
    actuals,
    claims,
    stale,
    errors: [{ file: 'docs/plans/z.md', line: 3, message: 'tablePhases: "many" is not a number' }],
  });

  assert.ok(lines.includes('docs-counts: actual live-suite tests 317 (269 + 45 + 3)'));
  assert.ok(lines.includes('docs-counts: docs/plans/x.md:7 liveTests claimed 315 actual 317'));
  assert.ok(
    lines.includes('docs-counts: error docs/plans/z.md:3 tablePhases: "many" is not a number'),
  );
  assert.equal(lines.at(-1), 'docs-counts: 2 claims checked, 1 stale');
});

test('--check fails on stale claims or errors, report mode never does', () => {
  assert.equal(resolveExitCode({ check: true, staleCount: 1, errorCount: 0 }), 1);
  assert.equal(resolveExitCode({ check: true, staleCount: 0, errorCount: 0 }), 0);
  assert.equal(resolveExitCode({ check: true, staleCount: 0, errorCount: 1 }), 1);
  assert.equal(resolveExitCode({ check: false, staleCount: 1, errorCount: 1 }), 0);
});

test('real derivation imports the plan and scenes sources', async (t) => {
  let actuals;
  try {
    actuals = await loadActuals(REPO_ROOT);
  } catch (error) {
    try {
      await access(join(REPO_ROOT, 'packages/core/dist/index.js'));
    } catch {
      t.skip('packages/core/dist is not built');
      return;
    }
    throw error;
  }

  assert.ok(actuals.scenes > 0);
  assert.ok(actuals.tablePhases > 0);
  assert.equal(actuals.stepKinds, actuals.transactional + actuals.concurrent);
});
