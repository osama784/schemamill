import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { version } from '@schemamill/core';

/**
 * End-to-end tests for the `schemamill` binary.
 *
 * Every test spawns the built CLI in `dist/` (the package's test script builds first): the
 * command scenes pass fixture dumps written into a fresh temp directory, and the usage tests
 * pass their arguments bare. Each asserts the exact stdout, stderr, and exit code: stdout
 * carries only the artifact — or the help and version text — while stderr carries only
 * diagnostics, failures, and usage errors.
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

/** The swapped sides of the parse-failure pair: the broken dump is the baseline. */
const EXPECTED_BASELINE_PARSE_FAILURE_COMPARE = [
  '~ table public.users',
  '    ~ column id: type bigint → integer',
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

/** A dump whose column CHECK constraint the importer flags and drops. */
const FLAG_DUMP = [
  'CREATE TABLE public.events (',
  '    id integer NOT NULL CHECK (id > 0),',
  '    note text',
  ');',
  '',
].join('\n');

/** What `--help` prints to stdout, and what a bare invocation prints to stderr. */
const USAGE = [
  'Usage: schemamill [options] [command]',
  '',
  'A local-first studio for database schemas.',
  '',
  'Options:',
  '  -V, --version                          output the version number',
  '  -h, --help                             display help for command',
  '',
  'Commands:',
  '  compare [options] <baseline> <target>  Print the diff between two DDL dumps.',
  '  plan [options] <baseline> <target>     Print the migration plan and its SQL between two DDL dumps.',
  '  help [command]                         display help for command',
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

/** Whether the current process can read `path`; a mode-000 file stays readable for root. */
function canRead(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Escapes `value` so a RegExp matches its characters literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  assert.equal(
    result.stderr,
    'target: 1 failed\ntarget: [error] syntax error at or near ")" (7:2)\n',
  );
  assert.equal(result.code, 1);
});

test('a baseline parse failure is reported on stderr while the diff is still printed', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', PARSE_FAILURE_TARGET);
  const target = await writeDump(dir, 'target.sql', PARSE_FAILURE_BASELINE);

  const result = await runCli('compare', baseline, target);

  assert.equal(result.stdout, EXPECTED_BASELINE_PARSE_FAILURE_COMPARE);
  assert.equal(
    result.stderr,
    'baseline: 1 failed\nbaseline: [error] syntax error at or near ")" (7:2)\n',
  );
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

test('flags print a counts line, and --verbose adds the flag line', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', FLAG_DUMP);

  const quiet = await runCli('compare', dump, dump);

  assert.equal(quiet.stdout, 'No changes.\n');
  assert.equal(quiet.stderr, 'baseline: 1 flagged\ntarget: 1 flagged\n');
  assert.equal(quiet.code, 0);

  const verbose = await runCli('compare', dump, dump, '--verbose');

  assert.equal(verbose.stdout, 'No changes.\n');
  assert.equal(
    verbose.stderr,
    [
      'baseline: 1 flagged',
      'baseline: [flag] dropped check constraint on public.events.id from public.events (1:1)',
      'target: 1 flagged',
      'target: [flag] dropped check constraint on public.events.id from public.events (1:1)',
      '',
    ].join('\n'),
  );
  assert.equal(verbose.code, 0);
});

test('plan --verbose adds the skip line', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', INDEX_DUMP);

  const result = await runCli('plan', dump, dump, '--verbose');

  assert.equal(result.stdout, 'No changes.\n');
  assert.equal(
    result.stderr,
    [
      'baseline: 1 skipped',
      'baseline: [skip] skipped CREATE INDEX idx_users_email (5:1)',
      'target: 1 skipped',
      'target: [skip] skipped CREATE INDEX idx_users_email (5:1)',
      '',
    ].join('\n'),
  );
  assert.equal(result.code, 0);
});

test('--help prints the usage to stdout, exit 0', async () => {
  const result = await runCli('--help');

  assert.equal(result.stdout, USAGE);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('--version prints the version to stdout, exit 0', async () => {
  const result = await runCli('--version');

  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('no command prints the usage to stderr, exit 1', async () => {
  const result = await runCli();

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, USAGE);
  assert.equal(result.code, 1);
});

test('a missing argument is a usage error on stderr, exit 1', async () => {
  const result = await runCli('compare', 'baseline.sql');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: missing required argument 'target'\n");
  assert.equal(result.code, 1);
});

test('an extra argument is a usage error naming every argument, exit 1', async () => {
  const result = await runCli('compare', 'baseline.sql', 'target.sql', 'extra.sql');

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    "error: too many arguments for 'compare'. Expected 2 arguments but got 3: baseline.sql, target.sql, extra.sql.\n",
  );
  assert.equal(result.code, 1);
});

test('an unknown option is a usage error on stderr, exit 1', async () => {
  const result = await runCli('compare', 'baseline.sql', 'target.sql', '--bogus');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: unknown option '--bogus'\n");
  assert.equal(result.code, 1);
});

test('a directory path is a read failure naming EISDIR, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const target = await writeDump(dir, 'target.sql', BASELINE_DUMP);

  const result = await runCli('compare', dir, target);

  assert.equal(result.stdout, '');
  // Node 24 ends the message at "read"; Node 26 appends the quoted path.
  assert.match(
    result.stderr,
    new RegExp(
      `^schemamill: cannot read ${escapeRegExp(dir)}: EISDIR: illegal operation on a directory, read(?: '${escapeRegExp(dir)}')?\\n$`,
    ),
  );
  assert.equal(result.code, 1);
});

test('a permission-denied file is a read failure naming EACCES, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const target = await writeDump(dir, 'target.sql', BASELINE_DUMP);
  const locked = await writeDump(dir, 'locked.sql', BASELINE_DUMP);
  await chmod(locked, 0o000);

  if (canRead(locked)) {
    t.skip('a mode-000 file is still readable (running as root)');
    return;
  }

  const result = await runCli('compare', locked, target);

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `schemamill: cannot read ${locked}: EACCES: permission denied, open '${locked}'\n`,
  );
  assert.equal(result.code, 1);
});
