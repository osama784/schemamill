import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { diff, plan } from '@schemamill/core';
import type {
  Diagnostic,
  Identity,
  Model,
  ReadResult,
  Sequence,
  SequenceIdentity,
  SequenceOwner,
} from '@schemamill/core';

import { importDump, renderSql } from './index.ts';
import { scenes } from './live-scenes.ts';
import type { LiveScene, SceneCheck } from './live-scenes.ts';

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
 * Per scene, sequentially: both databases are created fresh; the baseline database gets the
 * build SQL for the baseline model (the plan from an empty model), the target database the
 * build SQL for the target model; the baseline database then gets `renderSql(plan(baseline,
 * target))`. The scene's plan checks run against that plan before any SQL, its catalog checks
 * run against the baseline database after its build, and its probes and remaining checks after
 * the migration. Both databases are dumped with `pg_dump --schema-only --no-owner
 * --no-privileges`, both dumps are imported, neither import may report an error diagnostic,
 * the modeled sequences and identity columns must come back exactly (see
 * `assertSequencesRetained` and `assertIdentitiesRetained`), and `diff` between the imported
 * models must be exactly empty. Databases are dropped best-effort, so a failed scene still
 * cleans up after itself.
 */

const execFileAsync = promisify(execFile);

/** The connection URI from the environment, or `undefined` when unset or empty. */
const pgUrl = process.env.SCHEMAMILL_TEST_PG_URL || undefined;

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
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  },
);

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

/** One scene's whole round trip, against fresh databases named after the scene. */
async function runScene(baseUrl: string, workDir: string, scene: LiveScene): Promise<void> {
  const slug = scene.name.replace(/[^a-z0-9]+/g, '_');
  const appliedDb = `schemamill_w6_${slug}`;
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

    assert.deepEqual(
      diff(applied.model, expected.model),
      [],
      `${scene.name}: the migrated database does not match the database built from the target model`,
    );
  } finally {
    await dropDatabase(baseUrl, appliedDb);
    await dropDatabase(baseUrl, targetDb);
  }
}

/** The SQL files one scene runs through, and where its dumps land for inspection. */
interface SceneFiles {
  readonly baselineBuild: string;
  readonly targetBuild: string;
  readonly migration: string;
  readonly appliedDump: string;
  readonly targetDump: string;
}

/** Writes the scene's three SQL files into `workDir` and returns every path. */
async function writeSceneFiles(
  workDir: string,
  slug: string,
  scene: LiveScene,
): Promise<SceneFiles> {
  const baselineBuild = join(workDir, `${slug}.baseline.build.sql`);
  const targetBuild = join(workDir, `${slug}.target.build.sql`);
  const migration = join(workDir, `${slug}.migrate.sql`);
  await writeFile(
    baselineBuild,
    renderSql(plan({ tables: [], sequences: [] }, scene.baseline)),
    'utf8',
  );
  await writeFile(
    targetBuild,
    renderSql(plan({ tables: [], sequences: [] }, scene.target)),
    'utf8',
  );
  await writeFile(migration, renderSql(plan(scene.baseline, scene.target)), 'utf8');
  return {
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
  const steps = plan(scene.baseline, scene.target).steps;
  for (const check of scene.planChecks ?? []) {
    const failure = check.failure(steps);
    assert.ok(
      failure === undefined,
      `${scene.name}: ${check.description}${failure === undefined ? '' : `: ${failure}`}`,
    );
  }
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
 * names (`a-z`, digits, underscores), so interpolating them is safe.
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
