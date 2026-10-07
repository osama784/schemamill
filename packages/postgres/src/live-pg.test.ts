import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { diff, effectiveSequence, plan } from '@schemamill/core';
import type {
  CatalogReader,
  Diagnostic,
  Identity,
  Model,
  ReadResult,
  Sequence,
  SequenceIdentity,
  SequenceOwner,
} from '@schemamill/core';

import { catalogReader, importDump, renderSql } from './index.ts';
import { scenes } from './live-scenes.ts';
import type { LiveScene, SceneCheck, SceneIntrospection } from './live-scenes.ts';

/**
 * The live-PostgreSQL harness: every scene is built, migrated, dumped, imported back, and
 * compared against a database built directly from its target model.
 *
 * Gated on `SCHEMAMILL_TEST_PG_URL`, a libpq connection URI (for example
 * `postgresql://postgres:postgres@localhost:5432/postgres`, or the socket form
 * `postgresql:///postgres?host=/tmp/pgsock&port=5432`). Unset, the suite is skipped with a
 * reason, so `pnpm test` stays green without PostgreSQL. Set but unreachable, it fails loudly
 * rather than skipping. The harness spawns `psql` and `pg_dump` from `PATH` and adds no client
 * dependency of its own; the server must be PostgreSQL 13 or newer (`DROP DATABASE … FORCE`).
 *
 * Per scene, sequentially: both databases are created fresh and any raw `setupSql` the scene
 * declares is applied to both, for ambient state like a non-public schema; the baseline
 * database gets the build SQL for the baseline model (the plan from an empty model), the
 * target database the build SQL for the target model plus any raw `targetExtraSql` the scene
 * declares for objects the model cannot represent; the baseline database then gets
 * `renderSql(plan(baseline, target))`. The scene's plan checks run against that plan before any SQL, its catalog checks
 * run against the baseline database after its build, and its probes and remaining checks after
 * the migration. Both databases are dumped with `pg_dump --schema-only --no-owner
 * --no-privileges`, both dumps are imported, neither import may report an error diagnostic,
 * the modeled sequences and identity columns must come back exactly (see
 * `assertSequencesRetained` and `assertIdentitiesRetained`), the scene's import checks run
 * against both imported models (see `assertImportChecks`), and `diff` between the imported
 * models must be exactly empty. A scene that declares an `introspection` assertion is then read
 * back through the production `catalogReader` (see `assertIntrospection`). Databases are
 * dropped best-effort, so a failed scene still cleans up after itself.
 */

const execFileAsync = promisify(execFile);

/** The connection URI from the environment, or `undefined` when unset or empty. */
const pgUrl = process.env.SCHEMAMILL_TEST_PG_URL || undefined;

/**
 * Eight hex characters, computed once per run, that suffix every scene database this run
 * creates. Two harness runs against one cluster then never create or drop each other's
 * databases, and a crashed run can only leave behind its own token's databases.
 */
const runToken = randomBytes(4).toString('hex');

