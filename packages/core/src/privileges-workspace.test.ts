import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { resolveWorkspace, serializeModel } from './index.ts';
import type { Model } from './index.ts';

/**
 * Workspace compatibility for the privilege family. The model file stays bare JSON with no
 * version field: every new field is optional, absent fields never change old bytes, and an older
 * reader's closed key allow-list rejects a file that uses them.
 */

const oldModelKeys = ['tables', 'sequences', 'views', 'extensions'];
const oldTableKeys = [
  'schema',
  'name',
  'columns',
  'primaryKey',
  'foreignKeys',
  'uniqueConstraints',
  'checkConstraints',
  'exclusionConstraints',
  'indexes',
  'persistence',
  'comment',
];
const oldSequenceKeys = [
  'schema',
  'name',
  'dataType',
  'increment',
  'minValue',
  'maxValue',
  'start',
  'cache',
  'cycle',
  'ownedBy',
  'comment',
];

/** The old reader's key check: any unknown key fails closed with its path. */
function oldReaderFailure(value: unknown): string | undefined {
  const root = value as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!oldModelKeys.includes(key)) return `unknown field ${key}`;
  }
  for (const [index, table] of ((root.tables ?? []) as Record<string, unknown>[]).entries()) {
    for (const key of Object.keys(table)) {
      if (!oldTableKeys.includes(key)) return `unknown field tables[${index}].${key}`;
    }
  }
  for (const [index, sequence] of ((root.sequences ?? []) as Record<string, unknown>[]).entries()) {
    for (const key of Object.keys(sequence)) {
      if (!oldSequenceKeys.includes(key)) return `unknown field sequences[${index}].${key}`;
    }
  }
  return undefined;
}

/** A fresh workspace holding `text`, with cleanup registered on the test context. */
async function workspaceWith(context: TestContext, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'schemamill-privileges-'));
  context.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.schemamill'));
  await writeFile(join(dir, '.schemamill', 'model.json'), text, 'utf8');
  return dir;
}

const populated = {
  tables: [
    {
      schema: 'app',
      name: 't',
      columns: [],
      foreignKeys: [],
      uniqueConstraints: [],
      checkConstraints: [],
      indexes: [],
      owner: 'Priv App User',
      privileges: [
        { grantee: 'PUBLIC', privileges: 'ALL' },
        { grantee: 'app_user', privileges: ['SELECT', 'UPDATE'], columns: ['email'] },
      ],
    },
  ],
  sequences: [
    {
      schema: 'app',
      name: 's',
      dataType: 'bigint',
      increment: '1',
      minValue: '1',
      maxValue: '9223372036854775807',
      start: '1',
      cache: '1',
      cycle: false,
      owner: 'Priv App User',
      privileges: [{ grantee: 'app_user', privileges: ['USAGE'] }],
    },
  ],
  views: [],
  extensions: [],
  defaultPrivileges: [
    {
      roles: ['Priv App User'],
      schemas: ['app'],
      objectType: 'table',
      kind: 'revoke',
      grants: [{ grantee: 'app_user', privileges: 'ALL' }],
    },
    {
      roles: ['Priv App User'],
      schemas: ['app'],
      objectType: 'table',
      kind: 'grant',
      grants: [{ grantee: 'app_user', privileges: ['SELECT'] }],
    },
  ],
};

test('serializeModel round-trips owner, privileges, and defaultPrivileges without loss', async (t) => {
  const bytes = serializeModel(populated as unknown as Model);
  const dir = await workspaceWith(t, bytes);

  const result = await resolveWorkspace(dir);
  assert.equal(result.ok, true, result.ok ? '' : result.diagnostic.message);
  if (!result.ok) return;
  assert.deepStrictEqual(result.model, populated);
  assert.equal(serializeModel(result.model), bytes);
});

