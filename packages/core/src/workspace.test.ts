import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  effectiveSequence,
  initWorkspace,
  resolveWorkspace,
  writeWorkspaceModel,
  WORKSPACE_DIR_NAME,
  WORKSPACE_MODEL_FILE_NAME,
} from './index.ts';
import type { Model, Table, WorkspaceDiagnostic } from './index.ts';
import { serializeModel } from './workspace.ts';

/**
 * Tests for the workspace container: the `.schemamill/model.json` layout, resolution's walk
 * and marker-state table, init's refusals and the canonical model bytes it writes, the
 * serializer's byte-level determinism, and the public writer's atomic replacement, repair,
 * and failure cleanup. Layout paths and bytes are pinned literally beside the exported
 * constants so a renamed marker cannot pass silently.
 */

/** The empty model's exact file bytes: two-space JSON and a trailing newline. */
const EMPTY_MODEL_BYTES = '{\n  "tables": [],\n  "sequences": [],\n  "views": []\n}\n';

/** A fresh temp directory removed when the test ends. */
async function fixtureDir(context: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'schemamill-workspace-'));
  context.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The canonical model path under `root`, pinned literally to catch layout drift. */
function modelPath(root: string): string {
  return join(root, '.schemamill', 'model.json');
}

/** Hand-crafts a workspace model under `root`. */
async function writeWorkspace(root: string, text: string): Promise<void> {
  const marker = join(root, '.schemamill');
  await mkdir(marker, { recursive: true });
  await writeFile(join(marker, 'model.json'), text, 'utf8');
}

/** Whether the current process can read `path`; a mode-000 entry stays readable for root. */
function canRead(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether the current process can write `path`; a mode-0500 directory stays writable for root. */
function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Asserts a resolution succeeded and returns it. */
async function resolveOk(
  startPath: string,
): Promise<{ readonly root: string; readonly model: Model }> {
  const result = await resolveWorkspace(startPath);
  if (!result.ok) assert.fail(`expected resolution to succeed: ${result.diagnostic.message}`);
  return result;
}

/** Asserts a resolution failed and returns its diagnostic. */
async function resolveFail(startPath: string): Promise<WorkspaceDiagnostic> {
  const result = await resolveWorkspace(startPath);
  if (result.ok) assert.fail(`expected resolution to fail; got the workspace at ${result.root}`);
  return result.diagnostic;
}

/** Asserts an init succeeded and returns the root. */
async function initOk(target: string): Promise<string> {
  const result = await initWorkspace(target);
  if (!result.ok) assert.fail(`expected init to succeed: ${result.diagnostic.message}`);
  return result.root;
}

/** Asserts an init failed and returns its diagnostic. */
async function initFail(target: string): Promise<WorkspaceDiagnostic> {
  const result = await initWorkspace(target);
  if (result.ok) assert.fail(`expected init to fail; got the workspace at ${result.root}`);
  return result.diagnostic;
}

/** Asserts an init of `model` succeeded and returns the root. */
async function initWithModel(target: string, model: Model): Promise<string> {
  const result = await initWorkspace(target, model);
  if (!result.ok) assert.fail(`expected init to succeed: ${result.diagnostic.message}`);
  return result.root;
}

/** Asserts a write succeeded and returns the resolved root. */
async function writeOk(startPath: string, model: Model): Promise<string> {
  const result = await writeWorkspaceModel(startPath, model);
  if (!result.ok) assert.fail(`expected the write to succeed: ${result.diagnostic.message}`);
  return result.root;
}

/** Asserts a write failed and returns its diagnostic. */
async function writeFail(startPath: string, model: Model): Promise<WorkspaceDiagnostic> {
  const result = await writeWorkspaceModel(startPath, model);
  if (result.ok)
    assert.fail(`expected the write to fail; it wrote the workspace at ${result.root}`);
  return result.diagnostic;
}

/** The `.tmp` entries a directory holds, to pin that no temp file is left behind. */
async function tempEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

/** The minimal valid table payload; `overrides` replace its fields. */
function tablePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'public',
    name: 't',
    columns: [],
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
    indexes: [],
    ...overrides,
  };
}

/** The minimal valid sequence payload; `overrides` replace its fields. */
function sequencePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'public',
    name: 's',
    dataType: 'bigint',
    increment: '1',
    minValue: '1',
    maxValue: '9223372036854775807',
    start: '1',
    cache: '1',
    cycle: false,
    ...overrides,
  };
}

/** The minimal valid view payload; `overrides` replace its fields. */
function viewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'public',
    name: 'v',
    materialized: false,
    definition: 'SELECT 1',
    ...overrides,
  };
}

/** A column carrying an identity whose `overrides` replace the descriptor's fields. */
function columnWithIdentity(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'id',
    type: 'bigint',
    notNull: true,
    identity: {
      generated: 'always',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
      ...overrides,
    },
  };
}

/** Writes a hand-written model payload into a fresh root and returns its diagnostic. */
async function resolvePayload(
  context: TestContext,
  payload: unknown,
): Promise<WorkspaceDiagnostic> {
  const dir = await fixtureDir(context);
  await writeWorkspace(dir, JSON.stringify(payload));
  return resolveFail(dir);
}

/** A minimal canonical table with the given identity. */
function minimalTable(schema: string, name: string): Table {
  return {
    schema,
    name,
    columns: [],
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
    indexes: [],
  };
}

test('the workspace layout constants pin the documented names', () => {
  assert.equal(WORKSPACE_DIR_NAME, '.schemamill');
  assert.equal(WORKSPACE_MODEL_FILE_NAME, 'model.json');
});

test('resolveWorkspace reports workspace-not-found naming the start path', async (t) => {
  const dir = await fixtureDir(t);
  const start = join(dir, 'deep', 'inside');

  const diagnostic = await resolveFail(start);

  assert.equal(diagnostic.code, 'workspace-not-found');
  assert.equal(diagnostic.message, `no workspace found from ${start}`);
});

test('resolveWorkspace reports a marker that is not a directory', async (t) => {
  const dir = await fixtureDir(t);
  const marker = join(dir, '.schemamill');
  await writeFile(marker, 'not a directory', 'utf8');

  const diagnostic = await resolveFail(dir);

  assert.equal(diagnostic.code, 'workspace-marker-invalid');
  assert.equal(diagnostic.message, `${marker} is not a directory`);
});