test(
  'live PostgreSQL: build, migrate, dump, import, compare',
  { skip: pgUrl === undefined ? 'SCHEMAMILL_TEST_PG_URL is not set' : false },
  async (t) => {
    if (pgUrl === undefined) return; // Unreachable: the test is skipped when the URL is unset.
    const baseUrl = validateBaseUrl(pgUrl);
    await assertReachable(baseUrl);

    const workDir = await mkdtemp(join(tmpdir(), 'schemamill-live-pg-'));
    try {
      for (const scene of scenes) {
        await t.test(scene.name, async () => {
          await runScene(baseUrl, workDir, scene);
        });
      }
      await t.test(
        'transaction rollback: a failed statement leaves no partial effect',
        async () => {
          await assertRollbackLeavesNoPartialEffect(baseUrl, workDir);
        },
      );
      await t.test(
        'falsification: without the wrappers a failed statement leaves partial effect',
        async () => {
          await assertStrippedWrappersLeavePartialEffect(baseUrl, workDir);
        },
      );
      await t.test(
        'falsification: wrapping the standalone concurrent build is refused',
        async () => {
          await assertConcurrentBuildRejectsWrapping(baseUrl, workDir);
        },
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

/**
 * The guard's state-skip allowance, without a live server. A dump carries the two state-only
 * statements only when sequence state is dumped (`SELECT setval(…)`) or restated
 * (`ALTER SEQUENCE … RESTART`); the harness dumps with `--schema-only`, which emits neither, so
 * this crafted dump is the committed exercise of `isSequenceStateSkip`: the allowance admits
 * the two state skips, and one structural sequence diagnostic still fails the guard.
 */
test('the sequence retention guard allows state-only skips and rejects structural diagnostics', async () => {
  const dump = [
    'CREATE SEQUENCE public.state_seq',
    '    START WITH 1',
    '    INCREMENT BY 1',
    '    NO MINVALUE',
    '    NO MAXVALUE',
    '    CACHE 1;',
    "SELECT pg_catalog.setval('public.state_seq', 7, true);",
    'ALTER SEQUENCE public.state_seq RESTART WITH 3;',
  ].join('\n');
  const imported = await importDump(dump);
  const scene: LiveScene = {
    name: 'state-only-skips',
    baseline: { tables: [], sequences: [] },
    target: {
      tables: [],
      sequences: [effectiveSequence({ schema: 'public', name: 'state_seq' })],
    },
  };

  assert.deepEqual(
    imported.diagnostics.map((diagnostic) => diagnostic.message),
    [
      "skipped SELECT setval('public.state_seq', 7, true)",
      'skipped ALTER SEQUENCE public.state_seq (RESTART)',
    ],
    'the crafted dump imports as exactly the two state-only skips',
  );

  // The state-only skips are allowed: the guard must not fail on this dump.
  assertSequencesRetained('crafted state-only dump', scene, imported);

  const structural: Diagnostic = {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'public.state_seq',
    message: 'skipped CREATE SEQUENCE public.state_seq (unsupported data type)',
  };
  assert.throws(
    () =>
      assertSequencesRetained('crafted structural dump', scene, {
        ...imported,
        diagnostics: [...imported.diagnostics, structural],
      }),
    /the import named structural sequence problems/,
    'a structural sequence diagnostic must fail the sequence retention guard',
  );
});

/** The base URI, checked to be a `postgresql:` URI that names a database. */
function validateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`SCHEMAMILL_TEST_PG_URL is not a URL: ${raw}`);
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(`SCHEMAMILL_TEST_PG_URL must be a postgresql:// URI: ${raw}`);
  }
  if (parsed.pathname.length <= 1) {
    throw new Error(`SCHEMAMILL_TEST_PG_URL must name a database, such as /postgres: ${raw}`);
  }
  return raw;
}

/** Proves the server answers before any scene runs; a set-but-dead URL fails loudly here. */
async function assertReachable(baseUrl: string): Promise<void> {
  try {
    await psql(baseUrl, ['-tA', '-c', 'select 1']);
  } catch (error) {
    throw new Error(
      `SCHEMAMILL_TEST_PG_URL is set but PostgreSQL is unreachable: ${reason(error)}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * One scene's whole round trip, against fresh databases named after the scene and this run's
 * token, so concurrent runs against one cluster never touch each other's databases.
 */
async function runScene(baseUrl: string, workDir: string, scene: LiveScene): Promise<void> {
  const slug = scene.name.replace(/[^a-z0-9]+/g, '_');
  const appliedDb = `schemamill_w6_${slug}_${runToken}`;
  const targetDb = `${appliedDb}_target`;
  const appliedUrl = withDatabase(baseUrl, appliedDb);
  const targetUrl = withDatabase(baseUrl, targetDb);

  try {
    await dropDatabase(baseUrl, appliedDb);
    await dropDatabase(baseUrl, targetDb);
    await createDatabase(baseUrl, appliedDb);
    await createDatabase(baseUrl, targetDb);

    const files = await writeSceneFiles(workDir, slug, scene);
    assertPlanChecks(scene);

    if (files.setup !== undefined) {
      await applyFile(appliedUrl, files.setup);
      await applyFile(targetUrl, files.setup);
    }
    await applyFile(appliedUrl, files.baselineBuild);
    await assertChecks(appliedUrl, scene.baselineChecks ?? []);
    await applyFile(targetUrl, files.targetBuild);
    await applyFile(appliedUrl, files.migration);
    for (const probe of scene.probes ?? []) {
      await psql(appliedUrl, ['-c', probe]);
    }
    await assertChecks(appliedUrl, scene.checks ?? []);

    const appliedDump = await dump(appliedUrl);
    const targetDump = await dump(targetUrl);
    await writeFile(files.appliedDump, appliedDump, 'utf8');
    await writeFile(files.targetDump, targetDump, 'utf8');

    const applied = await importDump(appliedDump);
    const expected = await importDump(targetDump);

    assertNoErrors(`${appliedDb}: imported after the migration`, applied);
    assertNoErrors(`${targetDb}: imported from the target model's build`, expected);
    assertSequencesRetained(`${appliedDb}: imported after the migration`, scene, applied);
    assertSequencesRetained(`${targetDb}: imported from the target model's build`, scene, expected);
    assertIdentitiesRetained(`${appliedDb}: imported after the migration`, scene, applied);
    assertIdentitiesRetained(
      `${targetDb}: imported from the target model's build`,
      scene,
      expected,
    );
    assertImportChecks(`${appliedDb}: imported after the migration`, scene, applied, 'applied');
    assertImportChecks(
      `${targetDb}: imported from the target model's build`,
      scene,
      expected,
      'target',
    );

    assert.deepEqual(
      diff(applied.model, expected.model),
      [],
      `${scene.name}: the migrated database does not match the database built from the target model`,
    );

    if (scene.introspection !== undefined) {
      await assertIntrospection(appliedUrl, scene.name, applied, scene.introspection);
    }
  } finally {
    await dropDatabase(baseUrl, appliedDb);
    await dropDatabase(baseUrl, targetDb);
  }
}

/**
 * The scene the two transaction tests corrupt. `primary-key-add`'s plan is the smallest
 * corruptible shape in the corpus: exactly two steps, `alter-column` (`SET NOT NULL`) then
 * `add-primary-key`, so retargeting the second statement at a missing relation fails only after
 * a real catalog effect has succeeded. The ordinary scene run pins the same two kinds through
 * its plan check; the transaction tests re-pin them so a planner change cannot quietly turn the
 * corruption into a no-op.
 */
function transactionScene(): LiveScene {
  const scene = scenes.find((candidate) => candidate.name === 'primary-key-add');
  assert.ok(scene !== undefined, 'the primary-key-add scene is part of the live corpus');
  return scene;
}

/**
 * The scene the concurrent falsification wraps. `index-concurrently`'s migration is the
 * corpus's only multi-group render — a transactional column add, a standalone
 * `CREATE INDEX CONCURRENTLY`, then a transactional index create — so wrapping the concurrent
 * line changes exactly the wrapper lines around one statement.
 */
function concurrentScene(): LiveScene {
  const scene = scenes.find((candidate) => candidate.name === 'index-concurrently');
  assert.ok(scene !== undefined, 'the index-concurrently scene is part of the live corpus');
  return scene;
}

/** The rendered migration for `scene` with exactly one statement corrupted. */
interface CorruptedMigration {
  /** The migration SQL, one statement retargeted at `missing`. */
  readonly sql: string;
  /** The relation the corrupted statement names, which never exists. */
  readonly missing: string;
}

/**
 * The relation the transaction tests retarget the scene's last statement at. A fresh baseline
 * database never contains it, so the statement fails deterministically with SQLSTATE 42P01
 * (`relation "…" does not exist`) after every earlier statement in the file has succeeded.
 */
const MISSING_RELATION = 'public.t_missing';

/**
 * Renders `scene`'s migration and corrupts exactly its last statement: the table reference is
 * replaced with `missing`, a relation that does not exist, so PostgreSQL fails the statement
 * with `relation "…" does not exist`. The plan is pinned first — two steps, `alter-column` then
 * `add-primary-key` — and the corruption is pinned to change exactly one rendered line, so the
 * failure is attributable to the retargeted statement and nothing else.
 */
function corruptLastStatement(scene: LiveScene, missing: string): CorruptedMigration {
  const steps = plan(scene.baseline, scene.target).steps;
  assert.deepEqual(
    steps.map((step) => step.kind),
    ['alter-column', 'add-primary-key'],
    `${scene.name}: the transaction tests require the two-step shape`,
  );

  const lines = renderSql(plan(scene.baseline, scene.target)).split('\n');
  const commit = lines.lastIndexOf('COMMIT;');
  assert.ok(commit > 0, `${scene.name}: the rendered migration must end with COMMIT;`);
  const statement = lines[commit - 1]!;
  const match = /^ALTER TABLE (\S+) (.*)$/.exec(statement);
  assert.ok(match !== null, `${scene.name}: the last statement must retarget a table`);
  assert.equal(match[1], 'public.t', `${scene.name}: the last statement targets public.t`);

  const corrupted = [...lines];
  corrupted[commit - 1] = `ALTER TABLE ${missing} ${match[2]!}`;
  let differing = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== corrupted[index]) differing += 1;
  }
  assert.equal(differing, 1, `${scene.name}: exactly one statement may be corrupted`);
  return { sql: corrupted.join('\n'), missing };
}