test('serializeModel emits owner and privileges before the comment and omits absent fields', () => {
  const withFields = serializeModel({
    tables: [{ ...populated.tables[0], comment: 'table note' }],
    sequences: [],
    views: [],
    extensions: [],
  } as unknown as Model);
  const payload = JSON.parse(withFields) as { tables: Record<string, unknown>[] };
  const table = payload.tables[0]!;
  assert.equal(Object.keys(table).at(-1), 'comment');
  assert.ok(Object.keys(table).indexOf('owner') < Object.keys(table).indexOf('comment'));
  assert.ok(Object.keys(table).indexOf('privileges') < Object.keys(table).indexOf('comment'));

  const withoutFields = serializeModel({
    tables: [],
    sequences: [],
    views: [],
    extensions: [],
  });
  assert.doesNotMatch(withoutFields, /owner|privileges|defaultPrivileges/);
});

test('resolveWorkspace reads a pre-privilege model byte-identically', async (t) => {
  const old = {
    tables: [
      {
        schema: 'app',
        name: 't',
        columns: [],
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        indexes: [],
      },
    ],
    sequences: [
      {
        schema: 'app',
        name: 's',
        dataType: 'bigint',
        increment: '1',
        minValue: '1',
        maxValue: '9223372036854775807',
        start: '1',
        cache: '1',
        cycle: false,
      },
    ],
    views: [],
    extensions: [],
  };
  const bytes = `${JSON.stringify(old, null, 2)}\n`;
  const dir = await workspaceWith(t, bytes);

  const result = await resolveWorkspace(dir);
  assert.equal(result.ok, true, result.ok ? '' : result.diagnostic.message);
  if (!result.ok) return;
  assert.equal('owner' in result.model.tables[0]!, false);
  assert.equal('privileges' in result.model.tables[0]!, false);
  assert.equal('owner' in result.model.sequences[0]!, false);
  assert.equal('defaultPrivileges' in result.model, false);
  assert.equal(serializeModel(result.model), bytes);
});

test('a model written with privilege fields fails an older reader closed', () => {
  const bytes = serializeModel(populated as unknown as Model);
  assert.equal(oldReaderFailure(JSON.parse(bytes)), 'unknown field defaultPrivileges');

  const withoutDefaults = { ...populated, defaultPrivileges: undefined };
  const oldBytes = serializeModel(withoutDefaults as unknown as Model);
  assert.equal(oldReaderFailure(JSON.parse(oldBytes)), 'unknown field tables[0].owner');
});

test('resolveWorkspace fails closed on unknown and malformed privilege fields', async (t) => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [
      {
        ...populated,
        tables: [
          {
            ...populated.tables[0],
            privileges: [{ grantee: 'a', privileges: 'ALL', bogus: 1 }],
          },
        ],
      },
      'invalid model: unknown field tables[0].privileges[0].bogus',
    ],
    [
      { ...populated, defaultPrivileges: [{ ...populated.defaultPrivileges[0], bogus: 1 }] },
      'invalid model: unknown field defaultPrivileges[0].bogus',
    ],
    [
      {
        ...populated,
        tables: [{ ...populated.tables[0], privileges: [{ grantee: 'a', privileges: [] }] }],
      },
      'invalid model: tables[0].privileges[0].privileges is not a non-empty list',
    ],
    [
      {
        ...populated,
        defaultPrivileges: [{ ...populated.defaultPrivileges[0], objectType: 'view' }],
      },
      'invalid model: defaultPrivileges[0].objectType is not a valid default privilege object type',
    ],
    [
      { ...populated, defaultPrivileges: [{ ...populated.defaultPrivileges[0], grants: [] }] },
      'invalid model: defaultPrivileges[0].grants is not a non-empty list',
    ],
  ];
  for (const [index, [payload, expected]] of cases.entries()) {
    const dir = await workspaceWith(t, JSON.stringify(payload));
    const result = await resolveWorkspace(dir);
    assert.equal(result.ok, false, `case ${index}: expected a failure`);
    if (result.ok) continue;
    assert.ok(
      result.diagnostic.message.startsWith(expected),
      `case ${index}: ${result.diagnostic.message} does not start with ${expected}`,
    );
  }
});