test('resolveWorkspace reports an unreadable marker with the path and the reason', async (t) => {
  const dir = await fixtureDir(t);
  const marker = join(dir, '.schemamill');
  await mkdir(marker);
  await chmod(dir, 0o000);
  try {
    if (canRead(marker)) {
      t.skip('a mode-000 directory is still readable (running as root)');
      return;
    }

    const diagnostic = await resolveFail(dir);

    assert.equal(diagnostic.code, 'workspace-inaccessible');
    assert.ok(diagnostic.message.startsWith(`cannot access ${marker}: `));
  } finally {
    await chmod(dir, 0o700);
  }
});

test('resolveWorkspace reports a marker without a model file', async (t) => {
  const dir = await fixtureDir(t);
  await mkdir(join(dir, '.schemamill'));

  const diagnostic = await resolveFail(dir);

  assert.equal(diagnostic.code, 'workspace-model-missing');
  assert.equal(diagnostic.message, `no model file at ${modelPath(dir)}`);
});

test('resolveWorkspace reports an unreadable model file with the path and the reason', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, '{"tables":[],"sequences":[]}');
  const path = modelPath(dir);
  await chmod(path, 0o000);

  if (canRead(path)) {
    t.skip('a mode-000 file is still readable (running as root)');
    return;
  }

  const diagnostic = await resolveFail(dir);

  assert.equal(diagnostic.code, 'workspace-model-unreadable');
  assert.ok(diagnostic.message.startsWith(`cannot read ${path}: `));
});

test('resolveWorkspace reports invalid JSON with the path, never the V8 text', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, '{"tables": ');

  const diagnostic = await resolveFail(dir);

  assert.equal(diagnostic.code, 'workspace-model-invalid');
  assert.ok(diagnostic.message.startsWith(`cannot parse ${modelPath(dir)}: `));
});

