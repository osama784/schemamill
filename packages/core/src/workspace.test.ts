import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  effectiveSequence,
  initWorkspace,
  resolveWorkspace,
  WORKSPACE_DIR_NAME,
  WORKSPACE_MODEL_FILE_NAME,
} from './index.ts';
import type { Model, Table, WorkspaceDiagnostic } from './index.ts';
import { serializeModel } from './workspace.ts';

/**
 * Tests for the workspace container: the `.schemamill/model.json` layout, resolution's walk
 * and marker-state table, init's refusals and exact empty model, and the internal writer's
 * byte-level determinism. Layout paths and bytes are pinned literally beside the exported
 * constants so a renamed marker cannot pass silently.
 */

/** The empty model's exact file bytes: two-space JSON and a trailing newline. */
const EMPTY_MODEL_BYTES = '{\n  "tables": [],\n  "sequences": []\n}\n';

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
};

test('resolveWorkspace reads back a populated model written literally', async (t) => {
  const dir = await fixtureDir(t);
  await writeWorkspace(dir, POPULATED_MODEL_JSON);

  const resolved = await resolveOk(dir);

  assert.equal(resolved.root, dir);
  assert.deepStrictEqual(resolved.model, POPULATED_MODEL);
});

test('resolveWorkspace walks up from a nested directory to the nearest root', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);
  const nested = join(dir, 'a', 'b', 'c');
  await mkdir(nested, { recursive: true });

  const resolved = await resolveOk(nested);

  assert.equal(resolved.root, dir);
  assert.deepStrictEqual(resolved.model, { tables: [], sequences: [] });
});

test('resolveWorkspace resolves the root given explicitly', async (t) => {
  const dir = await fixtureDir(t);
  await initOk(dir);

  const resolved = await resolveOk(dir);

  assert.equal(resolved.root, dir);
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
    '  "sequences": []',
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
  };
  const reordered: Model = {
    tables: [...model.tables].reverse(),
    sequences: [...model.sequences].reverse(),
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