/** Applies `path` with `ON_ERROR_STOP=1`, expecting `psql` to refuse it; returns the failure. */
async function applyExpectingFailure(url: string, path: string): Promise<string> {
  try {
    await applyFile(url, path);
  } catch (error) {
    return reason(error);
  }
  throw new Error(`psql applied ${path}, but the corrupted migration must fail`);
}

/**
 * The rollback proof: build a fresh database from the scene's baseline, dump and import it as
 * the reference, apply the corrupted migration, require the failure to name the missing
 * relation, then re-dump, import, and require an empty diff against the baseline. The file
 * opened a transaction and never reached `COMMIT;`, so the connection close must have rolled
 * back the statement that succeeded before the failure — zero partial effect.
 */
async function assertRollbackLeavesNoPartialEffect(
  baseUrl: string,
  workDir: string,
): Promise<void> {
  const scene = transactionScene();
  const database = `schemamill_w6_txn_rollback_${runToken}`;
  const url = withDatabase(baseUrl, database);

  try {
    await dropDatabase(baseUrl, database);
    await createDatabase(baseUrl, database);

    const baselineFile = join(workDir, 'rollback.baseline.sql');
    await writeFile(
      baselineFile,
      renderSql(plan({ tables: [], sequences: [] }, scene.baseline)),
      'utf8',
    );
    await applyFile(url, baselineFile);
    const baseline = await importDump(await dump(url));
    assertNoErrors(`${database}: the baseline before the corrupted migration`, baseline);

    const corrupted = corruptLastStatement(scene, MISSING_RELATION);
    const migrationFile = join(workDir, 'rollback.corrupted.sql');
    await writeFile(migrationFile, corrupted.sql, 'utf8');
    const failure = await applyExpectingFailure(url, migrationFile);
    assert.ok(
      failure.includes(`relation "${corrupted.missing}" does not exist`),
      `${database}: the apply failed for the wrong reason: ${failure}`,
    );

    const after = await importDump(await dump(url));
    assertNoErrors(`${database}: the redump after the failed migration`, after);
    assert.deepEqual(
      diff(baseline.model, after.model),
      [],
      `${database}: the failed migration left partial state behind`,
    );
  } finally {
    await dropDatabase(baseUrl, database);
  }
}