/** Every reader shape failure: the payload, and the stable message prefix it must produce. */
const SHAPE_FAILURES: ReadonlyArray<readonly [string, unknown, string]> = [
  [
    'an unknown model key',
    { tables: [], sequences: [], version: 1 },
    'invalid model: unknown field version',
  ],
  [
    'a model whose tables field is not an array',
    { tables: {}, sequences: [] },
    'invalid model: tables is not an array',
  ],
  [
    'an unknown table key',
    { tables: [tablePayload({ bogus: true })], sequences: [] },
    'invalid model: unknown field tables[0].bogus',
  ],
  [
    'an unknown column key',
    {
      tables: [tablePayload({ columns: [{ name: 'c', type: 'text', notNull: false, bogus: 1 }] })],
      sequences: [],
    },
    'invalid model: unknown field tables[0].columns[0].bogus',
  ],
  [
    'a table that is not an object',
    { tables: [1], sequences: [] },
    'invalid model: tables[0] is not an object',
  ],
  [
    'a table whose columns field is not an array',
    { tables: [tablePayload({ columns: 'x' })], sequences: [] },
    'invalid model: tables[0].columns is not an array',
  ],
  [
    'a column type that is not a string',
    {
      tables: [tablePayload({ columns: [{ name: 'c', type: 1, notNull: false }] })],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].type is not a string',
  ],
  [
    'a referential action outside the union',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
              onDelete: 'NO ACTION',
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].onDelete',
  ],
  [
    'a sequence data type outside the union',
    { tables: [], sequences: [sequencePayload({ dataType: 'numeric' })] },
    'invalid model: sequences[0].dataType',
  ],
  [
    'a leading-zero integer string',
    {
      tables: [tablePayload({ columns: [columnWithIdentity({ increment: '01' })] })],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].identity.increment',
  ],
  [
    'a negative-zero integer string',
    { tables: [], sequences: [sequencePayload({ increment: '-0' })] },
    'invalid model: sequences[0].increment',
  ],
  [
    'a nonpositive cache',
    { tables: [], sequences: [sequencePayload({ cache: '0' })] },
    'invalid model: sequences[0].cache',
  ],
  [
    'an identity generation outside the union',
    {
      tables: [tablePayload({ columns: [columnWithIdentity({ generated: 'sometimes' })] })],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].identity.generated',
  ],
  [
    'a foreign key enforcement outside the union',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
              enforcement: 'maybe',
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].enforcement',
  ],
  [
    'a check constraint enforcement outside the union',
    {
      tables: [
        tablePayload({ checkConstraints: [{ expression: 'a > 0', enforcement: 'always' }] }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].checkConstraints[0].enforcement',
  ],
  [
    'a not-null name on a nullable column',
    {
      tables: [
        tablePayload({
          columns: [{ name: 'c', type: 'text', notNull: false, notNullName: 'c_nn' }],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].notNullName',
  ],
  [
    'a not-null name that is not a string',
    {
      tables: [
        tablePayload({ columns: [{ name: 'c', type: 'text', notNull: true, notNullName: 1 }] }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].notNullName',
  ],
  [
    'a deferrability flag that is not a boolean',
    {
      tables: [tablePayload({ primaryKey: { columns: ['id'], deferrable: 'yes' } })],
      sequences: [],
    },
    'invalid model: tables[0].primaryKey.deferrable',
  ],
  [
    'an initiallyDeferred flag that is not a boolean',
    {
      tables: [tablePayload({ uniqueConstraints: [{ columns: ['a'], initiallyDeferred: 1 }] })],
      sequences: [],
    },
    'invalid model: tables[0].uniqueConstraints[0].initiallyDeferred',
  ],
  [
    'a foreign-key deferrability flag that is not a boolean',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
              deferrable: 'yes',
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].deferrable',
  ],
  [
    'a foreign-key initiallyDeferred flag that is not a boolean',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
              initiallyDeferred: 1,
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].initiallyDeferred',
  ],
  [
    'a column storage method outside the union',
    {
      tables: [
        tablePayload({
          columns: [{ name: 'c', type: 'text', notNull: false, storage: 'packed' }],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].storage',
  ],
  [
    'a column compression method outside the union',
    {
      tables: [
        tablePayload({
          columns: [{ name: 'c', type: 'text', notNull: false, compression: 'zstd' }],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].compression',
  ],
  [
    'an empty collation',
    {
      tables: [
        tablePayload({
          columns: [{ name: 'c', type: 'text', notNull: false, collation: '' }],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].collation',
  ],
  [
    'a table persistence outside the union',
    { tables: [tablePayload({ persistence: 'temporary' })], sequences: [] },
    'invalid model: tables[0].persistence',
  ],
  [
    'a column name that is not a string',
    {
      tables: [tablePayload({ columns: [{ name: 1, type: 'text', notNull: false }] })],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].name is not a string',
  ],
  [
    'a column notNull flag that is not a boolean',
    {
      tables: [tablePayload({ columns: [{ name: 'c', type: 'text', notNull: 1 }] })],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].notNull is not a boolean',
  ],
  [
    'a column default that is not a string',
    {
      tables: [
        tablePayload({ columns: [{ name: 'c', type: 'text', notNull: false, default: 1 }] }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].columns[0].default is not a string',
  ],
  [
    'a primary-key name that is not a string',
    { tables: [tablePayload({ primaryKey: { name: 1, columns: ['id'] } })], sequences: [] },
    'invalid model: tables[0].primaryKey.name is not a string',
  ],
  [
    'a primary-key columns field that is not an array',
    { tables: [tablePayload({ primaryKey: { columns: 'x' } })], sequences: [] },
    'invalid model: tables[0].primaryKey.columns is not an array',
  ],
  [
    'a check-constraint name that is not a string',
    {
      tables: [tablePayload({ checkConstraints: [{ name: 1, expression: 'a > 0' }] })],
      sequences: [],
    },
    'invalid model: tables[0].checkConstraints[0].name is not a string',
  ],
  [
    'a check-constraint expression that is not a string',
    { tables: [tablePayload({ checkConstraints: [{ expression: 1 }] })], sequences: [] },
    'invalid model: tables[0].checkConstraints[0].expression is not a string',
  ],
  [
    'a foreign-key name that is not a string',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              name: 1,
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].name is not a string',
  ],
  [
    'a foreign-key columns field that is not an array',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: 'x',
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].columns is not an array',
  ],
  [
    'a foreign-key referencedTable that is not an object',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: 1,
              referencedColumns: ['id'],
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].referencedTable is not an object',
  ],
  [
    'a foreign-key referencedColumns field that is not an array',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: 'x',
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].referencedColumns is not an array',
  ],
  [
    'a foreign-key onUpdate outside the union',
    {
      tables: [
        tablePayload({
          foreignKeys: [
            {
              columns: ['org_id'],
              referencedTable: { schema: 'public', name: 'orgs' },
              referencedColumns: ['id'],
              onUpdate: 'NO ACTION',
            },
          ],
        }),
      ],
      sequences: [],
    },
    'invalid model: tables[0].foreignKeys[0].onUpdate is not a valid referential action',
  ],
  [
    'a model whose views field is null',
    { tables: [], sequences: [], views: null },
    'invalid model: views is not an array',
  ],
  [
    'a model whose views field is not an array',
    { tables: [], sequences: [], views: {} },
    'invalid model: views is not an array',
  ],
  [
    'an unknown view key',
    { tables: [], sequences: [], views: [viewPayload({ bogus: true })] },
    'invalid model: unknown field views[0].bogus',
  ],
  [
    'a view whose materialized flag is not a boolean',
    { tables: [], sequences: [], views: [viewPayload({ materialized: 'yes' })] },
    'invalid model: views[0].materialized is not a boolean',
  ],
  [
    'a view whose definition is not a string',
    { tables: [], sequences: [], views: [viewPayload({ definition: 1 })] },
    'invalid model: views[0].definition is not a string',
  ],
  [
    'a view whose schema is not a string',
    { tables: [], sequences: [], views: [viewPayload({ schema: 1 })] },
    'invalid model: views[0].schema is not a string',
  ],
  [
    'a view whose name is not a string',
    { tables: [], sequences: [], views: [viewPayload({ name: 1 })] },
    'invalid model: views[0].name is not a string',
  ],
  [
    'a view check option outside the union',
    { tables: [], sequences: [], views: [viewPayload({ checkOption: 'strict' })] },
    'invalid model: views[0].checkOption is not a valid view check option',
  ],
  [
    'a check option on a materialized view',
    {
      tables: [],
      sequences: [],
      views: [viewPayload({ materialized: true, checkOption: 'local' })],
    },
    'invalid model: views[0].checkOption is not valid on a materialized view',
  ],
];

for (const [name, payload, prefix] of SHAPE_FAILURES) {
  test(`resolveWorkspace fails closed on ${name}`, async (t) => {
    const diagnostic = await resolvePayload(t, payload);

    assert.equal(diagnostic.code, 'workspace-model-invalid');
    assert.ok(
      diagnostic.message.startsWith(prefix),
      `expected ${JSON.stringify(diagnostic.message)} to start with ${JSON.stringify(prefix)}`,
    );
  });
}

test('resolveWorkspace names the constraint enforcement union in the failure', async (t) => {
  const diagnostic = await resolvePayload(t, {
    tables: [
      tablePayload({
        foreignKeys: [
          {
            columns: ['org_id'],
            referencedTable: { schema: 'public', name: 'orgs' },
            referencedColumns: ['id'],
            enforcement: 'maybe',
          },
        ],
      }),
    ],
    sequences: [],
  });

  assert.equal(
    diagnostic.message,
    'invalid model: tables[0].foreignKeys[0].enforcement is not a valid constraint enforcement',
  );
});

test('resolveWorkspace names the column attribute and persistence failures in full', async (t) => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [
      {
        tables: [
          tablePayload({
            columns: [{ name: 'c', type: 'text', notNull: false, storage: 'packed' }],
          }),
        ],
        sequences: [],
      },
      'invalid model: tables[0].columns[0].storage is not a valid column storage',
    ],
    [
      {
        tables: [
          tablePayload({
            columns: [{ name: 'c', type: 'text', notNull: false, compression: 'zstd' }],
          }),
        ],
        sequences: [],
      },
      'invalid model: tables[0].columns[0].compression is not a valid column compression',
    ],
    [
      {
        tables: [
          tablePayload({
            columns: [{ name: 'c', type: 'text', notNull: false, collation: '' }],
          }),
        ],
        sequences: [],
      },
      'invalid model: tables[0].columns[0].collation is not a non-empty string',
    ],
    [
      { tables: [tablePayload({ persistence: 'temporary' })], sequences: [] },
      'invalid model: tables[0].persistence is not a valid table persistence',
    ],
  ];

  for (const [payload, message] of cases) {
    const diagnostic = await resolvePayload(t, payload);
    assert.equal(diagnostic.message, message);
  }
});

/** A populated canonical model, as a committed model file would hold it. */
const POPULATED_MODEL_JSON = `{
  "tables": [
    {
      "schema": "public",
      "name": "users",
      "columns": [
        {
          "name": "id",
          "type": "bigint",
          "notNull": true,
          "default": "0",
          "identity": {
            "generated": "always",
            "sequenceName": { "schema": "public", "name": "users_id_seq" },
            "increment": "1",
            "minValue": "1",
            "maxValue": "9223372036854775807",
            "start": "1",
            "cache": "1",
            "cycle": false
          }
        },
        { "name": "email", "type": "text", "notNull": false }
      ],
      "primaryKey": { "name": "users_pkey", "columns": ["id"] },
      "foreignKeys": [
        {
          "columns": ["org_id"],
          "referencedTable": { "schema": "public", "name": "orgs" },
          "referencedColumns": ["id"],
          "onUpdate": "CASCADE",
          "onDelete": "SET NULL"
        }
      ],
      "uniqueConstraints": [{ "columns": ["email"] }],
      "checkConstraints": [{ "name": "users_email_check", "expression": "email <> ''" }],
      "indexes": [
        { "name": "users_email_idx", "unique": true, "columns": ["email"], "concurrently": true }
      ]
    }
  ],
  "sequences": [
    {
      "schema": "public",
      "name": "counter",
      "dataType": "integer",
      "increment": "-1",
      "minValue": "-2147483648",
      "maxValue": "-1",
      "start": "-1",
      "cache": "10",
      "cycle": true,
      "ownedBy": { "table": { "schema": "public", "name": "users" }, "column": "id" }
    }
  ]
}
`;

/** The model `POPULATED_MODEL_JSON` must read back as. */
const POPULATED_MODEL: Model = {
  tables: [
    {
      schema: 'public',
      name: 'users',
      columns: [
        {
          name: 'id',
          type: 'bigint',
          notNull: true,
          default: '0',
          identity: {
            generated: 'always',
            sequenceName: { schema: 'public', name: 'users_id_seq' },
            increment: '1',
            minValue: '1',
            maxValue: '9223372036854775807',
            start: '1',
            cache: '1',
            cycle: false,
          },
        },
        { name: 'email', type: 'text', notNull: false },
      ],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
      foreignKeys: [
        {
          columns: ['org_id'],
          referencedTable: { schema: 'public', name: 'orgs' },
          referencedColumns: ['id'],
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
      ],
      uniqueConstraints: [{ columns: ['email'] }],
      checkConstraints: [{ name: 'users_email_check', expression: "email <> ''" }],
      indexes: [{ name: 'users_email_idx', unique: true, columns: ['email'], concurrently: true }],
    },
  ],
  sequences: [
    {
      schema: 'public',
      name: 'counter',
      dataType: 'integer',
      increment: '-1',
      minValue: '-2147483648',
      maxValue: '-1',
      start: '-1',
      cache: '10',
      cycle: true,
      ownedBy: { table: { schema: 'public', name: 'users' }, column: 'id' },
    },
  ],
  views: [],
};

test('resolveWorkspace reads back a populated model written literally', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, POPULATED_MODEL_JSON);

  const resolved = await resolveOk(dir);

  assert.equal(resolved.root, dir);
  assert.deepStrictEqual(resolved.model, POPULATED_MODEL);
});

/** A hand-written model carrying every new constraint attribute. */
const ATTRIBUTE_MODEL_JSON = `{
  "tables": [
    {
      "schema": "public",
      "name": "users",
      "persistence": "unlogged",
      "columns": [
        {
          "name": "id",
          "type": "bigint",
          "notNull": true,
          "notNullName": "users_id_not_null",
          "default": "0",
          "collation": "app.ci_collation",
          "storage": "extended",
          "compression": "lz4"
        },
        { "name": "email", "type": "text", "notNull": false }
      ],
      "primaryKey": {
        "name": "users_pkey",
        "columns": ["id"],
        "deferrable": true,
        "initiallyDeferred": true
      },
      "foreignKeys": [
        {
          "name": "users_org_id_fkey",
          "columns": ["org_id"],
          "referencedTable": { "schema": "public", "name": "orgs" },
          "referencedColumns": ["id"],
          "onDelete": "CASCADE",
          "enforcement": "not-enforced",
          "deferrable": true,
          "initiallyDeferred": true
        }
      ],
      "uniqueConstraints": [
        { "columns": ["email"], "deferrable": true, "initiallyDeferred": true }
      ],
      "checkConstraints": [
        { "name": "users_email_check", "expression": "email <> ''", "enforcement": "not-valid" }
      ],
      "indexes": []
    }
  ],
  "sequences": []
}
`;

/** The model `ATTRIBUTE_MODEL_JSON` must read back as. */
const ATTRIBUTE_MODEL: Model = {
  tables: [
    {
      schema: 'public',
      name: 'users',
      persistence: 'unlogged',
      columns: [
        {
          name: 'id',
          type: 'bigint',
          notNull: true,
          notNullName: 'users_id_not_null',
          default: '0',
          collation: 'app.ci_collation',
          storage: 'extended',
          compression: 'lz4',
        },
        { name: 'email', type: 'text', notNull: false },
      ],
      primaryKey: {
        name: 'users_pkey',
        columns: ['id'],
        deferrable: true,
        initiallyDeferred: true,
      },
      foreignKeys: [
        {
          name: 'users_org_id_fkey',
          columns: ['org_id'],
          referencedTable: { schema: 'public', name: 'orgs' },
          referencedColumns: ['id'],
          onDelete: 'CASCADE',
          enforcement: 'not-enforced',
          deferrable: true,
          initiallyDeferred: true,
        },
      ],
      uniqueConstraints: [{ columns: ['email'], deferrable: true, initiallyDeferred: true }],
      checkConstraints: [
        { name: 'users_email_check', expression: "email <> ''", enforcement: 'not-valid' },
      ],
      indexes: [],
    },
  ],
  sequences: [],
  views: [],
};

test('resolveWorkspace reads back every constraint attribute written literally', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, ATTRIBUTE_MODEL_JSON);

  const resolved = await resolveOk(dir);

  assert.deepStrictEqual(resolved.model, ATTRIBUTE_MODEL);
});

test('serializeModel emits the new attributes in declaration order', () => {
  const payload = JSON.parse(serializeModel(ATTRIBUTE_MODEL)) as {
    tables: Array<{
      columns: object[];
      primaryKey: object;
      foreignKeys: object[];
      uniqueConstraints: object[];
      checkConstraints: object[];
    }>;
  };
  const table = payload.tables[0]!;

  assert.deepStrictEqual(Object.keys(table.columns[0]!), [
    'name',
    'type',
    'notNull',
    'notNullName',
    'default',
    'collation',
    'storage',
    'compression',
  ]);
  assert.deepStrictEqual(Object.keys(table), [
    'schema',
    'name',
    'columns',
    'primaryKey',
    'foreignKeys',
    'uniqueConstraints',
    'checkConstraints',
    'indexes',
    'persistence',
  ]);
  assert.deepStrictEqual(Object.keys(table.primaryKey), [
    'name',
    'columns',
    'deferrable',
    'initiallyDeferred',
  ]);
  assert.deepStrictEqual(Object.keys(table.foreignKeys[0]!), [
    'name',
    'columns',
    'referencedTable',
    'referencedColumns',
    'onDelete',
    'enforcement',
    'deferrable',
    'initiallyDeferred',
  ]);
  assert.deepStrictEqual(Object.keys(table.uniqueConstraints[0]!), [
    'columns',
    'deferrable',
    'initiallyDeferred',
  ]);
  assert.deepStrictEqual(Object.keys(table.checkConstraints[0]!), [
    'name',
    'expression',
    'enforcement',
  ]);
});

/** A model exercising the optionals the serializers must round-trip, not only emit. */
const ROUND_TRIP_MODEL: Model = {
  tables: [
    {
      schema: 'public',
      name: 'users',
      columns: [
        {
          name: 'id',
          type: 'bigint',
          notNull: true,
          notNullName: 'users_id_not_null',
          identity: {
            generated: 'always',
            sequenceName: { schema: 'public', name: 'users_id_seq' },
            increment: '1',
            minValue: '1',
            maxValue: '9223372036854775807',
            start: '1',
            cache: '1',
            cycle: false,
          },
          collation: 'pg_catalog."C"',
          storage: 'main',
          compression: 'pglz',
        },
      ],
      primaryKey: { name: 'users_pkey', columns: ['id'], deferrable: true },
      persistence: 'unlogged',
      foreignKeys: [
        {
          name: 'users_org_id_fkey',
          columns: ['org_id'],
          referencedTable: { schema: 'public', name: 'orgs' },
          referencedColumns: ['id'],
          onUpdate: 'CASCADE',
          enforcement: 'not-enforced',
          deferrable: true,
          initiallyDeferred: true,
        },
      ],
      uniqueConstraints: [{ columns: ['email'], deferrable: true, initiallyDeferred: true }],
      checkConstraints: [{ expression: 'age >= 0', enforcement: 'not-valid' }],
      indexes: [{ name: 'users_email_idx', unique: true, columns: ['email'], concurrently: true }],
    },
  ],
  sequences: [],
  views: [],
};

test('serializeModel round-trips a populated model through resolveWorkspace without loss', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, serializeModel(ROUND_TRIP_MODEL));

  const resolved = await resolveOk(dir);

  assert.deepStrictEqual(resolved.model, ROUND_TRIP_MODEL);
});

test('serializeModel emits a column identity before its attributes, and persistence last', () => {
  const payload = JSON.parse(serializeModel(ROUND_TRIP_MODEL)) as {
    tables: Array<{ columns: object[]; persistence?: string }>;
  };

  assert.deepStrictEqual(Object.keys(payload.tables[0]!.columns[0]!), [
    'name',
    'type',
    'notNull',
    'notNullName',
    'identity',
    'collation',
    'storage',
    'compression',
  ]);
  assert.equal(payload.tables[0]!.persistence, 'unlogged');
});

test('resolveWorkspace walks up from a nested directory to the nearest root', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);
  const nested = join(dir, 'a', 'b', 'c');
  await mkdir(nested, { recursive: true });

  const resolved = await resolveOk(nested);

  assert.equal(resolved.root, dir);
  assert.deepStrictEqual(resolved.model, { tables: [], sequences: [], views: [] });
});

test('resolveWorkspace resolves the root given explicitly', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);

  const resolved = await resolveOk(dir);

  assert.equal(resolved.root, dir);
});

