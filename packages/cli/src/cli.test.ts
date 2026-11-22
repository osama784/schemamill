import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { initWorkspace, resolveWorkspace, version } from '@schemamill/core';
import type { Model } from '@schemamill/core';
import { importDump } from '@schemamill/postgres';

/**
 * End-to-end tests for the `schemamill` binary.
 *
 * Every test spawns the built CLI in `dist/` (the package's test script builds first): the
 * compare and plan scenes pass fixture dumps written into a fresh temp directory — except the
 * render refusal, which reads the checked-in pair under `test/fixtures` — or run inside a temp
 * workspace whose `model.json` resolves the side a lone path leaves open, with the spawned
 * cwd deciding which workspace root wins; the export scenes create a temp workspace holding
 * the committed fixture model and run from it; the init scenes pass a fresh temp directory as
 * the workspace target, sometimes with a dump imported from a file or stdin, and the usage
 * tests pass their arguments bare. Each asserts the exact
 * stdout, stderr, and exit code: stdout carries only the artifact — or the help and version
 * text — while stderr carries only diagnostics, failures, and usage errors.
 */

const execFileAsync = promisify(execFile);

/** The built entry point. */
const CLI = fileURLToPath(new URL('../dist/index.js', import.meta.url));

/** The pinned init default bytes: a workspace `model.json` with no tables and no sequences. */
const EMPTY_MODEL =
  '{\n  "tables": [],\n  "sequences": [],\n  "views": [],\n  "extensions": []\n}\n';

/**
 * A workspace model naming one table none of the dump fixtures carry, so a run that resolves
 * the workspace where it must not is visible in the output.
 */
const STALE_MODEL = [
  '{',
  '  "tables": [',
  '    {',
  '      "schema": "public",',
  '      "name": "stale",',
  '      "columns": [',
  '        {',
  '          "name": "id",',
  '          "type": "integer",',
  '          "notNull": true',
  '        }',
  '      ],',
  '      "foreignKeys": [],',
  '      "uniqueConstraints": [],',
  '      "checkConstraints": [],',
  '      "indexes": []',
  '    }',
  '  ],',
  '  "sequences": []',
  '}',
  '',
].join('\n');

/** The committed export fixture, parsed from its bytes: both projections read this model. */
const EXPORT_MODEL = JSON.parse(testText('fixtures/export-model.json')) as Model;

/**
 * A model whose two identical unnamed indexes on one table resolve to the same conventional
 * name (`t_a_idx`): the DDL projection can render neither create, so it refuses with no stdout.
 */
const REFUSAL_MODEL: Model = {
  tables: [
    {
      schema: 'public',
      name: 't',
      columns: [{ name: 'a', type: 'integer', notNull: false }],
      foreignKeys: [],
      uniqueConstraints: [],
      checkConstraints: [],
      indexes: [
        { unique: false, columns: ['a'] },
        { unique: false, columns: ['a'] },
      ],
    },
  ],
  sequences: [],
  views: [],
  extensions: [],
};

/**
 * A workspace model whose only sequence is owned by `public.absent.id`, a table the model does
 * not carry: core's `plan()` refuses it with `SequenceOwnershipError`, so every covered command
 * must report one `schemamill:` line and no artifact. A hand-edited `ownedBy` is shape-valid;
 * only `plan()` resolves it.
 */
const DANGLING_TABLE_MODEL = `{
  "tables": [],
  "sequences": [{ "schema": "public", "name": "s", "dataType": "bigint",
    "increment": "1", "minValue": "1", "maxValue": "9223372036854775807",
    "start": "1", "cache": "1", "cycle": false,
    "ownedBy": { "table": { "schema": "public", "name": "absent" }, "column": "id" } }],
  "views": [],
  "extensions": []
}
`;

/**
 * The missing-column variant: `public.t` carries column `a`, but the sequence is owned by
 * `public.t.id`, so the same refusal names the column instead of the table.
 */
const DANGLING_COLUMN_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "a", "type": "integer", "notNull": false }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [],
      "indexes": []
    }
  ],
  "sequences": [{ "schema": "public", "name": "s", "dataType": "bigint",
    "increment": "1", "minValue": "1", "maxValue": "9223372036854775807",
    "start": "1", "cache": "1", "cycle": false,
    "ownedBy": { "table": { "schema": "public", "name": "t" }, "column": "id" } }],
  "views": [],
  "extensions": []
}
`;

/** The one stderr line a dangling owner table is reported as. */
const DANGLING_TABLE_ERROR =
  'schemamill: sequence public.s is owned by public.absent.id, but the target model has no table public.absent\n';

/** The one stderr line a dangling owner column is reported as. */
const DANGLING_COLUMN_ERROR =
  'schemamill: sequence public.s is owned by public.t.id, but the target model has no column id on table public.t\n';

/**
 * A workspace model whose only index is named the empty string: the reader must reject it before
 * any command formats or renders it, because `CREATE INDEX ""` cannot execute.
 */
const EMPTY_INDEX_NAME_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "a", "type": "integer", "notNull": false }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [],
      "indexes": [{ "name": "", "unique": false, "columns": ["a"] }]
    }
  ],
  "sequences": [],
  "views": [],
  "extensions": []
}
`;

/**
 * A workspace model whose only index has an empty column list: the reader must reject it before
 * any command formats or renders it, because an empty index rendered `CREATE INDEX ""`-class
 * invalid SQL — the #205 hole one level down. The index name and the table's column list are
 * valid, so the empty identifier list is the only defect.
 */
const EMPTY_INDEX_COLUMNS_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "a", "type": "integer", "notNull": false }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [],
      "indexes": [{ "name": "t_a_idx", "unique": false, "columns": [] }]
    }
  ],
  "sequences": [],
  "views": [],
  "extensions": []
}
`;

/** The valid control for `EMPTY_INDEX_COLUMNS_MODEL`: the same model with a non-empty list. */
const NON_EMPTY_INDEX_COLUMNS_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "a", "type": "integer", "notNull": false }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [],
      "indexes": [{ "name": "t_a_idx", "unique": false, "columns": ["a"] }]
    }
  ],
  "sequences": [],
  "views": [],
  "extensions": []
}
`;

/**
 * The four non-identifier string slots in one otherwise-valid model. `default: ""`, `type: ""`,
 * `expression: ""`, and `definition: ""` each render SQL that cannot apply, so the reader rejects
 * them at the disk boundary. Each fixture below corrupts exactly one slot (first-failure-wins);
 * the paths are the ones `parseNonEmptyString` reports.
 */
const VALID_NON_IDENTIFIER_STRINGS_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "c", "type": "integer", "notNull": false, "default": "0" }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [{ "expression": "c > 0" }],
      "indexes": []
    }
  ],
  "sequences": [],
  "views": [{ "schema": "public", "name": "v", "materialized": false, "definition": "SELECT 1" }],
  "extensions": []
}
`;

const EMPTY_TYPE_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "c", "type": "", "notNull": false, "default": "0" }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [{ "expression": "c > 0" }],
      "indexes": []
    }
  ],
  "sequences": [],
  "views": [{ "schema": "public", "name": "v", "materialized": false, "definition": "SELECT 1" }],
  "extensions": []
}
`;

const EMPTY_DEFAULT_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "c", "type": "integer", "notNull": false, "default": "" }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [{ "expression": "c > 0" }],
      "indexes": []
    }
  ],
  "sequences": [],
  "views": [{ "schema": "public", "name": "v", "materialized": false, "definition": "SELECT 1" }],
  "extensions": []
}
`;

const EMPTY_EXPRESSION_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "c", "type": "integer", "notNull": false, "default": "0" }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [{ "expression": "" }],
      "indexes": []
    }
  ],
  "sequences": [],
  "views": [{ "schema": "public", "name": "v", "materialized": false, "definition": "SELECT 1" }],
  "extensions": []
}
`;