/**
 * The falsification: apply the same corrupted migration to a freshly rebuilt baseline database
 * with every line exactly equal to `BEGIN;` or `COMMIT;` stripped. The same missing relation
 * must fail the run, and the earlier statement's effect must still be readable from the
 * catalog — `public.t.id` is NOT NULL — while the failing statement added no primary key. The
 * two runs differ only in the wrapper lines, so the rollback proof's empty diff is attributable
 * to them; without them the failure leaves partial state behind.
 */
async function assertStrippedWrappersLeavePartialEffect(
  baseUrl: string,
  workDir: string,
): Promise<void> {
  const scene = transactionScene();
  const database = `schemamill_w6_txn_stripped_${runToken}`;
  const url = withDatabase(baseUrl, database);

  try {
    await dropDatabase(baseUrl, database);
    await createDatabase(baseUrl, database);

    const baselineFile = join(workDir, 'stripped.baseline.sql');
    await writeFile(
      baselineFile,
      renderSql(plan({ tables: [], sequences: [] }, scene.baseline)),
      'utf8',
    );
    await applyFile(url, baselineFile);

    const corrupted = corruptLastStatement(scene, MISSING_RELATION);
    const allLines = corrupted.sql.split('\n');
    assert.deepEqual(
      allLines.filter((line) => line === 'BEGIN;' || line === 'COMMIT;'),
      ['BEGIN;', 'COMMIT;'],
      `${database}: the corrupted migration carries exactly one wrapper pair`,
    );
    const stripped = allLines.filter((line) => line !== 'BEGIN;' && line !== 'COMMIT;').join('\n');
    const migrationFile = join(workDir, 'stripped.corrupted.sql');
    await writeFile(migrationFile, stripped, 'utf8');

    const failure = await applyExpectingFailure(url, migrationFile);
    assert.ok(
      failure.includes(`relation "${corrupted.missing}" does not exist`),
      `${database}: the apply failed for the wrong reason: ${failure}`,
    );
    assert.equal(
      await query(
        url,
        "select is_nullable from information_schema.columns where table_schema = 'public'" +
          " and table_name = 't' and column_name = 'id'",
      ),
      'NO',
      `${database}: the statement before the failure must have persisted`,
    );
    assert.equal(
      await query(
        url,
        'select count(*) from pg_constraint' +
          " where conrelid = 'public.t'::regclass and contype = 'p'",
      ),
      '0',
      `${database}: the failing statement itself must not have applied`,
    );
  } finally {
    await dropDatabase(baseUrl, database);
  }
}