test('resolution treats a file component as absent and keeps walking to the workspace root', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);
  await writeFile(join(dir, 'blocker'), 'not a directory', 'utf8');

  const resolved = await resolveOk(join(dir, 'blocker', 'sub'));

  assert.equal(resolved.root, dir);
  assert.deepStrictEqual(resolved.model, { tables: [], sequences: [], views: [] });
});

test('resolveWorkspace returns the nearest of hand-crafted nested workspaces', async (t) => {
  const dir = await fixtureDir(t);
  const inner = join(dir, 'inner');
  await writeWorkspace(dir, '{"tables":[],"sequences":[]}');
  await writeWorkspace(inner, '{"tables":[],"sequences":[]}');

  const fromInside = await resolveOk(join(inner, 'sub'));
  assert.equal(fromInside.root, inner);

  const fromOuter = await resolveOk(dir);
  assert.equal(fromOuter.root, dir);
});

test('resolveWorkspace reports a corrupt nearest root instead of an outer one', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);
  const inner = join(dir, 'inner');
  await writeWorkspace(inner, '{"tables": ');

  const diagnostic = await resolveFail(join(inner, 'sub'));

  assert.equal(diagnostic.code, 'workspace-model-invalid');
});

test('initWorkspace creates the target directory and the exact empty model', async (t) => {
  const dir = await fixtureDir(t);
  const target = join(dir, 'workspace');

  const root = await initOk(target);

  assert.equal(root, target);
  assert.equal(
    await readFile(join(target, '.schemamill', 'model.json'), 'utf8'),
    EMPTY_MODEL_BYTES,
  );
});