const EMPTY_DEFINITION_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "t",
      "columns": [{ "name": "c", "type": "integer", "notNull": false, "default": "0" }],
      "foreignKeys": [],
      "uniqueConstraints": [],
      "checkConstraints": [{ "expression": "c > 0" }],
      "indexes": []
    }
  ],
  "sequences": [],
  "views": [{ "schema": "public", "name": "v", "materialized": false, "definition": "" }],
  "extensions": []
}
`;

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
  '    primary key (id)',
  '',
  '+ table public.projects',
  '    id integer NOT NULL',
  '    name text NOT NULL',
  '    primary key (id)',
  '',
].join('\n');

const EXPECTED_PLAN = [
  '6 steps in one transaction:',
  ' 1. drop-foreign-key  public.accounts: foreign key (org_id) → public.orgs (id) on delete RESTRICT',
  ' 2. drop-table        public.legacy',
  ' 3. create-table      public.projects',
  ' 4. add-column        public.accounts.created_at timestamptz NOT NULL DEFAULT now()',
  ' 5. alter-column      public.accounts.email: type character varying(255) → text',
  ' 6. add-foreign-key   public.accounts: foreign key (org_id) → public.orgs (id) on delete CASCADE',
  '',
  'BEGIN;',
  'ALTER TABLE public.accounts DROP CONSTRAINT accounts_org_id_fkey;',
  'DROP TABLE public.legacy;',
  'CREATE TABLE public.projects (',
  '    id integer NOT NULL,',
  '    name text NOT NULL,',
  '    PRIMARY KEY (id)',
  ');',
  'ALTER TABLE public.accounts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();',
  'ALTER TABLE public.accounts ALTER COLUMN email TYPE text;',
  'ALTER TABLE public.accounts ADD FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;',
  'COMMIT;',
  '',
].join('\n');

/** The target dump against the empty model, reversed: the workspace as the target. */
const EXPECTED_REVERSED_COMPARE = [
  '- table public.accounts',
  '    id integer NOT NULL',
  '    email text NOT NULL',
  '    org_id integer',
  '    created_at timestamptz NOT NULL DEFAULT now()',
  '    primary key (id)',
  '    foreign key (org_id) → public.orgs (id) on delete CASCADE',
  '',
  '- table public.orgs',
  '    id integer NOT NULL',
  '    name text NOT NULL',
  '    primary key (id)',
  '',
  '- table public.projects',
  '    id integer NOT NULL',
  '    name text NOT NULL',
  '    primary key (id)',
  '',
].join('\n');

/** The same reversal as a plan: every table in the target dump is dropped. */
const EXPECTED_REVERSED_PLAN = [
  '3 steps in one transaction:',
  ' 1. drop-table  public.accounts',
  ' 2. drop-table  public.orgs',
  ' 3. drop-table  public.projects',
  '',
  'BEGIN;',
  'DROP TABLE public.accounts;',
  'DROP TABLE public.orgs;',
  'DROP TABLE public.projects;',
  'COMMIT;',
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

/** A dump whose partial index the importer skips whole and names. */
const PARTIAL_INDEX_DUMP = [
  'CREATE TABLE public.users (',
  '    id integer NOT NULL',
  ');',
  '',
  'CREATE INDEX idx_users_email ON public.users (id) WHERE id > 0;',
  '',
].join('\n');

/** A dump whose unique constraint carries an attribute the importer flags and drops. */
const FLAG_DUMP = [
  'CREATE TABLE public.users (',
  '    id integer NOT NULL,',
  '    email text',
  ');',
  '',
  'ALTER TABLE ONLY public.users ADD CONSTRAINT users_email_key UNIQUE NULLS NOT DISTINCT (email);',
  '',
].join('\n');

/** A dump whose unique constraint, check constraint, and plain index all import whole. */
const IMPORTABLE_DUMP = [
  'CREATE TABLE public.users (',
  '    id integer NOT NULL,',
  '    email text,',
  '    CONSTRAINT users_email_key UNIQUE (email),',
  '    CONSTRAINT users_id_check CHECK (id > 0)',
  ');',
  '',
  'CREATE INDEX idx_users_email ON public.users USING btree (email);',
  '',
].join('\n');

/**
 * The canonical model bytes `IMPORTABLE_DUMP` imports to, generated by the real serializer:
 * `serializeModel((await importDump(IMPORTABLE_DUMP)).model)`, never hand-formatted. The
 * fixture's table-level constraint names are not part of the imported model, and the plain
 * index is kept named.
 */
const IMPORTABLE_MODEL = `{
  "tables": [
    {
      "schema": "public",
      "name": "users",
      "columns": [
        {
          "name": "id",
          "type": "integer",
          "notNull": true
        },
        {
          "name": "email",
          "type": "text",
          "notNull": false
        }
      ],
      "foreignKeys": [],
      "uniqueConstraints": [
        {
          "columns": [
            "email"
          ]
        }
      ],
      "checkConstraints": [
        {
          "expression": "id > 0"
        }
      ],
      "indexes": [
        {
          "name": "idx_users_email",
          "unique": false,
          "columns": [
            "email"
          ]
        }
      ]
    }
  ],
  "sequences": [],
  "views": [],
  "extensions": []
}
`;

/** A dump carrying non-ASCII text the importer keeps byte-identically, for stdin. */
const STDIN_DUMP = [
  'CREATE TABLE public.phrases (',
  '    id integer NOT NULL,',
  "    label text NOT NULL DEFAULT 'café'",
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
  '  compare [options] [baseline] [target]  Print the diff and any hazards between a baseline and a target.',
  '  export [options]                       Print the workspace model as DDL or canonical JSON.',
  '  init [options] [path]                  Create a workspace in a directory.',
  '  plan [options] [baseline] [target]     Print the migration plan and its SQL between a baseline and a target.',
  '  help [command]                         display help for command',
  '',
].join('\n');

/** What `compare --help` prints to stdout. */
const COMPARE_HELP = [
  'Usage: schemamill compare [options] [baseline] [target]',
  '',
  'Print the diff and any hazards between a baseline and a target.',
  '',
  'Arguments:',
  '  baseline              path to the baseline DDL dump',
  '  target                path to the target DDL dump',
  '',
  'Options:',
  '  --baseline-workspace  resolve the baseline from the workspace',
  '  --target-workspace    resolve the target from the workspace',
  '  --verbose             list every import diagnostic',
  '  --json                emit a structured JSON document',
  '  -h, --help            display help for command',
  '',
  'A single path is the target; the workspace fills the baseline.',
  '',
].join('\n');

/** What `export --help` prints to stdout. */
const EXPORT_HELP = [
  'Usage: schemamill export [options]',
  '',
  'Print the workspace model as DDL or canonical JSON.',
  '',
  'Options:',
  '  --format <format>         output format: ddl or json (default: "ddl")',
  '  --target-version <major>  PostgreSQL major (13-18) (default: "13")',
  '  -h, --help                display help for command',
  '',
].join('\n');

/** What `plan --help` prints to stdout. */
const PLAN_HELP = [
  'Usage: schemamill plan [options] [baseline] [target]',
  '',
  'Print the migration plan and its SQL between a baseline and a target.',
  '',
  'Arguments:',
  '  baseline                  path to the baseline DDL dump',
  '  target                    path to the target DDL dump',
  '',
  'Options:',
  '  --baseline-workspace      resolve the baseline from the workspace',
  '  --target-workspace        resolve the target from the workspace',
  '  --verbose                 list every import diagnostic',
  '  --target-version <major>  PostgreSQL major (13-18) (default: "13")',
  '  --json                    emit a structured JSON document',
  '  -h, --help                display help for command',
  '',
  'A single path is the target; the workspace fills the baseline.',
  '',
].join('\n');

/** What `init --help` prints to stdout; the path argument keeps Commander's `(default: ".")`. */
const INIT_HELP = [
  'Usage: schemamill init [options] [path]',
  '',
  'Create a workspace in a directory.',
  '',
  'Arguments:',
  '  path           directory for the workspace (default: the current directory)',
  '                 (default: ".")',
  '',
  'Options:',
  '  --from <dump>  import a DDL dump into the new workspace (- for stdin)',
  '  --verbose      list every import diagnostic',
  '  -h, --help     display help for command',
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

/** Writes `contents` as `<root>/.schemamill/model.json`, creating the marker directory. */
async function writeWorkspaceModel(root: string, contents: string): Promise<void> {
  const marker = join(root, '.schemamill');
  await mkdir(marker, { recursive: true });
  await writeFile(join(marker, 'model.json'), contents, 'utf8');
}

/** A checked-in fixture dump under `test/fixtures`, as a filesystem path. */
function fixturePath(fileName: string): string {
  return fileURLToPath(new URL(`../test/fixtures/${fileName}`, import.meta.url));
}

/** A checked-in file under `test/` (a fixture or a golden), verbatim. */
function testText(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../test/${relativePath}`, import.meta.url)), 'utf8');
}

/** A fresh temp workspace holding the committed export fixture model, for `export` runs. */
async function exportWorkspace(context: TestContext): Promise<string> {
  const root = await fixtureDir(context);
  const created = await initWorkspace(root, EXPORT_MODEL);
  assert.equal(created.ok, true);
  return root;
}

interface RunOptions {
  /** Working directory for the spawned CLI; defaults to the test process's own. */
  readonly cwd?: string;
}

/**
 * Spawns the built CLI and captures both streams and the exit code, success or failure.
 * A trailing options object sets the spawned cwd — a workspace above it decides what a
 * workspace-resolved side reads.
 */
async function runCli(...args: readonly (string | RunOptions)[]): Promise<CliResult> {
  const last = args.at(-1);
  const options: RunOptions = typeof last === 'object' ? last : {};
  const argv = (typeof last === 'object' ? args.slice(0, -1) : args) as readonly string[];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv], {
      encoding: 'utf8',
      cwd: options.cwd,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code };
  }
}

/**
 * Spawns the built CLI with `input` written to a closed stdin pipe and captures both streams
 * and the exit code. A synchronous spawn is required: stdin must be fed and closed without
 * leaving the reader waiting for EOF.
 */
function runCliWithInput(
  input: string,
  argv: readonly string[],
  options: RunOptions = {},
): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...argv], {
    input,
    encoding: 'utf8',
    cwd: options.cwd,
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? undefined };
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

/**
 * The reason `JSON.parse` reports for `text`. The V8 wording is version-dependent, so the pin
 * mirrors it by parsing the same bytes in this process instead of hardcoding a message; the
 * spawned CLI runs the same Node binary, so the texts match.
 */
function jsonParseFailure(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected invalid JSON');
}