/**
 * The concurrent falsification: apply `index-concurrently`'s concurrent statement wrapped in
 * `BEGIN;`/`COMMIT;` to a freshly built baseline and require real PostgreSQL to refuse the run
 * — `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block — then apply the same
 * statement bare and require the index to become valid. The two runs differ only in the
 * wrapper lines, so the scene's bare render is load-bearing: without the standalone group the
 * concurrent build cannot apply at all. The rendered line is pinned first, including the blank
 * lines that make it a group of its own, so a renderer change cannot quietly turn the proof
 * into a no-op.
 */
async function assertConcurrentBuildRejectsWrapping(
  baseUrl: string,
  workDir: string,
): Promise<void> {
  const scene = concurrentScene();
  const database = `schemamill_w6_concurrent_wrapped_${runToken}`;
  const url = withDatabase(baseUrl, database);

  try {
    await dropDatabase(baseUrl, database);
    await createDatabase(baseUrl, database);

    const baselineFile = join(workDir, 'concurrent.baseline.sql');
    await writeFile(
      baselineFile,
      renderSql(plan({ tables: [], sequences: [] }, scene.baseline)),
      'utf8',
    );
    await applyFile(url, baselineFile);

    const lines = renderSql(plan(scene.baseline, scene.target)).split('\n');
    const concurrent = lines.filter((line) => line.startsWith('CREATE INDEX CONCURRENTLY '));
    assert.equal(concurrent.length, 1, `${scene.name}: exactly one concurrent statement renders`);
    const statement = concurrent[0]!;
    const position = lines.indexOf(statement);
    assert.ok(position > 0, `${scene.name}: the concurrent statement is not the first line`);
    assert.equal(
      lines[position - 1],
      '',
      `${scene.name}: the concurrent statement opens a group of its own`,
    );
    assert.equal(
      lines[position + 1],
      '',
      `${scene.name}: the concurrent statement closes a group of its own`,
    );

    const wrappedFile = join(workDir, 'concurrent.wrapped.sql');
    await writeFile(wrappedFile, `BEGIN;\n${statement}\nCOMMIT;\n`, 'utf8');
    const failure = await applyExpectingFailure(url, wrappedFile);
    assert.ok(
      failure.startsWith('psql failed (exit '),
      `${database}: psql must exit non-zero for the wrapped build: ${failure}`,
    );
    assert.ok(
      failure.includes('cannot run inside a transaction block'),
      `${database}: the wrapped build failed for the wrong reason: ${failure}`,
    );
    assert.equal(
      await query(
        url,
        "select count(*) from pg_class where relname = 'accounts_email_idx' and relkind = 'i'",
      ),
      '0',
      `${database}: the refused build must not leave an index behind`,
    );

    const bareFile = join(workDir, 'concurrent.bare.sql');
    await writeFile(bareFile, `${statement}\n`, 'utf8');
    await applyFile(url, bareFile);
    assert.equal(
      await query(
        url,
        "select indisvalid from pg_index where indexrelid = 'public.accounts_email_idx'::regclass",
      ),
      't',
      `${database}: the same statement without wrappers must build a valid index`,
    );
  } finally {
    await dropDatabase(baseUrl, database);
  }
}

/** The SQL files one scene runs through, and where its dumps land for inspection. */
interface SceneFiles {
  /** Raw setup SQL applied to both databases before their builds, when the scene declares it. */
  readonly setup?: string;
  readonly baselineBuild: string;
  readonly targetBuild: string;
  readonly migration: string;
  readonly appliedDump: string;
  readonly targetDump: string;
}

/** Writes the scene's SQL files into `workDir` and returns every path. */
async function writeSceneFiles(
  workDir: string,
  slug: string,
  scene: LiveScene,
): Promise<SceneFiles> {
  const setup = scene.setupSql === undefined ? undefined : join(workDir, `${slug}.setup.sql`);
  if (setup !== undefined) await writeFile(setup, `${scene.setupSql}\n`, 'utf8');
  const baselineBuild = join(workDir, `${slug}.baseline.build.sql`);
  const targetBuild = join(workDir, `${slug}.target.build.sql`);
  const migration = join(workDir, `${slug}.migrate.sql`);
  await writeFile(
    baselineBuild,
    renderSql(plan({ tables: [], sequences: [] }, scene.baseline)),
    'utf8',
  );
  const targetSql = renderSql(plan({ tables: [], sequences: [] }, scene.target));
  const targetExtras = scene.targetExtraSql === undefined ? '' : `${scene.targetExtraSql}\n`;
  await writeFile(targetBuild, `${targetSql}${targetExtras}`, 'utf8');
  await writeFile(migration, renderSql(plan(scene.baseline, scene.target)), 'utf8');
  return {
    ...(setup === undefined ? {} : { setup }),
    baselineBuild,
    targetBuild,
    migration,
    appliedDump: join(workDir, `${slug}.applied.dump.sql`),
    targetDump: join(workDir, `${slug}.target.dump.sql`),
  };
}

