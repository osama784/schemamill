import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { diff, plan } from '@schemamill/core';
import type { Diagnostic, Model, ReadResult } from '@schemamill/core';

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
 * target))`. The scene's catalog checks run against the baseline database after its build,
 * and its probes and checks after the migration. Both databases are dumped with `pg_dump
 * --schema-only --no-owner --no-privileges`, both dumps are imported, neither import may
 * report an error diagnostic, and `diff` between the imported models must be exactly empty.
 * Databases are dropped best-effort, so a failed scene still cleans up after itself.
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
  await writeFile(baselineBuild, renderSql(plan({ tables: [] }, scene.baseline)), 'utf8');
  await writeFile(targetBuild, renderSql(plan({ tables: [] }, scene.target)), 'utf8');
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

/** Asserts that neither dump produced a parse error; skips and flags are allowed. */
function assertNoErrors(what: string, result: ReadResult<Model, Diagnostic>): void {
  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.kind === 'error')
    .map((diagnostic) => diagnostic.message);
  assert.deepEqual(errors, [], `${what}: the import reported errors`);
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