test('compare prints the diff, and only the diff, when there are no hazards', async (t) => {
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

test('plan prints the display before a render refusal, then one stderr line, exit 1', async () => {
  // Two creates resolve to `t_a_idx`: the unnamed index imports unnamed and the explicit twin
  // keeps its name, so `renderSql` refuses. The plan display is already on stdout — the blank
  // line is the SQL separator with no SQL behind it — and stderr is exactly one line: never a
  // stack trace.
  const baseline = fixturePath('index-name-twin.baseline.sql');
  const target = fixturePath('index-name-twin.target.sql');

  const result = await runCli('plan', baseline, target);

  assert.equal(
    result.stdout,
    [
      '2 steps in one transaction:',
      ' 1. create-index  public.t: index (a)',
      ' 2. create-index  public.t: index t_a_idx (a)',
      '',
      '',
    ].join('\n'),
  );
  assert.equal(
    result.stderr,
    'schemamill: refusing to render: index creates on public.t would share the name "t_a_idx": an unnamed index on (a) and an index named "t_a_idx" on (a)\n',
  );
  assert.equal(result.code, 1);
});

test('plan --target-version 13 refuses the synthesized resets, display first', async () => {
  // The display is version-free: the golden's text before its SQL carries the plan and the
  // hazards. Target 13 refuses the first reset in plan order — the storage removal on
  // `public.attrs.s_remove` — before the compression reset later in the same plan.
  const baseline = fixturePath('column-attributes.baseline.sql');
  const target = fixturePath('column-attributes.target.sql');
  const golden = testText('goldens/column-attributes.plan.txt');
  const sqlAt = golden.indexOf('BEGIN;');
  assert.notEqual(sqlAt, -1, 'the golden carries the migration SQL');
  const display = golden.slice(0, sqlAt);
  assert.notEqual(display, '');
  assert.match(display, /steps in one transaction:/u);

  const refused = await runCli('plan', baseline, target, '--target-version', '13');

  assert.equal(refused.stdout, display);
  assert.equal(
    refused.stderr,
    'schemamill: refusing to render for PostgreSQL 13: SET STORAGE DEFAULT on public.attrs column s_remove needs PostgreSQL 16 or newer\n',
  );
  assert.equal(refused.code, 1);

  // Target 14 admits the compression reset (its floor) and still refuses the storage reset:
  // the first refusal names the storage form, not the compression one.
  const boundary = await runCli('plan', baseline, target, '--target-version', '14');

  assert.equal(boundary.stdout, display);
  assert.equal(
    boundary.stderr,
    'schemamill: refusing to render for PostgreSQL 14: SET STORAGE DEFAULT on public.attrs column s_remove needs PostgreSQL 16 or newer\n',
  );
  assert.equal(boundary.code, 1);
});

test('an invalid --target-version is a usage error before any filesystem access, exit 1', async () => {
  // The paths do not exist: reaching a read would produce a `cannot read` line instead, so the
  // pinned usage error proves the flag is validated before any filesystem access.
  for (const value of ['12', '19', '13.4', 'abc']) {
    const result = await runCli(
      'plan',
      'definitely-missing-baseline.sql',
      'definitely-missing-target.sql',
      '--target-version',
      value,
    );

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'error: --target-version must be a PostgreSQL major from 13 to 18\n',
    );
    assert.equal(result.code, 1);
  }
});

test("plan --target-version without a value is Commander's usage error", async () => {
  const result = await runCli('plan', '--target-version');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: option '--target-version <major>' argument missing\n");
  assert.equal(result.code, 1);
});

test('an explicit target never changes the output of a reset-free plan', async () => {
  // `constraints-indexes` renders no storage or compression statement, so both runs must emit
  // the same bytes: the flag is inert above the closed list of two synthesized forms.
  const baseline = fixturePath('constraints-indexes.baseline.sql');
  const target = fixturePath('constraints-indexes.target.sql');

  const implicit = await runCli('plan', baseline, target);
  const explicit = await runCli('plan', baseline, target, '--target-version', '16');

  assert.notEqual(implicit.stdout, '');
  assert.equal(implicit.stderr, '');
  assert.equal(implicit.code, 0);
  assert.equal(explicit.stderr, '');
  assert.equal(explicit.code, 0);
  assert.equal(explicit.stdout, implicit.stdout);
});

test('compare takes no --target-version', async () => {
  // `compare` renders nothing, so the flag is deliberately absent and Commander rejects it.
  const baseline = fixturePath('column-attributes.baseline.sql');
  const target = fixturePath('column-attributes.target.sql');

  const result = await runCli('compare', baseline, target, '--target-version', '13');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: unknown option '--target-version'\n");
  assert.equal(result.code, 1);
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
  const dump = await writeDump(dir, 'dump.sql', PARTIAL_INDEX_DUMP);

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
      'baseline: [skip] skipped CREATE INDEX public.idx_users_email (partial WHERE) (5:1)',
      'target: 1 skipped',
      'target: [skip] skipped CREATE INDEX public.idx_users_email (partial WHERE) (5:1)',
      '',
    ].join('\n'),
  );
  assert.equal(verbose.code, 0);
});

test('check constraints, unique constraints, and plain indexes import without diagnostics', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', IMPORTABLE_DUMP);

  const result = await runCli('compare', dump, dump, '--verbose');

  assert.equal(result.stdout, 'No changes.\n');
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
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
      'baseline: [flag] dropped NULLS NOT DISTINCT on unique constraint users_email_key from public.users (6:1)',
      'target: 1 flagged',
      'target: [flag] dropped NULLS NOT DISTINCT on unique constraint users_email_key from public.users (6:1)',
      '',
    ].join('\n'),
  );
  assert.equal(verbose.code, 0);
});

test('plan --verbose adds the skip line', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', PARTIAL_INDEX_DUMP);

  const result = await runCli('plan', dump, dump, '--verbose');

  assert.equal(result.stdout, 'No changes.\n');
  assert.equal(
    result.stderr,
    [
      'baseline: 1 skipped',
      'baseline: [skip] skipped CREATE INDEX public.idx_users_email (partial WHERE) (5:1)',
      'target: 1 skipped',
      'target: [skip] skipped CREATE INDEX public.idx_users_email (partial WHERE) (5:1)',
      '',
    ].join('\n'),
  );
  assert.equal(result.code, 0);
});

test('a lone compare path is the target and the workspace fills the baseline', async (t) => {
  // The workspace model is the pinned init default, so it reads as an empty dump: the run
  // must be byte-identical to the same pair with a written-out empty baseline.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  const workspaceRun = await runCli('compare', target, { cwd: root });
  const dumpRun = await runCli('compare', empty, target);

  assert.equal(dumpRun.stderr, '');
  assert.equal(dumpRun.code, 0);
  assert.equal(workspaceRun.stdout, dumpRun.stdout);
  assert.equal(workspaceRun.stderr, '');
  assert.equal(workspaceRun.code, 0);
});

test('a lone plan path is the target and the workspace fills the baseline', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  const workspaceRun = await runCli('plan', target, { cwd: root });
  const dumpRun = await runCli('plan', empty, target);

  assert.equal(dumpRun.stderr, '');
  assert.equal(dumpRun.code, 0);
  assert.equal(workspaceRun.stdout, dumpRun.stdout);
  assert.equal(workspaceRun.stderr, '');
  assert.equal(workspaceRun.code, 0);
});

test('--target-workspace reverses compare: the path is the baseline, pinned', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  const workspaceRun = await runCli('compare', '--target-workspace', target, { cwd: root });
  const reversedRun = await runCli('compare', target, empty);

  assert.equal(workspaceRun.stdout, EXPECTED_REVERSED_COMPARE);
  assert.equal(workspaceRun.stdout, reversedRun.stdout);
  assert.equal(workspaceRun.stderr, '');
  assert.equal(workspaceRun.code, 0);
});

test('--target-workspace reverses plan: the path is the baseline, pinned', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  const workspaceRun = await runCli('plan', '--target-workspace', target, { cwd: root });
  const reversedRun = await runCli('plan', target, empty);

  assert.equal(workspaceRun.stdout, EXPECTED_REVERSED_PLAN);
  assert.equal(workspaceRun.stdout, reversedRun.stdout);
  assert.equal(workspaceRun.stderr, '');
  assert.equal(workspaceRun.code, 0);
});

test('--baseline-workspace is the explicit form of the one-path default', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_MODEL);
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const implicit = await runCli(command, target, { cwd: root });
    const explicit = await runCli(command, '--baseline-workspace', target, { cwd: root });

    assert.equal(implicit.stdout, explicit.stdout);
    assert.equal(explicit.stderr, '');
    assert.equal(explicit.code, 0);
  }
});

test('the nearest workspace root wins from a nested directory', async (t) => {
  const outer = await fixtureDir(t);
  await writeWorkspaceModel(outer, STALE_MODEL);
  const inner = join(outer, 'inner');
  await writeWorkspaceModel(inner, EMPTY_MODEL);
  const cwd = join(inner, 'nested');
  await mkdir(cwd, { recursive: true });

  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  const nestedRun = await runCli('compare', target, { cwd });
  const emptyRun = await runCli('compare', empty, target);
  const outerRun = await runCli('compare', target, { cwd: outer });

  // The inner (empty) model won; the outer (stale) model would have changed the output.
  assert.equal(nestedRun.stdout, emptyRun.stdout);
  assert.notEqual(outerRun.stdout, nestedRun.stdout);
  assert.equal(nestedRun.stderr, '');
  assert.equal(nestedRun.code, 0);
});

test('two explicit paths never resolve the workspace', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, STALE_MODEL);
  const dumps = await fixtureDir(t);
  const baseline = await writeDump(dumps, 'baseline.sql', BASELINE_DUMP);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);
  const outside = await fixtureDir(t);

  const insideCompare = await runCli('compare', baseline, target, { cwd: root });
  const outsideCompare = await runCli('compare', baseline, target, { cwd: outside });
  assert.equal(insideCompare.stdout, EXPECTED_COMPARE);
  assert.equal(insideCompare.stdout, outsideCompare.stdout);
  assert.equal(insideCompare.stderr, '');
  assert.equal(insideCompare.code, 0);

  const insidePlan = await runCli('plan', baseline, target, { cwd: root });
  const outsidePlan = await runCli('plan', baseline, target, { cwd: outside });
  assert.equal(insidePlan.stdout, EXPECTED_PLAN);
  assert.equal(insidePlan.stdout, outsidePlan.stdout);
  assert.equal(insidePlan.stderr, '');
  assert.equal(insidePlan.code, 0);
});