/** Asserts every catalog fact in order, each with a one-line `psql -tA` comparison. */
async function assertChecks(url: string, checks: readonly SceneCheck[]): Promise<void> {
  for (const check of checks) {
    assert.equal(await query(url, check.sql), check.expected, check.description);
  }
}

/** Asserts every plan fact in order against `plan(baseline, target)`. */
function assertPlanChecks(scene: LiveScene): void {
  const migration = plan(scene.baseline, scene.target);
  for (const check of scene.planChecks ?? []) {
    const failure = check.failure(migration.steps, migration);
    assert.ok(
      failure === undefined,
      `${scene.name}: ${check.description}${failure === undefined ? '' : `: ${failure}`}`,
    );
  }
}

/**
 * Asserts every import fact in order against one dump's import. The check also sees which
 * database the dump came from, so a fact that holds on one side only — a skip the target
 * carries but the migrated database must not — can still be pinned exactly.
 */
function assertImportChecks(
  what: string,
  scene: LiveScene,
  imported: ReadResult<Model, Diagnostic>,
  source: 'applied' | 'target',
): void {
  for (const check of scene.importChecks ?? []) {
    const failure = check.failure(imported, source);
    assert.ok(
      failure === undefined,
      `${scene.name}: ${what}: ${check.description}${failure === undefined ? '' : `: ${failure}`}`,
    );
  }
}

/**
 * The scene's live-introspection assertion, consuming the production `catalogReader` through
 * the seam type. The read runs against the migrated database; `matches-import` requires no
 * diagnostics, an empty `diff` against the applied dump's import, and a model deep-equal to
 * that import — the order-significant guard — while `flags` pins the diagnostics list exactly.
 */
async function assertIntrospection(
  appliedUrl: string,
  sceneName: string,
  applied: ReadResult<Model, Diagnostic>,
  assertion: SceneIntrospection,
): Promise<void> {
  const reader: CatalogReader<string, Model, Diagnostic> = catalogReader;
  const introspected = await reader.introspect(appliedUrl);
  if (assertion.assert === 'matches-import') {
    assert.deepEqual(
      introspected.diagnostics,
      [],
      `${sceneName}: introspection reported diagnostics for a scene the import considers clean`,
    );
    assert.deepEqual(
      diff(introspected.model, applied.model),
      [],
      `${sceneName}: the introspected model does not match the applied dump's import`,
    );
    assert.deepEqual(
      introspected.model,
      applied.model,
      `${sceneName}: the introspected model is not deep-equal to the applied dump's import`,
    );
    return;
  }
  assert.deepEqual(
    introspected.diagnostics,
    assertion.expected,
    `${sceneName}: introspection diagnostics differ`,
  );
}

/** Asserts that neither dump produced a parse error; skips and flags are allowed. */
function assertNoErrors(what: string, result: ReadResult<Model, Diagnostic>): void {
  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.kind === 'error')
    .map((diagnostic) => diagnostic.message);
  assert.deepEqual(errors, [], `${what}: the import reported errors`);
}

/**
 * Asserts that every sequence the target model declares survived an import with the same
 * descriptor, compared field by field. The map is keyed by `schema.name`, so an import that
 * drops, moves, or swaps sequences cannot pass by matching descriptors as a set of values;
 * the descriptor comparison covers the data type, every option, and the exact ownership —
 * absent `ownedBy` means unowned and is distinguished from a stated owner. Both dumps describe
 * a database that should end in the scene's target state — the target database is built from
 * it, the applied database is migrated to it — so this guards a sequence import gap that loses
 * or permutes options symmetrically on both sides, where `diff` between the two imports would
 * stay empty while this failure names the scene and the sequence. Baseline-only sequences are
 * exempt, because the migration drops them by design and the diff assertion covers the result.
 * Scenes whose target has no sequences pass vacuously.
 *
 * Also rejects any import diagnostic that names a sequence, except the state-only skips that
 * are expected by design (`setval`, `RESTART`): a sequence dropped or altered by a structural
 * skip has to fail the scene by name, not hide behind an empty diff that both imports agree on.
 */