test('initWorkspace writes a supplied model as canonical bytes and resolveWorkspace round-trips it', async (t) => {
  const dir = await fixtureDir(t);
  const target = join(dir, 'workspace');

  const result = await initWorkspace(target, POPULATED_MODEL);
  if (!result.ok) assert.fail(`expected init to succeed: ${result.diagnostic.message}`);

  const bytes = await readFile(modelPath(target), 'utf8');
  assert.equal(bytes, serializeModel(POPULATED_MODEL));
  assert.notEqual(bytes, EMPTY_MODEL_BYTES);

  const resolved = await resolveOk(target);
  assert.equal(resolved.root, target);
  assert.deepStrictEqual(resolved.model, POPULATED_MODEL);
});

test('initWorkspace refuses a target that is a file', async (t) => {
  const dir = await fixtureDir(t);
  const file = join(dir, 'file');
  await writeFile(file, 'not a directory', 'utf8');

  const diagnostic = await initFail(file);

  assert.equal(diagnostic.code, 'workspace-target-not-directory');
  assert.equal(diagnostic.message, `${file} is not a directory`);
});

test('initWorkspace refuses an existing workspace and names the repair', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);

  const diagnostic = await initFail(dir);

  assert.equal(diagnostic.code, 'workspace-already-exists');
  assert.equal(
    diagnostic.message,
    `workspace already exists at ${dir}: remove ${join(dir, '.schemamill')} to re-create it`,
  );
});