test('a one-path run outside any workspace reports no workspace found, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const target = await writeDump(dir, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: dir });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `schemamill: no workspace found from ${dir}\n`);
    assert.equal(result.code, 1);
  }
});

test('a marker file reports workspace-marker-invalid, exit 1', async (t) => {
  // `.schemamill` as a regular file: stat succeeds and isDirectory is false, so the nearest
  // marker is reported, never walked past.
  const root = await fixtureDir(t);
  const marker = join(root, '.schemamill');
  await writeFile(marker, 'not a directory', 'utf8');
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `schemamill: ${marker} is not a directory\n`);
    assert.equal(result.code, 1);
  }
});

test('a self-referential marker symlink reports workspace-inaccessible, exit 1', async (t) => {
  // `.schemamill -> .schemamill` makes stat fail with ELOOP — not a missing marker, so core
  // reports it as workspace-inaccessible with the marker path and the reason (root-robust,
  // unlike a chmod recipe).
  const root = await fixtureDir(t);
  const marker = join(root, '.schemamill');
  await symlink('.schemamill', marker);
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `schemamill: cannot access ${marker}: ELOOP: too many symbolic links encountered, stat '${marker}'\n`,
    );
    assert.equal(result.code, 1);
  }
});

test('a marker without a model reports workspace-model-missing, exit 1', async (t) => {
  const root = await fixtureDir(t);
  const marker = join(root, '.schemamill');
  await mkdir(marker);
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `schemamill: no model file at ${join(marker, 'model.json')}\n`);
    assert.equal(result.code, 1);
  }
});

test('a model path that is a directory reports workspace-model-unreadable, exit 1', async (t) => {
  // `model.json` as a directory: readFile fails EISDIR on every user (a chmod recipe would be
  // ignored by root), and core maps it to workspace-model-unreadable with path and reason.
  const root = await fixtureDir(t);
  const modelPath = join(root, '.schemamill', 'model.json');
  await mkdir(modelPath, { recursive: true });
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: root });

    assert.equal(result.stdout, '');
    // Node 24 ends the message at "read"; Node 26 appends the quoted path.
    assert.match(
      result.stderr,
      new RegExp(
        `^schemamill: cannot read ${escapeRegExp(modelPath)}: EISDIR: illegal operation on a directory, read(?: '${escapeRegExp(modelPath)}')?\\n$`,
      ),
    );
    assert.equal(result.code, 1);
  }
});

test('corrupt model JSON reports workspace-model-invalid, exit 1', async (t) => {
  const root = await fixtureDir(t);
  const modelPath = join(root, '.schemamill', 'model.json');
  const corrupt = '{"tables": ';
  await writeWorkspaceModel(root, corrupt);
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `schemamill: cannot parse ${modelPath}: ${jsonParseFailure(corrupt)}\n`,
    );
    assert.equal(result.code, 1);
  }
});

test('an unknown model field reports workspace-model-invalid, exit 1', async (t) => {
  // The canonical model carries no version field; the reader fails closed on unknown keys.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, '{"tables": [], "sequences": [], "version": 1}\n');
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'schemamill: invalid model: unknown field version\n');
    assert.equal(result.code, 1);
  }
});

test('a workspace model with an empty index name is rejected before formatting, exit 1', async (t) => {
  // The corrupt model sits on the workspace side the command reads. `plan` and `compare` take the
  // empty baseline dump as their path and the workspace as the target, so the empty index name is
  // rejected by the reader before any diff, plan, format, or render sees the model.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_INDEX_NAME_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const cases: ReadonlyArray<readonly string[]> = [
    ['plan', '--target-workspace', empty],
    ['compare', '--target-workspace', empty],
    ['export'],
  ];

  for (const args of cases) {
    const result = await runCli(...args, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'schemamill: invalid model: tables[0].indexes[0].name is not a non-empty string\n',
    );
    assert.equal(result.code, 1);
  }
});

test('a workspace model with an empty index column list is rejected before formatting, exit 1', async (t) => {
  // The corrupt model sits on the workspace side the command reads. `plan` and `compare` take the
  // empty baseline dump as their path and the workspace as the target, so the empty column list is
  // rejected by the reader before any diff, plan, format, or render sees the model. `export` has
  // two projections (ddl and json); both read the workspace model and must fail before either
  // renders the invalid `USING btree ()` clause.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_INDEX_COLUMNS_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const cases: ReadonlyArray<readonly string[]> = [
    ['plan', '--target-workspace', empty],
    ['compare', '--target-workspace', empty],
    ['export'],
    ['export', '--format', 'json'],
  ];

  for (const args of cases) {
    const result = await runCli(...args, { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'schemamill: invalid model: tables[0].indexes[0].columns is not a non-empty list\n',
    );
    assert.equal(result.code, 1);
  }
});

test('a workspace model with a non-empty index column list is accepted, exit 0', async (t) => {
  // Control: the same model with a non-empty identifier list still plans, compares, and exports.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, NON_EMPTY_INDEX_COLUMNS_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const cases: ReadonlyArray<readonly string[]> = [
    ['plan', '--target-workspace', empty],
    ['compare', '--target-workspace', empty],
    ['export'],
    ['export', '--format', 'json'],
  ];

  for (const args of cases) {
    const result = await runCli(...args, { cwd: root });

    assert.equal(result.stderr, '');
    assert.notEqual(result.code, 1);
  }
});

test('a workspace model with an empty column type is rejected before planning, exit 1', async (t) => {
  // The workspace is the plan target; the reader rejects `type: ""` before any diff or render,
  // because `"c"  NOT NULL` has no type and cannot execute.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_TYPE_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');

  const result = await runCli('plan', '--target-workspace', empty, { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'schemamill: invalid model: tables[0].columns[0].type is not a non-empty string\n',
  );
  assert.equal(result.code, 1);
});

test('a workspace model with an empty column default is rejected before comparing, exit 1', async (t) => {
  // The workspace is the compare target; `DEFAULT ` would dangle, so the reader fails closed.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_DEFAULT_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');

  const result = await runCli('compare', '--target-workspace', empty, { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'schemamill: invalid model: tables[0].columns[0].default is not a non-empty string\n',
  );
  assert.equal(result.code, 1);
});

test('a workspace model with an empty check expression is rejected before exporting DDL, exit 1', async (t) => {
  // `export` reads the workspace on cwd; `CHECK ()` cannot execute, so the DDL projection never renders.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_EXPRESSION_MODEL);

  const result = await runCli('export', { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'schemamill: invalid model: tables[0].checkConstraints[0].expression is not a non-empty string\n',
  );
  assert.equal(result.code, 1);
});

test('a workspace model with an empty view definition is rejected before exporting JSON, exit 1', async (t) => {
  // `export --format json` plans before its format branch; `CREATE VIEW … AS ;` cannot execute, so
  // neither projection runs and the same one-line reader diagnostic surfaces.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_DEFINITION_MODEL);

  const result = await runCli('export', '--format', 'json', { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'schemamill: invalid model: views[0].definition is not a non-empty string\n',
  );
  assert.equal(result.code, 1);
});

test('a workspace model with real non-identifier string values is accepted, exit 0', async (t) => {
  // Control: a model with real type, default, expression, and definition values still plans,
  // compares, and exports both projections — the four new rejections do not over-reject.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, VALID_NON_IDENTIFIER_STRINGS_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const cases: ReadonlyArray<readonly string[]> = [
    ['plan', '--target-workspace', empty],
    ['compare', '--target-workspace', empty],
    ['export'],
    ['export', '--format', 'json'],
  ];

  for (const args of cases) {
    const result = await runCli(...args, { cwd: root });

    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
  }
});

test('a corrupt nearest marker is reported, never skipped for a healthy outer workspace, exit 1', async (t) => {
  // The outer workspace would resolve (its stale model differs from the dumps), so an inner
  // failure that skipped the corrupt marker would change the run: nearest wins, corrupt or not.
  const outer = await fixtureDir(t);
  await writeWorkspaceModel(outer, STALE_MODEL);
  const inner = join(outer, 'inner');
  await mkdir(inner);
  const marker = join(inner, '.schemamill');
  await writeFile(marker, 'not a directory', 'utf8');
  const dumps = await fixtureDir(t);
  const target = await writeDump(dumps, 'target.sql', TARGET_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, target, { cwd: inner });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `schemamill: ${marker} is not a directory\n`);
    assert.equal(result.code, 1);
  }
});

test('when both sides fail, the baseline failure is the only report, exit 1', async (t) => {
  // The baseline path is read first; the target's workspace has no marker anywhere above it,
  // and must never be resolved — exactly one stderr line, and no artifact.
  const dumps = await fixtureDir(t);
  const missing = join(dumps, 'missing.sql');
  const outside = await fixtureDir(t);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, '--target-workspace', missing, { cwd: outside });

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `schemamill: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
    );
    assert.equal(result.code, 1);
  }
});

test('a workspace side contributes no import diagnostics, even with --verbose', async (t) => {
  // The workspace model is the pinned init default, so the run equals the same pair with a
  // written-out empty baseline: stderr carries only the target dump's skip lines.
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, EMPTY_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');
  const dump = await writeDump(dumps, 'dump.sql', PARTIAL_INDEX_DUMP);
  const expectedStderr = [
    'target: 1 skipped',
    'target: [skip] skipped CREATE INDEX public.idx_users_email (partial WHERE) (5:1)',
    '',
  ].join('\n');

  for (const command of ['compare', 'plan'] as const) {
    const workspaceRun = await runCli(command, dump, '--verbose', { cwd: root });
    const dumpRun = await runCli(command, empty, dump, '--verbose');

    assert.equal(dumpRun.stderr, expectedStderr);
    assert.equal(dumpRun.code, 0);
    assert.equal(workspaceRun.stdout, dumpRun.stdout);
    assert.equal(workspaceRun.stderr, expectedStderr);
    assert.equal(workspaceRun.code, 0);
  }
});

test('each side is resolved or read before the next, and the first failure is the only report', async (t) => {
  // The marker root and the missing path both fail: whichever side is processed first decides
  // the single stderr line. The fix case has the baseline workspace resolved first; the
  // --target-workspace case has the baseline path read first.
  const root = await fixtureDir(t);
  const marker = join(root, '.schemamill');
  await writeFile(marker, 'not a directory', 'utf8');
  const dumps = await fixtureDir(t);
  const missing = join(dumps, 'missing.sql');

  const workspaceBaseline = await runCli('compare', missing, { cwd: root });

  assert.equal(workspaceBaseline.stdout, '');
  assert.equal(workspaceBaseline.stderr, `schemamill: ${marker} is not a directory\n`);
  assert.equal(workspaceBaseline.code, 1);

  const pathBaseline = await runCli('compare', '--target-workspace', missing, { cwd: root });

  assert.equal(pathBaseline.stdout, '');
  assert.equal(
    pathBaseline.stderr,
    `schemamill: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
  );
  assert.equal(pathBaseline.code, 1);
});