function assertSequencesRetained(
  what: string,
  scene: LiveScene,
  imported: ReadResult<Model, Diagnostic>,
): void {
  const declared = sequenceByName(scene.target);
  const found = sequenceByName(imported.model);
  const failures: string[] = [];
  for (const [name, descriptor] of declared) {
    const actual = found.get(name);
    if (actual === undefined) {
      failures.push(`${name}: dropped (${describeSequence(descriptor)})`);
    } else if (!sameSequenceDescriptor(descriptor, actual)) {
      failures.push(`${name}: ${describeSequence(descriptor)} became ${describeSequence(actual)}`);
    }
  }
  for (const name of found.keys()) {
    if (!declared.has(name)) {
      failures.push(`${name}: imported a sequence the target model does not declare`);
    }
  }
  assert.deepEqual(failures, [], `${scene.name}: ${what}: sequence retention failed`);
  assert.deepEqual(
    imported.diagnostics
      .filter((diagnostic) => namesSequence(diagnostic.message))
      .filter((diagnostic) => !isSequenceStateSkip(diagnostic.message))
      .map((diagnostic) => `${diagnostic.kind}: ${diagnostic.message}`),
    [],
    `${scene.name}: ${what}: the import named structural sequence problems`,
  );
}

/** Every sequence's `schema.name` key and descriptor, as a map. */
function sequenceByName(model: Model): ReadonlyMap<string, Sequence> {
  return new Map(
    model.sequences.map((sequence) => [`${sequence.schema}.${sequence.name}`, sequence]),
  );
}

/** Whether two descriptors state the same sequence, option by option and ownership exactly. */
function sameSequenceDescriptor(left: Sequence, right: Sequence): boolean {
  return (
    left.dataType === right.dataType &&
    left.increment === right.increment &&
    left.minValue === right.minValue &&
    left.maxValue === right.maxValue &&
    left.start === right.start &&
    left.cache === right.cache &&
    left.cycle === right.cycle &&
    sameSequenceOwner(left.ownedBy, right.ownedBy)
  );
}

/**
 * Whether two ownership states are the same: both absent (unowned), or the same table and
 * column. Unlike an identity's optional sequence name, absent ownership is a state rather than
 * a don't-care, so `undefined` never matches a stated owner.
 */
function sameSequenceOwner(
  left: SequenceOwner | undefined,
  right: SequenceOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.table.schema === right.table.schema &&
    left.table.name === right.table.name &&
    left.column === right.column
  );
}

/** One sequence descriptor as one line, for a failure message. */
function describeSequence(sequence: Sequence): string {
  const owner =
    sequence.ownedBy === undefined
      ? 'none'
      : `${sequence.ownedBy.table.schema}.${sequence.ownedBy.table.name}.${sequence.ownedBy.column}`;
  return (
    `${sequence.dataType} increment=${sequence.increment} min=${sequence.minValue}` +
    ` max=${sequence.maxValue} start=${sequence.start} cache=${sequence.cache}` +
    ` cycle=${sequence.cycle} owned=${owner}`
  );
}

/** Whether a diagnostic's message names a sequence, structurally or through a `setval` call. */
function namesSequence(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('sequence') || text.includes('setval');
}

/** Whether a sequence diagnostic is state only, which both dumps are allowed to skip. */
function isSequenceStateSkip(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('setval') || text.includes('(restart)');
}

/**
 * Asserts that every identity column the target model declares survived an import with the
 * same descriptor, compared column by column. The map is keyed by `schema.table.column`, so an
 * import that drops, moves, or swaps an identity cannot pass by matching descriptors as a set
 * of values; the descriptor comparison covers the generation mode, the sequence name, and every
 * option, so a silently changed option fails the scene by column. The nested sequence name
 * compares exactly when both sides state one, mirroring the model's identity equality. Scenes
 * whose target has no identity columns pass vacuously.
 *
 * Also rejects any import diagnostic that names an identity: an identity that is dropped or
 * degraded by a flag or skip has to fail the scene by name, not hide behind an empty diff that
 * both imports would agree on.
 */