test('initWorkspace refuses a marker file as already existing', async (t) => {
  const dir = await fixtureDir(t);
  await writeFile(join(dir, '.schemamill'), 'stray entry', 'utf8');

  const diagnostic = await initFail(dir);

  assert.equal(diagnostic.code, 'workspace-already-exists');
  assert.ok(diagnostic.message.includes(`remove ${join(dir, '.schemamill')} to re-create it`));
});

test('initWorkspace refuses a directory inside an existing workspace', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);
  const nested = join(dir, 'nested');

  const diagnostic = await initFail(nested);

  assert.equal(diagnostic.code, 'workspace-inside-workspace');
  assert.equal(diagnostic.message, `${nested} is inside the workspace at ${dir}`);
});

test('initWorkspace allows a workspace that contains another', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(join(dir, 'inner'), '{"tables":[],"sequences":[]}');

  const root = await initOk(dir);

  assert.equal(root, dir);
  assert.equal(await readFile(modelPath(dir), 'utf8'), EMPTY_MODEL_BYTES);
});

test('writeWorkspaceModel writes the canonical model bytes and returns the resolved root', async (t) => {
  const dir = await fixtureDir(t);
  await initWithModel(dir, POPULATED_MODEL);

  const result = await writeWorkspaceModel(dir, ROUND_TRIP_MODEL);

  assert.deepStrictEqual(result, { ok: true, root: dir });
  assert.equal(await readFile(modelPath(dir), 'utf8'), serializeModel(ROUND_TRIP_MODEL));
  const resolved = await resolveOk(dir);
  assert.deepStrictEqual(resolved.model, ROUND_TRIP_MODEL);
});

test('writeWorkspaceModel replaces the previous bytes and leaves no temp file', async (t) => {
  const dir = await fixtureDir(t);
  await initWithModel(dir, POPULATED_MODEL);
  const previous = await readFile(modelPath(dir), 'utf8');

  const root = await writeOk(dir, ROUND_TRIP_MODEL);

  assert.equal(root, dir);
  const bytes = await readFile(modelPath(dir), 'utf8');
  assert.equal(bytes, serializeModel(ROUND_TRIP_MODEL));
  assert.notEqual(bytes, previous);
  assert.deepStrictEqual(await tempEntries(join(dir, WORKSPACE_DIR_NAME)), []);
});

test('writeWorkspaceModel replaces the directory entry, not the inode a hard link shares', async (t) => {
  const dir = await fixtureDir(t);
  await initWithModel(dir, POPULATED_MODEL);
  const backup = join(dir, 'backup.json');
  try {
    await link(modelPath(dir), backup);
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code === 'ENOSYS' || code === 'EPERM' || code === 'EACCES' || code === 'EXDEV') {
      t.skip('hard links are unsupported here');
      return;
    }
    throw error;
  }

  await writeOk(dir, ROUND_TRIP_MODEL);

  assert.equal(await readFile(backup, 'utf8'), serializeModel(POPULATED_MODEL));
  assert.equal(await readFile(modelPath(dir), 'utf8'), serializeModel(ROUND_TRIP_MODEL));
});

test('writeWorkspaceModel resolves the root from a nested start path', async (t) => {
  const dir = await fixtureDir(t);
  await initWithModel(dir, POPULATED_MODEL);
  const nested = join(dir, 'a', 'b');
  await mkdir(nested, { recursive: true });

  const root = await writeOk(nested, ROUND_TRIP_MODEL);

  assert.equal(root, dir);
  const resolved = await resolveOk(dir);
  assert.deepStrictEqual(resolved.model, ROUND_TRIP_MODEL);
});

test('writeWorkspaceModel reports workspace-not-found and creates nothing', async (t) => {
  const dir = await fixtureDir(t);

  const diagnostic = await writeFail(dir, ROUND_TRIP_MODEL);

  assert.equal(diagnostic.code, 'workspace-not-found');
  assert.equal(diagnostic.message, `no workspace found from ${dir}`);
  await assert.rejects(stat(join(dir, WORKSPACE_DIR_NAME)), { code: 'ENOENT' });
  assert.deepStrictEqual(await readdir(dir), []);
});

test('writeWorkspaceModel repairs a corrupt model file', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, '{ not json');

  const root = await writeOk(dir, ROUND_TRIP_MODEL);

  assert.equal(root, dir);
  const resolved = await resolveOk(dir);
  assert.deepStrictEqual(resolved.model, ROUND_TRIP_MODEL);
});

test('writeWorkspaceModel writes a model into a marker that has none', async (t) => {
  const dir = await fixtureDir(t);
  await mkdir(join(dir, WORKSPACE_DIR_NAME));

  const root = await writeOk(dir, ROUND_TRIP_MODEL);

  assert.equal(root, dir);
  const resolved = await resolveOk(dir);
  assert.deepStrictEqual(resolved.model, ROUND_TRIP_MODEL);
});

test('writeWorkspaceModel reports workspace-io when the temp file cannot be created', async (t) => {
  const dir = await fixtureDir(t);
  await initWithModel(dir, POPULATED_MODEL);
  const marker = join(dir, WORKSPACE_DIR_NAME);

  await chmod(marker, 0o500);
  try {
    if (canWrite(marker)) {
      t.skip('a mode-0500 directory is still writable (running as root)');
      return;
    }

    const diagnostic = await writeFail(dir, ROUND_TRIP_MODEL);

    assert.equal(diagnostic.code, 'workspace-io');
    assert.ok(diagnostic.message.startsWith(`cannot write ${modelPath(dir)}: `));
    assert.equal(await readFile(modelPath(dir), 'utf8'), serializeModel(POPULATED_MODEL));
    assert.deepStrictEqual(await tempEntries(marker), []);
  } finally {
    await chmod(marker, 0o700);
  }
});