test('init creates a workspace in a directory, exit 0', async (t) => {
  const dir = await fixtureDir(t);

  const result = await runCli('init', dir);

  assert.equal(result.stdout, `Initialized workspace at ${dir}\n`);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(dir, '.schemamill', 'model.json'), 'utf8'), EMPTY_MODEL);
});

test('a second init refuses the existing workspace with the repair hint, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  await runCli('init', dir);

  const result = await runCli('init', dir);

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `schemamill: workspace already exists at ${dir}: remove ${join(dir, '.schemamill')} to re-create it\n`,
  );
  assert.equal(result.code, 1);
});

test('init refuses a directory inside an existing workspace, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  await runCli('init', dir);
  const nested = join(dir, 'nested');

  const result = await runCli('init', nested);

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `schemamill: ${nested} is inside the workspace at ${dir}\n`);
  assert.equal(result.code, 1);
});

test('init --from imports the dump into the new workspace, exit 0', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', IMPORTABLE_DUMP);
  const root = join(dir, 'root');

  const result = await runCli('init', root, '--from', dump);

  assert.equal(result.stdout, `Initialized workspace at ${root}\n`);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(root, '.schemamill', 'model.json'), 'utf8'), IMPORTABLE_MODEL);
  assert.deepEqual(await resolveWorkspace(root), {
    ok: true,
    root,
    model: (await importDump(IMPORTABLE_DUMP)).model,
  });
});

test('init --from - reads a dump from stdin, byte-identical to a file-based run', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', STDIN_DUMP);
  const fileRoot = join(dir, 'file-root');
  const stdinRoot = join(dir, 'stdin-root');

  const fileRun = await runCli('init', fileRoot, '--from', dump);
  const stdinRun = runCliWithInput(STDIN_DUMP, ['init', stdinRoot, '--from', '-']);

  assert.equal(fileRun.stdout, `Initialized workspace at ${fileRoot}\n`);
  assert.equal(stdinRun.stdout, `Initialized workspace at ${stdinRoot}\n`);
  const fileModel = await readFile(join(fileRoot, '.schemamill', 'model.json'), 'utf8');
  const stdinModel = await readFile(join(stdinRoot, '.schemamill', 'model.json'), 'utf8');
  assert.match(stdinModel, /café/u);
  assert.equal(stdinModel, fileModel);
  assert.equal(stdinRun.stderr, fileRun.stderr);
  assert.equal(stdinRun.code, fileRun.code);
});

test('a workspace populated from a dump drives compare and plan from root and nested dirs', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', BASELINE_DUMP);
  const target = await writeDump(dir, 'target.sql', TARGET_DUMP);
  const root = join(dir, 'root');
  const nested = join(root, 'nested');

  const init = await runCli('init', root, '--from', baseline);

  assert.equal(init.stdout, `Initialized workspace at ${root}\n`);
  assert.equal(init.stderr, '');
  assert.equal(init.code, 0);
  await mkdir(nested, { recursive: true });

  for (const command of ['compare', 'plan'] as const) {
    const fromRoot = await runCli(command, target, { cwd: root });
    const fromNested = await runCli(command, target, { cwd: nested });
    const twoDumps = await runCli(command, baseline, target);

    assert.equal(fromRoot.stdout, twoDumps.stdout);
    assert.equal(fromNested.stdout, twoDumps.stdout);
    assert.equal(fromRoot.stderr, '');
    assert.equal(fromNested.stderr, '');
    assert.equal(fromRoot.code, 0);
    assert.equal(fromNested.code, 0);
  }
});

test('init --from - with empty stdin writes the empty model, exit 0', async (t) => {
  const dir = await fixtureDir(t);
  const root = join(dir, 'root');

  const result = runCliWithInput('', ['init', root, '--from', '-']);

  assert.equal(result.stdout, `Initialized workspace at ${root}\n`);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  assert.equal(await readFile(join(root, '.schemamill', 'model.json'), 'utf8'), EMPTY_MODEL);
});

test('init --from refuses a parse failure without creating a workspace, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  // PARSE_FAILURE_TARGET is the broken half of the pair: its "));" is the 7:2 syntax error.
  const dump = await writeDump(dir, 'dump.sql', PARSE_FAILURE_TARGET);
  const root = join(dir, 'root');

  const result = await runCli('init', root, '--from', dump);

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'source: 1 failed\nsource: [error] syntax error at or near ")" (7:2)\n',
  );
  assert.equal(result.code, 1);
  await assert.rejects(access(join(root, '.schemamill')));
});

test('init --from writes a skip-only dump, and --verbose adds the skip line', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', PARTIAL_INDEX_DUMP);
  const quietRoot = join(dir, 'quiet');
  const verboseRoot = join(dir, 'verbose');

  const quiet = await runCli('init', quietRoot, '--from', dump);

  assert.equal(quiet.stdout, `Initialized workspace at ${quietRoot}\n`);
  assert.equal(quiet.stderr, 'source: 1 skipped\n');
  assert.equal(quiet.code, 0);
  assert.deepEqual(await resolveWorkspace(quietRoot), {
    ok: true,
    root: quietRoot,
    model: (await importDump(PARTIAL_INDEX_DUMP)).model,
  });

  const verbose = await runCli('init', verboseRoot, '--from', dump, '--verbose');

  assert.equal(verbose.stdout, `Initialized workspace at ${verboseRoot}\n`);
  assert.equal(
    verbose.stderr,
    'source: 1 skipped\nsource: [skip] skipped CREATE INDEX public.idx_users_email (partial WHERE) (5:1)\n',
  );
  assert.equal(verbose.code, 0);
});

test('init --from writes a flag-only dump, and --verbose adds the flag line', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', FLAG_DUMP);
  const quietRoot = join(dir, 'quiet');
  const verboseRoot = join(dir, 'verbose');

  const quiet = await runCli('init', quietRoot, '--from', dump);

  assert.equal(quiet.stdout, `Initialized workspace at ${quietRoot}\n`);
  assert.equal(quiet.stderr, 'source: 1 flagged\n');
  assert.equal(quiet.code, 0);
  assert.deepEqual(await resolveWorkspace(quietRoot), {
    ok: true,
    root: quietRoot,
    model: (await importDump(FLAG_DUMP)).model,
  });

  const verbose = await runCli('init', verboseRoot, '--from', dump, '--verbose');

  assert.equal(verbose.stdout, `Initialized workspace at ${verboseRoot}\n`);
  assert.equal(
    verbose.stderr,
    'source: 1 flagged\nsource: [flag] dropped NULLS NOT DISTINCT on unique constraint users_email_key from public.users (6:1)\n',
  );
  assert.equal(verbose.code, 0);
});

test('init --from imports before refusing an existing workspace, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const root = join(dir, 'root');
  const created = await runCli('init', root);
  assert.equal(created.code, 0);
  const modelPath = join(root, '.schemamill', 'model.json');
  const original = await readFile(modelPath, 'utf8');
  const repairHint = `schemamill: workspace already exists at ${root}: remove ${join(root, '.schemamill')} to re-create it\n`;

  const cleanDump = await writeDump(dir, 'clean.sql', IMPORTABLE_DUMP);
  const skipDump = await writeDump(dir, 'skip.sql', PARTIAL_INDEX_DUMP);
  const brokenDump = await writeDump(dir, 'broken.sql', PARSE_FAILURE_TARGET);

  const clean = await runCli('init', root, '--from', cleanDump);

  assert.equal(clean.stdout, '');
  assert.equal(clean.stderr, repairHint);
  assert.equal(clean.code, 1);
  assert.equal(await readFile(modelPath, 'utf8'), original);

  const skip = await runCli('init', root, '--from', skipDump);

  assert.equal(skip.stdout, '');
  assert.equal(skip.stderr, `source: 1 skipped\n${repairHint}`);
  assert.equal(skip.code, 1);
  assert.equal(await readFile(modelPath, 'utf8'), original);

  const broken = await runCli('init', root, '--from', brokenDump);

  assert.equal(broken.stdout, '');
  assert.equal(
    broken.stderr,
    'source: 1 failed\nsource: [error] syntax error at or near ")" (7:2)\n',
  );
  assert.equal(broken.code, 1);
  assert.equal(await readFile(modelPath, 'utf8'), original);
});

