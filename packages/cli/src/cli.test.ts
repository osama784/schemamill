import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * End-to-end tests for the `schemamill` binary.
 *
 * Every scene spawns the built CLI in `dist/` (the package's test script builds first) with
 * fixture dumps written into a fresh temp directory, and asserts the exact stdout, stderr,
 * and exit code: stdout carries only the artifact, stderr only diagnostics and failures.
 */

const execFileAsync = promisify(execFile);

/** The built entry point. */
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const BASELINE_DUMP = [
  'CREATE TABLE public.accounts (',
  '    id integer NOT NULL,',
  '    email character varying(255) NOT NULL,',
  '    org_id integer,',
  '    CONSTRAINT accounts_pkey PRIMARY KEY (id),',
  '    CONSTRAINT accounts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs (id) ON DELETE RESTRICT',
  ');',
  '',
  'CREATE TABLE public.legacy (',
  '    id integer NOT NULL,',
  '    CONSTRAINT legacy_pkey PRIMARY KEY (id)',
  ');',
  '',
  'CREATE TABLE public.orgs (',
  '    id integer NOT NULL,',
  '    name text NOT NULL,',
  '    CONSTRAINT orgs_pkey PRIMARY KEY (id)',
  ');',
  '',
].join('\n');

const TARGET_DUMP = [
  'CREATE TABLE public.accounts (',
  '    id integer NOT NULL,',
  '    email text NOT NULL,',
  '    org_id integer,',
  '    created_at timestamptz NOT NULL DEFAULT now(),',
  '    CONSTRAINT accounts_pkey PRIMARY KEY (id),',
  '    CONSTRAINT accounts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs (id) ON DELETE CASCADE',
  ');',
  '',
  'CREATE TABLE public.orgs (',
  '    id integer NOT NULL,',
  '    name text NOT NULL,',
  '    CONSTRAINT orgs_pkey PRIMARY KEY (id)',
  ');',
  '',
  'CREATE TABLE public.projects (',
  '    id integer NOT NULL,',
  '    name text NOT NULL,',
  '    CONSTRAINT projects_pkey PRIMARY KEY (id)',
  ');',
  '',
].join('\n');

const EXPECTED_COMPARE = [
  '~ table public.accounts',
  '    + column created_at timestamptz NOT NULL DEFAULT now()',
  '    ~ column email: type character varying(255) → text',
  '    ~ foreign key (org_id) → public.orgs: on delete RESTRICT → CASCADE',
  '',
  '- table public.legacy',
  '    id integer NOT NULL',
  '    primary key legacy_pkey (id)',
  '',
  '+ table public.projects',
  '    id integer NOT NULL',
  '    name text NOT NULL',
  '    primary key projects_pkey (id)',
  '',
].join('\n');

const EXPECTED_PLAN = [
  '6 steps:',
  ' 1. drop-foreign-key  public.accounts: foreign key accounts_org_id_fkey (org_id) → public.orgs (id) on delete RESTRICT',
  ' 2. drop-table        public.legacy',
  ' 3. create-table      public.projects',
  ' 4. add-column        public.accounts.created_at timestamptz NOT NULL DEFAULT now()',
  ' 5. alter-column      public.accounts.email: type character varying(255) → text',
  ' 6. add-foreign-key   public.accounts: foreign key accounts_org_id_fkey (org_id) → public.orgs (id) on delete CASCADE',
  '',
  'ALTER TABLE public.accounts DROP CONSTRAINT accounts_org_id_fkey;',
  'DROP TABLE public.legacy;',
  'CREATE TABLE public.projects (',
  '    id integer NOT NULL,',
  '    name text NOT NULL,',
  '    CONSTRAINT projects_pkey PRIMARY KEY (id)',
  ');',
  'ALTER TABLE public.accounts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();',
  'ALTER TABLE public.accounts ALTER COLUMN email TYPE text;',
  'ALTER TABLE public.accounts ADD CONSTRAINT accounts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;',
  '',
].join('\n');

const PARSE_FAILURE_BASELINE = [
  'CREATE TABLE public.users (',
  '    id integer NOT NULL',
  ');',
  '',
].join('\n');

const PARSE_FAILURE_TARGET = [
  'CREATE TABLE public.users (',
  '    id bigint NOT NULL',
  ');',
  '',
  'CREATE TABLE public.broken (',
  '    id integer',
  '));',
  '',
].join('\n');

const EXPECTED_PARSE_FAILURE_COMPARE = [
  '~ table public.users',
  '    ~ column id: type integer → bigint',
  '',
].join('\n');

const INDEX_DUMP = [
  'CREATE TABLE public.users (',
  '    id integer NOT NULL',
  ');',
  '',
  'CREATE INDEX idx_users_email ON public.users (id);',
  '',
].join('\n');

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | undefined;
}