function assertIdentitiesRetained(
  what: string,
  scene: LiveScene,
  imported: ReadResult<Model, Diagnostic>,
): void {
  const declared = identityColumns(scene.target);
  const found = identityColumns(imported.model);
  const failures: string[] = [];
  for (const [column, descriptor] of declared) {
    const actual = found.get(column);
    if (actual === undefined) {
      failures.push(`${column}: dropped (${describeIdentity(descriptor)})`);
    } else if (!sameIdentityDescriptor(descriptor, actual)) {
      failures.push(
        `${column}: ${describeIdentity(descriptor)} became ${describeIdentity(actual)}`,
      );
    }
  }
  for (const column of found.keys()) {
    if (!declared.has(column)) {
      failures.push(`${column}: imported an identity the target model does not declare`);
    }
  }
  assert.deepEqual(failures, [], `${scene.name}: ${what}: identity retention failed`);
  assert.deepEqual(
    imported.diagnostics
      .filter((diagnostic) => diagnostic.message.toLowerCase().includes('identity'))
      .map((diagnostic) => `${diagnostic.kind}: ${diagnostic.message}`),
    [],
    `${scene.name}: ${what}: the import named identity problems`,
  );
}

/** Every identity column's `schema.table.column` key and descriptor, as a map. */
function identityColumns(model: Model): ReadonlyMap<string, Identity> {
  const columns = new Map<string, Identity>();
  for (const table of model.tables) {
    for (const column of table.columns) {
      if (column.identity === undefined) continue;
      columns.set(`${table.schema}.${table.name}.${column.name}`, column.identity);
    }
  }
  return columns;
}

/**
 * Whether two descriptors state the same identity. The nested sequence name is a don't-care
 * when either side omits it — a target that does not name the sequence lets PostgreSQL choose
 * the name — and must match exactly when both sides state one.
 */
function sameIdentityDescriptor(left: Identity, right: Identity): boolean {
  return (
    left.generated === right.generated &&
    left.increment === right.increment &&
    left.minValue === right.minValue &&
    left.maxValue === right.maxValue &&
    left.start === right.start &&
    left.cache === right.cache &&
    left.cycle === right.cycle &&
    sameSequenceName(left.sequenceName, right.sequenceName)
  );
}

/** Whether two optional identity sequence names state the same name. */
function sameSequenceName(
  left: SequenceIdentity | undefined,
  right: SequenceIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return true;
  return left.schema === right.schema && left.name === right.name;
}

/** One identity descriptor as one line, for a failure message. */
function describeIdentity(identity: Identity): string {
  const name =
    identity.sequenceName === undefined
      ? 'none'
      : `${identity.sequenceName.schema}.${identity.sequenceName.name}`;
  return (
    `${name} ${identity.generated} increment=${identity.increment} min=${identity.minValue}` +
    ` max=${identity.maxValue} start=${identity.start} cache=${identity.cache} cycle=${identity.cycle}`
  );
}

/** The base connection pointed at `database`, by replacing the URI's database name. */
function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `CREATE DATABASE database`, through the base connection. */
async function createDatabase(baseUrl: string, database: string): Promise<void> {
  await psql(baseUrl, ['-c', `CREATE DATABASE ${database};`]);
}

/**
 * `DROP DATABASE … WITH (FORCE)`, through the base connection, best-effort: a database that
 * cannot be dropped must not mask the scene's own result. The names are derived from scene
 * names (`a-z`, digits, underscores) and this run's hex token, so interpolating them is safe.
 */
async function dropDatabase(baseUrl: string, database: string): Promise<void> {
  try {
    await psql(baseUrl, ['-c', `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`]);
  } catch {
    // Cleanup only.
  }
}

/** `pg_dump --schema-only --no-owner --no-privileges`, as text. */
function dump(url: string): Promise<string> {
  return run('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', url]);
}

/** Applies a SQL file, ON_ERROR_STOP=1; the file may legitimately be empty. */
function applyFile(url: string, path: string): Promise<string> {
  return psql(url, ['-f', path]);
}

/** One scalar text value: `psql -tA` output, trimmed of its row terminator. */
async function query(url: string, sql: string): Promise<string> {
  return (await psql(url, ['-tA', '-c', sql])).trim();
}

/** `psql` with client-local settings off and error stops on. */
function psql(url: string, args: readonly string[]): Promise<string> {
  return run('psql', [url, '-X', '-v', 'ON_ERROR_STOP=1', ...args]);
}

/** Spawns a command and returns stdout, throwing with stderr and the exit code otherwise. */
async function run(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; message?: string };
    throw new Error(
      `${command} failed (exit ${String(failure.code)}): ${failure.stderr ?? failure.message ?? ''}`,
      { cause: error },
    );
  }
}

/** A thrown value's message, stringified when it is not an `Error`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