test('init --from refuses a target inside an existing workspace, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const root = join(dir, 'root');
  await runCli('init', root);
  const nested = join(root, 'nested');
  const dump = await writeDump(dir, 'dump.sql', IMPORTABLE_DUMP);

  const result = await runCli('init', nested, '--from', dump);

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `schemamill: ${nested} is inside the workspace at ${root}\n`);
  assert.equal(result.code, 1);
  await assert.rejects(access(join(nested, '.schemamill')));
});

test('init --from reports a missing dump before any filesystem change, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const root = join(dir, 'root');
  const missing = join(dir, 'missing.sql');

  const result = await runCli('init', root, '--from', missing);

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `schemamill: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`,
  );
  assert.equal(result.code, 1);
  await assert.rejects(access(join(root, '.schemamill')));
});

test('init --from imports before refusing a target that is a file, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', IMPORTABLE_DUMP);
  const target = await writeDump(dir, 'target.txt', 'not a directory');

  const result = await runCli('init', target, '--from', dump);

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `schemamill: ${target} is not a directory\n`);
  assert.equal(result.code, 1);
  assert.equal(await readFile(target, 'utf8'), 'not a directory');
});

test('init --from without a value is a usage error before any filesystem access, exit 1', async (t) => {
  const dir = await fixtureDir(t);

  const result = await runCli('init', '--from', { cwd: dir });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: option '--from <dump>' argument missing\n");
  assert.equal(result.code, 1);
  await assert.rejects(access(join(dir, '.schemamill')));
});

test('init --help documents --from and --verbose, exit 0', async () => {
  const result = await runCli('init', '--help');

  assert.equal(result.stdout, INIT_HELP);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('export prints exactly the export.ddl.sql golden, exit 0', async (t) => {
  const root = await exportWorkspace(t);

  const result = await runCli('export', { cwd: root });

  assert.equal(result.stdout, testText('goldens/export.ddl.sql'));
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('export --format json prints the canonical bytes and parses back to the model', async (t) => {
  const root = await exportWorkspace(t);

  const result = await runCli('export', '--format', 'json', { cwd: root });

  assert.equal(result.stdout, testText('goldens/export.json.txt'));
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  const resolution = await resolveWorkspace(root);
  assert.ok(resolution.ok);
  assert.deepEqual(JSON.parse(result.stdout), resolution.model);
});

test('export --format=json is the same artifact as --format json', async (t) => {
  const root = await exportWorkspace(t);

  const equalsForm = await runCli('export', '--format=json', { cwd: root });
  const spacedForm = await runCli('export', '--format', 'json', { cwd: root });

  assert.equal(equalsForm.stdout, testText('goldens/export.json.txt'));
  assert.equal(equalsForm.stdout, spacedForm.stdout);
  assert.equal(equalsForm.stderr, '');
  assert.equal(equalsForm.code, 0);
});

test('export --target-version accepts every declared major with byte-identical DDL', async (t) => {
  // Export plans `EMPTY_MODEL → model`, so every step is a create; no create form consults the
  // target, and the forwarded value is output-invisible today. The four runs pin that honesty.
  const root = await exportWorkspace(t);
  const golden = testText('goldens/export.ddl.sql');

  for (const value of ['13', '14', '16', '18']) {
    const result = await runCli('export', '--target-version', value, { cwd: root });

    assert.equal(result.stdout, golden);
    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
  }
});

test('export --format json --target-version 18 prints the canonical bytes unchanged', async (t) => {
  // The flag keys rendering only; `serializeModel` never sees it.
  const root = await exportWorkspace(t);

  const result = await runCli('export', '--format', 'json', '--target-version', '18', {
    cwd: root,
  });

  assert.equal(result.stdout, testText('goldens/export.json.txt'));
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('export of an empty workspace prints an empty DDL script and the empty model', async (t) => {
  const root = await fixtureDir(t);
  const created = await initWorkspace(root);
  assert.equal(created.ok, true);

  const ddl = await runCli('export', { cwd: root });

  assert.equal(ddl.stdout, '');
  assert.equal(ddl.stderr, '');
  assert.equal(ddl.code, 0);

  const json = await runCli('export', '--format', 'json', { cwd: root });

  assert.equal(json.stdout, EMPTY_MODEL);
  assert.equal(json.stderr, '');
  assert.equal(json.code, 0);
});

test('export outside any workspace is one stderr line, exit 1', async (t) => {
  const dir = await fixtureDir(t);

  const result = await runCli('export', { cwd: dir });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `schemamill: no workspace found from ${dir}\n`);
  assert.equal(result.code, 1);
});

test('export with a corrupt model reports the parse failure, exit 1', async (t) => {
  const root = await fixtureDir(t);
  const modelPath = join(root, '.schemamill', 'model.json');
  const corrupt = '{"tables": ';
  await writeWorkspaceModel(root, corrupt);

  const result = await runCli('export', { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `schemamill: cannot parse ${modelPath}: ${jsonParseFailure(corrupt)}\n`,
  );
  assert.equal(result.code, 1);
});

test('an invalid --format is a usage error before any filesystem access, exit 1', async (t) => {
  const dir = await fixtureDir(t);

  const result = await runCli('export', '--format', 'text', { cwd: dir });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error: --format must be "ddl" or "json"\n');
  assert.equal(result.code, 1);
});

test("export --format without a value is Commander's usage error, exit 1", async () => {
  const result = await runCli('export', '--format');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: option '--format <format>' argument missing\n");
  assert.equal(result.code, 1);
});

test('an invalid export --target-version is a usage error that beats the workspace diagnostic, exit 1', async (t) => {
  // The flag is validated before `resolveWorkspace` in code. The non-workspace cwd pins the
  // observable precedence — the usage error, never a workspace line — while the call order
  // itself is structural, not filesystem-spied. The explicit json case proves validation runs
  // on both projections.
  const dir = await fixtureDir(t);

  for (const value of ['12', '19', '13.4', 'abc']) {
    const result = await runCli('export', '--target-version', value, { cwd: dir });

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'error: --target-version must be a PostgreSQL major from 13 to 18\n',
    );
    assert.equal(result.code, 1);
  }

  const json = await runCli('export', '--format', 'json', '--target-version', '12', {
    cwd: dir,
  });

  assert.equal(json.stdout, '');
  assert.equal(json.stderr, 'error: --target-version must be a PostgreSQL major from 13 to 18\n');
  assert.equal(json.code, 1);
});

test("export --target-version without a value is Commander's usage error, exit 1", async () => {
  const result = await runCli('export', '--target-version');

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "error: option '--target-version <major>' argument missing\n");
  assert.equal(result.code, 1);
});

test('export reports an invalid --format before an invalid --target-version, exit 1', async (t) => {
  // Two invalid values: the pinned --format error proves the checks never swap order.
  const dir = await fixtureDir(t);

  const result = await runCli('export', '--format', 'text', '--target-version', '12', {
    cwd: dir,
  });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'error: --format must be "ddl" or "json"\n');
  assert.equal(result.code, 1);
});

test('export with an extra argument is a usage error naming it, exit 1', async () => {
  const result = await runCli('export', 'extra');

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    "error: too many arguments for 'export'. Expected 0 arguments but got 1: extra.\n",
  );
  assert.equal(result.code, 1);
});

test('export refuses a plan whose index creates share a name, with empty stdout, exit 1', async (t) => {
  const root = await fixtureDir(t);
  const created = await initWorkspace(root, REFUSAL_MODEL);
  assert.equal(created.ok, true);

  const result = await runCli('export', { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'schemamill: refusing to render: index creates on public.t would share the name "t_a_idx": an unnamed index on (a) and an unnamed index on (a)\n',
  );
  assert.equal(result.code, 1);
});

/**
 * The plan-time contract error channel: a hand-edited workspace whose target sequence owner does
 * not resolve is refused by core's `plan()` before any step, and the CLI reports it as exactly
 * one `schemamill:` line on stderr with empty stdout and exit 1 — never a stack trace.
 */
test('plan --target-workspace refuses a dangling target owner on one stderr line, exit 1', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, DANGLING_TABLE_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');

  const result = await runCli('plan', '--target-workspace', empty, { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, DANGLING_TABLE_ERROR);
  assert.equal(result.code, 1);
});

test('compare --target-workspace refuses a dangling target owner on one stderr line, exit 1', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, DANGLING_TABLE_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');

  const result = await runCli('compare', '--target-workspace', empty, { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, DANGLING_TABLE_ERROR);
  assert.equal(result.code, 1);
});

test('export refuses a dangling target owner on one stderr line, exit 1', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, DANGLING_TABLE_MODEL);

  const result = await runCli('export', { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, DANGLING_TABLE_ERROR);
  assert.equal(result.code, 1);
});

test('plan refuses a dangling target owner column on one stderr line, exit 1', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, DANGLING_COLUMN_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');

  const result = await runCli('plan', '--target-workspace', empty, { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, DANGLING_COLUMN_ERROR);
  assert.equal(result.code, 1);
});

test('export --format json refuses a dangling target owner on one stderr line, exit 1', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, DANGLING_TABLE_MODEL);

  const result = await runCli('export', '--format', 'json', { cwd: root });

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, DANGLING_TABLE_ERROR);
  assert.equal(result.code, 1);
});