test('writeWorkspaceModel reports workspace-io and cleans the temp file when the rename fails', async (t) => {
  const dir = await fixtureDir(t);
  await initWithModel(dir, POPULATED_MODEL);
  const marker = join(dir, WORKSPACE_DIR_NAME);
  await rm(modelPath(dir));
  await mkdir(modelPath(dir));
  await writeFile(join(modelPath(dir), 'keep'), 'x', 'utf8');

  const diagnostic = await writeFail(dir, ROUND_TRIP_MODEL);

  assert.equal(diagnostic.code, 'workspace-io');
  assert.ok(diagnostic.message.startsWith(`cannot write ${modelPath(dir)}: `));
  assert.deepStrictEqual(await tempEntries(marker), []);
  assert.ok((await stat(modelPath(dir))).isDirectory());
  assert.equal(await readFile(join(modelPath(dir), 'keep'), 'utf8'), 'x');
});

test('resolveWorkspace reads a model without a views field as no views', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, '{"tables":[],"sequences":[]}');

  const resolved = await resolveOk(dir);

  assert.deepStrictEqual(resolved.model, { tables: [], sequences: [], views: [] });
});

test('serializeModel emits views after sequences, sorted, with the check option last', () => {
  const model: Model = {
    tables: [],
    sequences: [],
    views: [
      { schema: 'public', name: 'z', materialized: true, definition: 'SELECT 2' },
      {
        schema: 'public',
        name: 'c',
        materialized: false,
        definition: 'SELECT 3',
        checkOption: 'local',
      },
      { schema: 'app', name: 'a', materialized: false, definition: 'SELECT 1' },
    ],
  };
  const expected = [
    '{',
    '  "tables": [],',
    '  "sequences": [],',
    '  "views": [',
    '    {',
    '      "schema": "app",',
    '      "name": "a",',
    '      "materialized": false,',
    '      "definition": "SELECT 1"',
    '    },',
    '    {',
    '      "schema": "public",',
    '      "name": "c",',
    '      "materialized": false,',
    '      "definition": "SELECT 3",',
    '      "checkOption": "local"',
    '    },',
    '    {',
    '      "schema": "public",',
    '      "name": "z",',
    '      "materialized": true,',
    '      "definition": "SELECT 2"',
    '    }',
    '  ]',
    '}',
    '',
  ].join('\n');

  assert.equal(serializeModel(model), expected);
});

test('serializeModel round-trips views through resolveWorkspace without loss', async (t) => {
  const dir = await fixtureDir(t);
  const model: Model = {
    tables: [],
    sequences: [],
    views: [
      {
        schema: 'public',
        name: 'active',
        materialized: false,
        definition: 'SELECT 1',
        checkOption: 'cascaded',
      },
      { schema: 'public', name: 'totals', materialized: true, definition: 'SELECT 2' },
    ],
  };
  await writeWorkspace(dir, serializeModel(model));

  const resolved = await resolveOk(dir);

  assert.deepStrictEqual(resolved.model, model);
});

test('serializeModel pins declaration order and omits undefined optionals', () => {
  const model: Model = {
    tables: [
      {
        schema: 'public',
        name: 't',
        columns: [{ name: 'c', type: 'text', notNull: true }],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    ],
    sequences: [],
    views: [],
  };
  const expected = [
    '{',
    '  "tables": [',
    '    {',
    '      "schema": "public",',
    '      "name": "t",',
    '      "columns": [',
    '        {',
    '          "name": "c",',
    '          "type": "text",',
    '          "notNull": true',
    '        }',
    '      ],',
    '      "foreignKeys": [],',
    '      "uniqueConstraints": [],',
    '      "checkConstraints": [],',
    '      "indexes": []',
    '    }',
    '  ],',
    '  "sequences": [],',
    '  "views": []',
    '}',
    '',
  ].join('\n');

  assert.equal(serializeModel(model), expected);
});

test('serializeModel is deterministic and re-sorts tables and sequences canonically', () => {
  const model: Model = {
    tables: [minimalTable('public', 'z'), minimalTable('app', 'b'), minimalTable('app', 'a')],
    sequences: [
      effectiveSequence({ schema: 'public', name: 'z' }),
      effectiveSequence({ schema: 'public', name: 'a' }),
    ],
    views: [],
  };
  const reordered: Model = {
    tables: [...model.tables].reverse(),
    sequences: [...model.sequences].reverse(),
    views: [],
  };

  assert.equal(serializeModel(model), serializeModel(reordered));

  const payload = JSON.parse(serializeModel(model)) as {
    tables: Array<{ schema: string; name: string }>;
    sequences: Array<{ schema: string; name: string }>;
  };
  assert.deepStrictEqual(
    payload.tables.map((table) => `${table.schema}.${table.name}`),
    ['app.a', 'app.b', 'public.z'],
  );
  assert.deepStrictEqual(
    payload.sequences.map((sequence) => `${sequence.schema}.${sequence.name}`),
    ['public.a', 'public.z'],
  );
  assert.deepStrictEqual(
    model.tables.map((table) => table.name),
    ['z', 'b', 'a'],
  );
});

/** A comment carrying every character class JSON escaping and PostgreSQL text must preserve. */
const FIDELITY_COMMENT = 'it\'s a \\ backslash\nnewline\ttab "quoted"; $body$ naïve — 終';

/** A model with a comment on every entity kind. */
const COMMENTED_MODEL: Model = {
  tables: [
    {
      schema: 'public',
      name: 'users',
      comment: 'user accounts',
      columns: [
        { name: 'id', type: 'bigint', notNull: true, comment: 'surrogate key' },
        { name: 'email', type: 'text', notNull: false },
      ],
      primaryKey: { name: 'users_pkey', columns: ['id'], comment: 'primary key' },
      foreignKeys: [
        {
          name: 'users_org_id_fkey',
          columns: ['org_id'],
          referencedTable: { schema: 'public', name: 'orgs' },
          referencedColumns: ['id'],
          comment: 'owning organisation',
        },
      ],
      uniqueConstraints: [{ columns: ['email'], comment: 'one account per address' }],
      checkConstraints: [{ expression: 'age >= 0', comment: 'no negative ages' }],
      indexes: [
        {
          name: 'users_email_idx',
          unique: true,
          columns: ['email'],
          comment: 'lookup by email',
        },
      ],
    },
  ],
  sequences: [
    {
      schema: 'public',
      name: 'counter',
      dataType: 'bigint',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
      comment: 'shared counter',
    },
  ],
  views: [
    {
      schema: 'public',
      name: 'active',
      materialized: false,
      definition: 'SELECT 1',
      comment: 'active rows',
    },
  ],
};

test('serializeModel round-trips a comment on every entity kind through resolveWorkspace', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, serializeModel(COMMENTED_MODEL));

  const resolved = await resolveOk(dir);

  assert.deepStrictEqual(resolved.model, COMMENTED_MODEL);
});