/** A fresh temp directory removed when the test ends. */
async function fixtureDir(context: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'schemamill-cli-'));
  context.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Writes `contents` to `name` inside `dir` and returns the path. */
async function writeDump(dir: string, name: string, contents: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

/** Spawns the built CLI and captures both streams and the exit code, success or failure. */
async function runCli(...args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code };
  }
}

test('compare prints the diff, and only the diff, to stdout', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', BASELINE_DUMP);
  const target = await writeDump(dir, 'target.sql', TARGET_DUMP);

  const result = await runCli('compare', baseline, target);

  assert.equal(result.stdout, EXPECTED_COMPARE);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('compare on identical dumps says there are no changes', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', BASELINE_DUMP);

  const result = await runCli('compare', baseline, baseline);

  assert.equal(result.stdout, 'No changes.\n');
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('plan prints the numbered steps, then the migration SQL', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', BASELINE_DUMP);
  const target = await writeDump(dir, 'target.sql', TARGET_DUMP);

  const result = await runCli('plan', baseline, target);

  assert.equal(result.stdout, EXPECTED_PLAN);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('plan on identical dumps says there are no changes', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', BASELINE_DUMP);

  const result = await runCli('plan', baseline, baseline);

  assert.equal(result.stdout, 'No changes.\n');
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('a missing baseline is one stderr line naming the path and reason, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const missing = join(dir, 'missing.sql');

  const result = await runCli('compare', missing, missing);

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `schemamill: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
  );
  assert.equal(result.code, 1);
});

test('a missing target is one stderr line naming the path and reason, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', BASELINE_DUMP);
  const missing = join(dir, 'missing.sql');

  const result = await runCli('plan', baseline, missing);

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `schemamill: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
  );
  assert.equal(result.code, 1);
});

test('a parse failure is reported on stderr while the diff is still printed', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', PARSE_FAILURE_BASELINE);
  const target = await writeDump(dir, 'target.sql', PARSE_FAILURE_TARGET);

  const result = await runCli('compare', baseline, target);

  assert.equal(result.stdout, EXPECTED_PARSE_FAILURE_COMPARE);
  assert.match(result.stderr, /^target: 1 failed\ntarget: \[error\] .+ \(\d+:\d+\)\n$/);
  assert.equal(result.code, 1);
});

test('skips print a counts line, and --verbose adds the skip line', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', INDEX_DUMP);

  const quiet = await runCli('compare', dump, dump);

  assert.equal(quiet.stdout, 'No changes.\n');
  assert.equal(quiet.stderr, 'baseline: 1 skipped\ntarget: 1 skipped\n');
  assert.equal(quiet.code, 0);

  const verbose = await runCli('compare', dump, dump, '--verbose');

  assert.equal(verbose.stdout, 'No changes.\n');
  assert.equal(
    verbose.stderr,
    [
      'baseline: 1 skipped',
      'baseline: [skip] skipped CREATE INDEX idx_users_email (5:1)',
      'target: 1 skipped',
      'target: [skip] skipped CREATE INDEX idx_users_email (5:1)',
      '',
    ].join('\n'),
  );
  assert.equal(verbose.code, 0);
});