test('export --help documents --format and --target-version, exit 0', async () => {
  const result = await runCli('export', '--help');

  assert.equal(result.stdout, EXPORT_HELP);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('--help prints the usage to stdout, exit 0', async () => {
  const result = await runCli('--help');

  assert.equal(result.stdout, USAGE);
  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
});

test('compare and plan --help document the workspace surface', async () => {
  const compare = await runCli('compare', '--help');

  assert.equal(compare.stdout, COMPARE_HELP);
  assert.equal(compare.stderr, '');
  assert.equal(compare.code, 0);

  const plan = await runCli('plan', '--help');

  assert.equal(plan.stdout, PLAN_HELP);
  assert.equal(plan.stderr, '');
  assert.equal(plan.code, 0);
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

test('naming no dump path is a usage error naming the workspace alternative, exit 1', async () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ['compare'],
    ['plan'],
    ['compare', '--baseline-workspace'],
    ['plan', '--target-workspace'],
  ];

  for (const args of cases) {
    const result = await runCli(...args);

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'error: name at least one dump path (the workspace can fill the other side)\n',
    );
    assert.equal(result.code, 1);
  }
});

test('both workspace flags are a usage error before any file access, exit 1', async () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ['compare', 'missing-baseline.sql', 'missing-target.sql'],
    ['compare', 'missing-target.sql'],
    ['compare'],
    ['plan', 'missing-baseline.sql'],
  ];

  for (const base of cases) {
    const result = await runCli(...base, '--baseline-workspace', '--target-workspace');

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'error: --baseline-workspace and --target-workspace cannot be combined\n',
    );
    assert.equal(result.code, 1);
  }
});

test('a workspace flag with two paths is a usage error naming the flag, exit 1', async () => {
  const cases = [
    ['--baseline-workspace', 'error: --baseline-workspace cannot be combined with two paths\n'],
    ['--target-workspace', 'error: --target-workspace cannot be combined with two paths\n'],
  ] as const;

  for (const [flag, message] of cases) {
    const result = await runCli('compare', 'missing-baseline.sql', 'missing-target.sql', flag);

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, message);
    assert.equal(result.code, 1);
  }
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

// ---------------------------------------------------------------------------
// --json: command-level document, stream, and exit contract. The pure mapper's recursive key sets
// are pinned in json.test.ts; these scenes prove the commands feed it the right values and that
// the human path stays byte-identical without the flag.
// ---------------------------------------------------------------------------

/** A pair spanning tables, a column, an index, a sequence, a view, an extension, and comments. */
const JSON_BASE_DUMP = [
  'CREATE TABLE public.widgets (',
  '    id integer NOT NULL,',
  '    label text,',
  '    CONSTRAINT widgets_pkey PRIMARY KEY (id)',
  ');',
  '',
  'CREATE TABLE public.retired (',
  '    id integer NOT NULL',
  ');',
  '',
  'CREATE VIEW public.widget_names AS SELECT id,label FROM public.widgets;',
  '',
  "COMMENT ON TABLE public.widgets IS 'old label';",
  '',
].join('\n');

const JSON_TARGET_DUMP = [
  'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;',
  '',
  'CREATE SEQUENCE public.widget_seq',
  '    AS bigint',
  '    INCREMENT BY 0',
  '    NO MINVALUE',
  '    NO MAXVALUE',
  '    CACHE 1;',
  '',
  'CREATE TABLE public.widgets (',
  '    id integer NOT NULL,',
  '    label text NOT NULL,',
  '    score integer,',
  '    CONSTRAINT widgets_pkey PRIMARY KEY (id)',
  ');',
  '',
  'CREATE TABLE public.gadgets (',
  '    id integer NOT NULL,',
  '    widget_id integer,',
  '    CONSTRAINT gadgets_pkey PRIMARY KEY (id)',
  ');',
  '',
  'CREATE INDEX widgets_score_idx ON public.widgets USING btree (score);',
  '',
  'CREATE VIEW public.widget_names AS SELECT id,label,score FROM public.widgets;',
  '',
  'CREATE MATERIALIZED VIEW public.widget_scores AS SELECT id,score FROM public.widgets WITH NO DATA;',
  '',
  'CREATE INDEX CONCURRENTLY widget_scores_score_idx ON public.widget_scores USING btree (score);',
  '',
  "COMMENT ON TABLE public.widgets IS 'new label';",
  '',
  "COMMENT ON EXTENSION pgcrypto IS 'crypto helpers';",
  '',
].join('\n');

/** A dump with one flag and one skip on each side, both complete in the document. */
const JSON_DIAGNOSTICS_DUMP = [
  'CREATE TABLE public.users (',
  '    id integer NOT NULL,',
  '    email text,',
  '    CONSTRAINT users_email_key UNIQUE NULLS NOT DISTINCT (email)',
  ');',
  '',
  'CREATE INDEX idx_users_partial ON public.users (id) WHERE id > 0;',
  '',
].join('\n');

interface JsonCounts {
  readonly tables: number;
  readonly sequences: number;
  readonly views: number;
  readonly extensions: number;
}

/** A typed view over the parsed document for assertions that do not need the whole envelope. */
interface JsonEnvelopeProbe {
  readonly command: string;
  readonly diagnostics: {
    readonly baseline: readonly object[];
    readonly target: readonly object[];
  };
  readonly result: {
    readonly changes?: readonly object[];
    readonly targetVersion?: number;
    readonly steps?: readonly object[];
    readonly groups?: readonly object[];
    readonly hazards?: readonly object[];
  };
}

const RICH_BASELINE_COUNTS: JsonCounts = {
  tables: 2,
  sequences: 0,
  views: 1,
  extensions: 0,
};
const RICH_TARGET_COUNTS: JsonCounts = {
  tables: 2,
  sequences: 1,
  views: 2,
  extensions: 1,
};

/** The documented envelope with the resolved dump paths and the command-specific result. */
function expectedJsonEnvelope(
  command: 'compare' | 'plan',
  baseline: string,
  target: string,
  result: object,
  baselineCounts: JsonCounts = RICH_BASELINE_COUNTS,
  targetCounts: JsonCounts = RICH_TARGET_COUNTS,
): object {
  return {
    schemaVersion: 1,
    command,
    schemamill: { version },
    workspace: null,
    sides: {
      baseline: { source: 'dump', path: baseline, model: baselineCounts },
      target: { source: 'dump', path: target, model: targetCounts },
    },
    diagnostics: { baseline: [], target: [] },
    result,
  };
}

// Shared payloads keep the two expected result literals readable without weakening the comparison.
const JSON_WIDGETS_ID = { schema: 'public', name: 'widgets' };
const JSON_GADGETS_TABLE = {
  schema: 'public',
  name: 'gadgets',
  columns: [
    { name: 'id', type: 'integer', notNull: true },
    { name: 'widget_id', type: 'integer', notNull: false },
  ],
  primaryKey: { columns: ['id'] },
  foreignKeys: [],
  uniqueConstraints: [],
  checkConstraints: [],
  indexes: [],
};
const JSON_RETIRED_TABLE = {
  schema: 'public',
  name: 'retired',
  columns: [{ name: 'id', type: 'integer', notNull: true }],
  foreignKeys: [],
  uniqueConstraints: [],
  checkConstraints: [],
  indexes: [],
};
const JSON_WIDGET_SEQ = {
  schema: 'public',
  name: 'widget_seq',
  dataType: 'bigint',
  increment: '0',
  minValue: '-9223372036854775808',
  maxValue: '-1',
  start: '-1',
  cache: '1',
  cycle: false,
};
const JSON_SCORE_INDEX = { unique: false, columns: ['score'] };
const JSON_CONCURRENT_SCORE_INDEX = { unique: false, columns: ['score'], concurrently: true };
const JSON_WIDGET_NAMES_BEFORE = {
  schema: 'public',
  name: 'widget_names',
  materialized: false,
  definition: 'SELECT id,label FROM public.widgets',
};
const JSON_WIDGET_NAMES_AFTER = {
  schema: 'public',
  name: 'widget_names',
  materialized: false,
  definition: 'SELECT id,label,score FROM public.widgets',
};
const JSON_WIDGET_SCORES_VIEW = {
  schema: 'public',
  name: 'widget_scores',
  materialized: true,
  definition: 'SELECT id,score FROM public.widgets',
  indexes: [JSON_CONCURRENT_SCORE_INDEX],
};
const JSON_PGCRYPTO = { schema: 'public', name: 'pgcrypto', comment: 'crypto helpers' };

const EXPECTED_JSON_CHANGES: readonly object[] = [
  { kind: 'table-added', table: JSON_GADGETS_TABLE },
  { kind: 'table-removed', table: JSON_RETIRED_TABLE },
  {
    kind: 'table-changed',
    table: JSON_WIDGETS_ID,
    changes: [
      {
        kind: 'column-added',
        column: { name: 'score', type: 'integer', notNull: false },
      },
      {
        kind: 'column-changed',
        name: 'label',
        fields: [{ field: 'notNull', before: false, after: true }],
      },
      { kind: 'index-added', index: JSON_SCORE_INDEX },
    ],
  },
  { kind: 'sequence-added', sequence: JSON_WIDGET_SEQ },
  {
    kind: 'view-changed',
    view: { schema: 'public', name: 'widget_names' },
    changes: [
      {
        field: 'definition',
        before: 'SELECT id,label FROM public.widgets',
        after: 'SELECT id,label,score FROM public.widgets',
      },
    ],
    before: JSON_WIDGET_NAMES_BEFORE,
    after: JSON_WIDGET_NAMES_AFTER,
  },
  { kind: 'view-added', view: JSON_WIDGET_SCORES_VIEW },
  { kind: 'extension-added', extension: JSON_PGCRYPTO },
  {
    kind: 'comment-changed',
    target: { kind: 'extension', extension: { name: 'pgcrypto' } },
    after: 'crypto helpers',
  },
  {
    kind: 'comment-changed',
    target: { kind: 'table', table: JSON_WIDGETS_ID },
    before: 'old label',
    after: 'new label',
  },
];

const EXPECTED_JSON_PLAN_RESULT = {
  targetVersion: 13,
  steps: [
    { kind: 'create-extension', extension: JSON_PGCRYPTO },
    { kind: 'create-sequence', sequence: JSON_WIDGET_SEQ },
    { kind: 'drop-table', table: { schema: 'public', name: 'retired' } },
    { kind: 'create-table', table: JSON_GADGETS_TABLE },
    {
      kind: 'add-column',
      table: JSON_WIDGETS_ID,
      column: { name: 'score', type: 'integer', notNull: false },
    },
    {
      kind: 'alter-column',
      table: JSON_WIDGETS_ID,
      name: 'label',
      fields: [{ field: 'notNull', before: false, after: true }],
    },
    {
      kind: 'create-index',
      owner: { kind: 'table', table: JSON_WIDGETS_ID },
      index: JSON_SCORE_INDEX,
    },
    { kind: 'create-view', view: JSON_WIDGET_SCORES_VIEW },
    { kind: 'replace-view', view: JSON_WIDGET_NAMES_AFTER },
    {
      kind: 'create-index-concurrently',
      owner: { kind: 'materialized-view', view: { schema: 'public', name: 'widget_scores' } },
      index: JSON_CONCURRENT_SCORE_INDEX,
    },
    {
      kind: 'comment',
      target: { kind: 'extension', extension: { name: 'pgcrypto' } },
      text: 'crypto helpers',
    },
    {
      kind: 'comment',
      target: { kind: 'table', table: JSON_WIDGETS_ID },
      text: 'new label',
    },
  ],
  groups: [
    { start: 0, end: 9, transactional: true },
    { start: 9, end: 10, transactional: false },
    { start: 10, end: 12, transactional: true },
  ],
  hazards: [
    {
      kind: 'increment-zero',
      step: 1,
      entity: {
        kind: 'sequence',
        sequence: { schema: 'public', name: 'widget_seq' },
      },
      increment: '0',
    },
  ],
};

test('compare --json emits one document with the rich change DTOs, exit 0', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', JSON_BASE_DUMP);
  const target = await writeDump(dir, 'target.sql', JSON_TARGET_DUMP);

  const result = await runCli('compare', baseline, target, '--json');

  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  const document = JSON.parse(result.stdout) as unknown;
  assert.deepEqual(
    document,
    expectedJsonEnvelope('compare', baseline, target, { changes: EXPECTED_JSON_CHANGES }),
  );
  assert.equal(result.stdout, `${JSON.stringify(document, null, 2)}\n`);
});