test('serializeModel emits each entity comment as its last key', () => {
  const payload = JSON.parse(serializeModel(COMMENTED_MODEL)) as {
    tables: Array<{
      columns: object[];
      primaryKey: object;
      foreignKeys: object[];
      uniqueConstraints: object[];
      checkConstraints: object[];
      indexes: object[];
    }>;
    sequences: object[];
    views: object[];
  };
  const table = payload.tables[0]!;
  const entities: readonly object[] = [
    table,
    table.columns[0]!,
    table.primaryKey,
    table.uniqueConstraints[0]!,
    table.checkConstraints[0]!,
    table.foreignKeys[0]!,
    table.indexes[0]!,
    payload.sequences[0]!,
    payload.views[0]!,
  ];

  for (const entity of entities) {
    assert.equal(Object.keys(entity).at(-1), 'comment');
  }
});

test('serializeModel round-trips comment text with escapes and unicode byte-exactly', async (t) => {
  const model: Model = {
    tables: [
      {
        schema: 'public',
        name: 'notes',
        comment: FIDELITY_COMMENT,
        columns: [],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    ],
    sequences: [],
    views: [],
  };
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, serializeModel(model));

  const resolved = await resolveOk(dir);

  assert.equal(resolved.model.tables[0]!.comment, FIDELITY_COMMENT);
  assert.deepStrictEqual(resolved.model, model);
});

/**
 * One valid model payload per entity kind, each carrying `comment` on that kind alone, paired
 * with the JSON path where a parse failure must name it.
 */
function commentPayloads(comment: unknown): ReadonlyArray<readonly [string, unknown]> {
  return [
    ['tables[0].comment', { tables: [tablePayload({ comment })], sequences: [], views: [] }],
    [
      'tables[0].columns[0].comment',
      {
        tables: [tablePayload({ columns: [{ name: 'c', type: 'text', notNull: false, comment }] })],
        sequences: [],
        views: [],
      },
    ],
    [
      'tables[0].primaryKey.comment',
      {
        tables: [tablePayload({ primaryKey: { columns: ['c'], comment } })],
        sequences: [],
        views: [],
      },
    ],
    [
      'tables[0].uniqueConstraints[0].comment',
      {
        tables: [tablePayload({ uniqueConstraints: [{ columns: ['c'], comment }] })],
        sequences: [],
        views: [],
      },
    ],
    [
      'tables[0].checkConstraints[0].comment',
      {
        tables: [tablePayload({ checkConstraints: [{ expression: 'c > 0', comment }] })],
        sequences: [],
        views: [],
      },
    ],
    [
      'tables[0].foreignKeys[0].comment',
      {
        tables: [
          tablePayload({
            foreignKeys: [
              {
                columns: ['org_id'],
                referencedTable: { schema: 'public', name: 'orgs' },
                referencedColumns: ['id'],
                comment,
              },
            ],
          }),
        ],
        sequences: [],
        views: [],
      },
    ],
    [
      'tables[0].indexes[0].comment',
      {
        tables: [tablePayload({ indexes: [{ unique: false, columns: ['c'], comment }] })],
        sequences: [],
        views: [],
      },
    ],
    ['sequences[0].comment', { tables: [], sequences: [sequencePayload({ comment })], views: [] }],
    ['views[0].comment', { tables: [], sequences: [], views: [viewPayload({ comment })] }],
  ];
}

test('resolveWorkspace fails closed on an empty comment at every entity kind', async (t) => {
  for (const [path, payload] of commentPayloads('')) {
    const diagnostic = await resolvePayload(t, payload);

    assert.equal(diagnostic.code, 'workspace-model-invalid');
    assert.equal(diagnostic.message, `invalid model: ${path} is not a non-empty string`);
  }
});

test('resolveWorkspace fails closed on a non-string comment at every entity kind', async (t) => {
  for (const [path, payload] of commentPayloads(123)) {
    const diagnostic = await resolvePayload(t, payload);

    assert.equal(diagnostic.code, 'workspace-model-invalid');
    assert.equal(diagnostic.message, `invalid model: ${path} is not a string`);
  }
});

test('resolveWorkspace fails closed on a comment containing NUL at every entity kind', async (t) => {
  for (const [path, payload] of commentPayloads('before\u0000after')) {
    const diagnostic = await resolvePayload(t, payload);

    assert.equal(diagnostic.code, 'workspace-model-invalid');
    assert.equal(diagnostic.message, `invalid model: ${path} must not contain a NUL character`);
  }
});

/** A pre-comment workspace model: all nine entity kinds, no `comment` key anywhere. */
const OLDER_MODEL: Model = {
  tables: [
    {
      schema: 'public',
      name: 'users',
      columns: [{ name: 'id', type: 'bigint', notNull: true }],
      primaryKey: { name: 'users_pkey', columns: ['id'] },
      foreignKeys: [
        {
          name: 'users_org_id_fkey',
          columns: ['org_id'],
          referencedTable: { schema: 'public', name: 'orgs' },
          referencedColumns: ['id'],
        },
      ],
      uniqueConstraints: [{ columns: ['email'] }],
      checkConstraints: [{ expression: 'age >= 0' }],
      indexes: [{ name: 'users_email_idx', unique: true, columns: ['email'] }],
    },
  ],
  sequences: [
    {
      schema: 'public',
      name: 'counter',
      dataType: 'bigint',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
    },
  ],
  views: [{ schema: 'public', name: 'active', materialized: false, definition: 'SELECT 1' }],
};

test('resolveWorkspace reads a pre-comment model as entities without a comment property', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, JSON.stringify(OLDER_MODEL, null, 2));

  const resolved = await resolveOk(dir);

  assert.deepStrictEqual(resolved.model, OLDER_MODEL);
  const table = resolved.model.tables[0]!;
  const entities: readonly object[] = [
    table,
    table.columns[0]!,
    table.primaryKey!,
    table.foreignKeys[0]!,
    table.uniqueConstraints[0]!,
    table.checkConstraints[0]!,
    table.indexes[0]!,
    resolved.model.sequences[0]!,
    resolved.model.views[0]!,
  ];
  for (const entity of entities) assert.equal('comment' in entity, false);
});