test('plan --json emits one document with multi-group steps and hazards, exit 0', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', JSON_BASE_DUMP);
  const target = await writeDump(dir, 'target.sql', JSON_TARGET_DUMP);

  const result = await runCli('plan', baseline, target, '--json');

  assert.equal(result.stderr, '');
  assert.equal(result.code, 0);
  const document = JSON.parse(result.stdout) as unknown;
  assert.deepEqual(
    document,
    expectedJsonEnvelope('plan', baseline, target, EXPECTED_JSON_PLAN_RESULT),
  );
  assert.equal(result.stdout, `${JSON.stringify(document, null, 2)}\n`);
});

test('compare --json and plan --json emit empty arrays for identical sides, exit 0', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', JSON_BASE_DUMP);

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, dump, dump, '--json');

    assert.equal(result.stderr, '');
    assert.equal(result.code, 0);
    const expectedResult =
      command === 'compare'
        ? { changes: [] }
        : { targetVersion: 13, steps: [], groups: [], hazards: [] };
    assert.deepEqual(
      JSON.parse(result.stdout) as unknown,
      expectedJsonEnvelope(
        command,
        dump,
        dump,
        expectedResult,
        RICH_BASELINE_COUNTS,
        RICH_BASELINE_COUNTS,
      ),
    );
  }
});

test('--json --verbose leaves the document byte-identical and diagnostics complete', async (t) => {
  const dir = await fixtureDir(t);
  const dump = await writeDump(dir, 'dump.sql', JSON_DIAGNOSTICS_DUMP);
  const flag = {
    kind: 'flag',
    code: 'unsupported-attribute',
    object: 'public.users',
    message: 'dropped NULLS NOT DISTINCT on unique constraint users_email_key from public.users',
    position: { line: 1, column: 1, offset: 0 },
  };
  const skip = {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'public.idx_users_partial',
    message: 'skipped CREATE INDEX public.idx_users_partial (partial WHERE)',
    position: { line: 7, column: 1, offset: 138 },
  };
  const expectedDiagnostics = { baseline: [flag, skip], target: [flag, skip] };

  for (const command of ['compare', 'plan'] as const) {
    const human = await runCli(command, dump, dump);
    const humanVerbose = await runCli(command, dump, dump, '--verbose');
    const quiet = await runCli(command, dump, dump, '--json');
    const verbose = await runCli(command, dump, dump, '--json', '--verbose');

    assert.equal(quiet.stdout, verbose.stdout, `${command}: --verbose changed the document`);
    assert.equal(quiet.stderr, human.stderr, `${command}: quiet stderr differs from human`);
    assert.equal(
      verbose.stderr,
      humanVerbose.stderr,
      `${command}: verbose stderr differs from human`,
    );
    assert.equal(quiet.code, 0);
    assert.equal(verbose.code, 0);
    const document = JSON.parse(quiet.stdout) as JsonEnvelopeProbe;
    assert.deepEqual(document.diagnostics, expectedDiagnostics);
    assert.equal(quiet.stdout, `${JSON.stringify(document, null, 2)}\n`);
  }
});

test('compare --json and plan --json leave stdout empty on a read failure, exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', JSON_BASE_DUMP);
  const missing = join(dir, 'missing.sql');
  const expected = `schemamill: cannot read ${missing}: ENOENT: no such file or directory, open '${missing}'\n`;

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, baseline, missing, '--json');

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, expected);
    assert.equal(result.code, 1);
  }
});

test('compare --json and plan --json emit no document on a dangling sequence owner, exit 1', async (t) => {
  const root = await fixtureDir(t);
  await writeWorkspaceModel(root, DANGLING_TABLE_MODEL);
  const dumps = await fixtureDir(t);
  const empty = await writeDump(dumps, 'empty.sql', '');

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, '--target-workspace', empty, '--json', { cwd: root });

    assert.equal(result.stdout, '');
    assert.equal(result.stderr, DANGLING_TABLE_ERROR);
    assert.equal(result.code, 1);
  }
});

test('compare --json and plan --json carry import error diagnostics and exit 1', async (t) => {
  const dir = await fixtureDir(t);
  const baseline = await writeDump(dir, 'baseline.sql', JSON_BASE_DUMP);
  const target = await writeDump(dir, 'target.sql', PARSE_FAILURE_TARGET);
  const expectedDiagnostic = {
    kind: 'error',
    code: 'parse-failure',
    message: 'syntax error at or near ")"',
    position: { line: 7, column: 2, offset: 100 },
  };

  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, baseline, target, '--json');

    assert.equal(
      result.stderr,
      'target: 1 failed\ntarget: [error] syntax error at or near ")" (7:2)\n',
    );
    assert.equal(result.code, 1);
    const document = JSON.parse(result.stdout) as JsonEnvelopeProbe;
    assert.equal(document.command, command);
    assert.deepEqual(document.diagnostics.baseline, []);
    assert.deepEqual(document.diagnostics.target, [expectedDiagnostic]);
    if (command === 'compare') {
      assert.ok(document.result.changes !== undefined && document.result.changes.length > 0);
    } else {
      assert.ok(document.result.steps !== undefined);
      assert.ok(document.result.groups !== undefined);
      assert.ok(document.result.hazards !== undefined);
    }
    assert.equal(result.stdout, `${JSON.stringify(document, null, 2)}\n`);
  }
});

test('plan --json emits the document and the existing refusal line on render refusal, exit 1', async () => {
  const baseline = fixturePath('index-name-twin.baseline.sql');
  const target = fixturePath('index-name-twin.target.sql');

  const result = await runCli('plan', baseline, target, '--json');

  assert.equal(
    result.stderr,
    'schemamill: refusing to render: index creates on public.t would share the name "t_a_idx": an unnamed index on (a) and an index named "t_a_idx" on (a)\n',
  );
  assert.equal(result.code, 1);
  const document = JSON.parse(result.stdout) as JsonEnvelopeProbe;
  assert.equal(document.command, 'plan');
  assert.deepEqual(document.result.groups, [{ start: 0, end: 2, transactional: true }]);
  assert.equal(document.result.steps?.length, 2);
  assert.equal(result.stdout.includes('BEGIN;'), false, 'the document carries no rendered SQL');
  assert.equal(result.stdout, `${JSON.stringify(document, null, 2)}\n`);
});

test('a --json usage error leaves stdout empty and prints the usage line, exit 1', async () => {
  for (const command of ['compare', 'plan'] as const) {
    const result = await runCli(command, '--json');

    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      'error: name at least one dump path (the workspace can fill the other side)\n',
    );
    assert.equal(result.code, 1);
  }
});

test('human compare and plan output without --json stays byte-identical to the goldens with empty stderr', async () => {
  for (const scene of ['all-changes', 'views'] as const) {
    for (const command of ['compare', 'plan'] as const) {
      const baseline = fixturePath(`${scene}.baseline.sql`);
      const target = fixturePath(`${scene}.target.sql`);

      const result = await runCli(command, baseline, target);

      assert.equal(result.stdout, testText(`goldens/${scene}.${command}.txt`));
      assert.equal(result.stderr, '');
      assert.equal(result.code, 0);
    }
  }
});
