import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CheckConstraint,
  Column,
  Extension,
  ForeignKey,
  Identity,
  Index,
  Model,
  PrimaryKey,
  Sequence,
  Table,
  UniqueConstraint,
  View,
} from '@schemamill/core';

import { renderMarkdown } from './markdown.ts';

/**
 * The pure Markdown projection contract (brief v4, D1/D2/D3/D8). No CLI wiring, no streams, no
 * fixtures on disk: this file pins the bytes, the self-sorting, and the escaping of `renderMarkdown`
 * itself. The command flags, help text, golden fixture and artifact-byte audit belong to the CLI
 * workstream; the five-gate suite belongs to the final workstream.
 */

const EMPTY_MODEL: Model = { tables: [], sequences: [], views: [], extensions: [] };

function modelWith(overrides: Partial<Model>): Model {
  return { ...EMPTY_MODEL, ...overrides };
}

function makeColumn(name: string, overrides: Partial<Column> = {}): Column {
  return { name, type: 'text', notNull: false, ...overrides };
}

function makeTable(name: string, overrides: Partial<Table> = {}): Table {
  return {
    schema: 'public',
    name,
    columns: [],
    foreignKeys: [],
    uniqueConstraints: [],
    checkConstraints: [],
    indexes: [],
    ...overrides,
  };
}

function makeIndex(overrides: Partial<Index> = {}): Index {
  return { unique: false, columns: [], ...overrides };
}

function makeUnique(overrides: Partial<UniqueConstraint> = {}): UniqueConstraint {
  return { columns: [], ...overrides };
}

function makeCheck(overrides: Partial<CheckConstraint> = {}): CheckConstraint {
  return { expression: 'true', ...overrides };
}

function makeForeignKey(overrides: Partial<ForeignKey> = {}): ForeignKey {
  return {
    columns: ['a'],
    referencedTable: { schema: 'public', name: 'p' },
    referencedColumns: ['id'],
    ...overrides,
  };
}

function makeSequence(name: string, overrides: Partial<Sequence> = {}): Sequence {
  return {
    schema: 'public',
    name,
    dataType: 'integer',
    increment: '1',
    minValue: '1',
    maxValue: '2147483647',
    start: '1',
    cache: '1',
    cycle: false,
    ...overrides,
  };
}

function makeView(name: string, overrides: Partial<View> = {}): View {
  return { schema: 'public', name, materialized: false, definition: 'SELECT 1', ...overrides };
}

function makeExtension(name: string, overrides: Partial<Extension> = {}): Extension {
  return { name, schema: 'public', ...overrides };
}

/** The bullet lines under a heading, in output order, with blank lines removed. */
function linesAfter(output: string, heading: string): string[] {
  const lines = output.split('\n');
  const start = lines.indexOf(heading) + 1;
  assert.notEqual(start, 0, `missing heading: ${heading}`);
  const next = lines.findIndex((line, index) => index >= start && line.startsWith('#'));
  return lines.slice(start, next === -1 ? undefined : next).filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Worked byte example and the empty model: the two exact pins from D2.
// ---------------------------------------------------------------------------

test('renders the worked byte example exactly', () => {
  const model = modelWith({
    tables: [makeTable('t', { columns: [makeColumn('id', { type: 'integer', notNull: true })] })],
  });
  assert.equal(
    renderMarkdown(model),
    '# Schema\n' +
      '\n' +
      '## Tables\n' +
      '\n' +
      '### Table `public.t`\n' +
      '\n' +
      '#### Columns\n' +
      '\n' +
      '- Column `id`: type `integer`, not null, default (none), collation (none), storage (none), ' +
      'compression (none), statistics target (none), comment (none), not-null comment (none)\n',
  );
});

test('renders an empty model as exactly one heading and one final LF', () => {
  assert.equal(renderMarkdown(EMPTY_MODEL), '# Schema\n');
});

test('omits empty sections and keeps the pinned section order', () => {
  const output = renderMarkdown(
    modelWith({
      views: [makeView('v')],
      extensions: [makeExtension('pgcrypto')],
    }),
  );
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('#')),
    ['# Schema', '## Views', '### View `public.v`', '## Extensions', '### Extension `pgcrypto`'],
  );
  assert.equal(output.includes('## Tables'), false);
  assert.equal(output.includes('## Sequences'), false);
});

// ---------------------------------------------------------------------------
// Self-sorting: every collection except columns, which keep source order.
// ---------------------------------------------------------------------------

test('sorts tables by schema then name', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('b', { schema: 'z' }),
        makeTable('z', { schema: 'a' }),
        makeTable('a', { schema: 'a' }),
        makeTable('a', { schema: 'b' }),
      ],
    }),
  );
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('### Table')),
    ['### Table `a.a`', '### Table `a.z`', '### Table `b.a`', '### Table `z.b`'],
  );
});

test('sorts sequences by schema then name', () => {
  const output = renderMarkdown(
    modelWith({
      sequences: [
        makeSequence('b', { schema: 'z' }),
        makeSequence('z', { schema: 'a' }),
        makeSequence('a', { schema: 'a' }),
      ],
    }),
  );
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('### Sequence')),
    ['### Sequence `a.a`', '### Sequence `a.z`', '### Sequence `z.b`'],
  );
});

test('sorts views by schema then name across both view kinds', () => {
  const output = renderMarkdown(
    modelWith({
      views: [
        makeView('b', { schema: 'z', materialized: true }),
        makeView('z', { schema: 'a' }),
        makeView('a', { schema: 'a', materialized: true }),
      ],
    }),
  );
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('### ')),
    ['### Materialized view `a.a`', '### View `a.z`', '### Materialized view `z.b`'],
  );
});

test('sorts extensions by name', () => {
  const output = renderMarkdown(
    modelWith({ extensions: [makeExtension('z'), makeExtension('a'), makeExtension('m')] }),
  );
  assert.deepEqual(
    output.split('\n').filter((line) => line.startsWith('### Extension')),
    ['### Extension `a`', '### Extension `m`', '### Extension `z`'],
  );
});

test('keeps columns in source order, never sorted by name', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          columns: [makeColumn('z'), makeColumn('a'), makeColumn('m', { notNull: true })],
        }),
      ],
    }),
  );
  assert.deepEqual(
    linesAfter(output, '#### Columns'),
    output.split('\n').filter((line) => line.startsWith('- Column ')),
  );
  assert.deepEqual(
    output
      .split('\n')
      .filter((line) => line.startsWith('- Column '))
      .map((line) => line.slice('- Column `'.length, line.indexOf('`:'))),
    ['z', 'a', 'm'],
  );
});

test('sorts indexes by optional name, unique false before true, then columns', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          indexes: [
            makeIndex({ name: 'z', unique: false, columns: ['a'] }),
            makeIndex({ unique: true, columns: ['a'] }),
            makeIndex({ name: 'a', unique: true, columns: ['a'] }),
            makeIndex({ unique: false, columns: ['z'] }),
            makeIndex({ name: 'z', unique: false, columns: ['b'] }),
            makeIndex({ name: 'a', unique: false, columns: ['a'] }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Indexes'), [
    '- name: (none), unique: no, columns: (`z`), concurrently: (none), comment: (none)',
    '- name: (none), unique: yes, columns: (`a`), concurrently: (none), comment: (none)',
    '- name: `a`, unique: no, columns: (`a`), concurrently: (none), comment: (none)',
    '- name: `a`, unique: yes, columns: (`a`), concurrently: (none), comment: (none)',
    '- name: `z`, unique: no, columns: (`a`), concurrently: (none), comment: (none)',
    '- name: `z`, unique: no, columns: (`b`), concurrently: (none), comment: (none)',
  ]);
});

test('sorts unique constraints by columns then optional name', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          uniqueConstraints: [
            makeUnique({ name: 'b', columns: ['a'] }),
            makeUnique({ columns: ['b'] }),
            makeUnique({ name: 'a', columns: ['a'] }),
            makeUnique({ columns: ['a'] }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Unique constraints'), [
    '- name: (none), columns: (`a`), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: `a`, columns: (`a`), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: `b`, columns: (`a`), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`b`), deferrable: (none), initially deferred: (none), comment: (none)',
  ]);
});

test('sorts check constraints by expression then optional name', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          checkConstraints: [
            makeCheck({ name: 'b', expression: 'a > 0' }),
            makeCheck({ expression: 'b > 0' }),
            makeCheck({ name: 'a', expression: 'a > 0' }),
            makeCheck({ expression: 'a > 0' }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Check constraints'), [
    '- name: (none), expression: `a > 0`, enforcement: (none), comment: (none)',
    '- name: `a`, expression: `a > 0`, enforcement: (none), comment: (none)',
    '- name: `b`, expression: `a > 0`, enforcement: (none), comment: (none)',
    '- name: (none), expression: `b > 0`, enforcement: (none), comment: (none)',
  ]);
});

test('sorts foreign keys by the full pinned comparator chain', () => {
  const base = makeForeignKey();
  const comment = makeForeignKey({ comment: 'z' });
  const enforcement = makeForeignKey({ enforcement: 'not-valid' });
  const deferrable = makeForeignKey({ deferrable: true });
  const onDelete = makeForeignKey({ onDelete: 'CASCADE' });
  const onUpdate = makeForeignKey({ onUpdate: 'RESTRICT' });
  const referencedColumns = makeForeignKey({ referencedColumns: ['z'] });
  const name = makeForeignKey({ name: 'z' });
  const referencedName = makeForeignKey({ referencedTable: { schema: 'public', name: 'z' } });
  const referencedSchema = makeForeignKey({ referencedTable: { schema: 'z', name: 'p' } });
  const columns = makeForeignKey({ columns: ['b'] });

  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          foreignKeys: [
            columns,
            referencedSchema,
            referencedName,
            name,
            referencedColumns,
            onUpdate,
            onDelete,
            deferrable,
            enforcement,
            comment,
            base,
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Foreign keys'), [
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: `z`',
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: `not-valid`, deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: yes, initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: `CASCADE`, enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: `RESTRICT`, on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `public.p`, referenced columns: (`z`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: `z`, columns: (`a`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `public.z`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`a`), referenced table: `z.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
    '- name: (none), columns: (`b`), referenced table: `public.p`, referenced columns: (`id`), on update: (none), on delete: (none), enforcement: (none), deferrable: (none), initially deferred: (none), comment: (none)',
  ]);
});

test('uses JSON.stringify as the final tiebreak for every table nested collection', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          indexes: [
            makeIndex({ columns: ['a'], comment: 'b' }),
            makeIndex({ columns: ['a'], comment: 'a' }),
          ],
          uniqueConstraints: [
            makeUnique({ columns: ['a'], comment: 'b' }),
            makeUnique({ columns: ['a'], comment: 'a' }),
          ],
          checkConstraints: [
            makeCheck({ expression: 'x > 0', comment: 'b' }),
            makeCheck({ expression: 'x > 0', comment: 'a' }),
          ],
          foreignKeys: [
            makeForeignKey({ initiallyDeferred: true }),
            makeForeignKey({ initiallyDeferred: false }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Indexes'), [
    '- name: (none), unique: no, columns: (`a`), concurrently: (none), comment: `a`',
    '- name: (none), unique: no, columns: (`a`), concurrently: (none), comment: `b`',
  ]);
  assert.deepEqual(linesAfter(output, '#### Unique constraints'), [
    '- name: (none), columns: (`a`), deferrable: (none), initially deferred: (none), comment: `a`',
    '- name: (none), columns: (`a`), deferrable: (none), initially deferred: (none), comment: `b`',
  ]);
  assert.deepEqual(linesAfter(output, '#### Check constraints'), [
    '- name: (none), expression: `x > 0`, enforcement: (none), comment: `a`',
    '- name: (none), expression: `x > 0`, enforcement: (none), comment: `b`',
  ]);
  const foreignKeys = linesAfter(output, '#### Foreign keys');
  assert.deepEqual(
    foreignKeys.map((line) => line.includes('initially deferred: yes')),
    [false, true],
  );
});

test('uses JSON.stringify as the final tiebreak for matview indexes', () => {
  const output = renderMarkdown(
    modelWith({
      views: [
        makeView('mv', {
          materialized: true,
          indexes: [
            makeIndex({ name: 'i', columns: ['a'], comment: 'b' }),
            makeIndex({ name: 'i', columns: ['a'], comment: 'a' }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Indexes'), [
    '- name: `i`, unique: no, columns: (`a`), concurrently: (none), comment: `a`',
    '- name: `i`, unique: no, columns: (`a`), concurrently: (none), comment: `b`',
  ]);
});

// ---------------------------------------------------------------------------
// All four families, both view kinds, nested bullets, and all 11 comment slots.
// ---------------------------------------------------------------------------

const IDENTITY: Identity = {
  generated: 'always',
  sequenceName: { schema: 'app', name: 'users_id_seq' },
  increment: '1',
  minValue: '1',
  maxValue: '9223372036854775807',
  start: '1',
  cache: '1',
  cycle: false,
};

const RICH_MODEL: Model = {
  tables: [
    {
      schema: 'app',
      name: 'users',
      columns: [
        makeColumn('id', {
          type: 'bigint',
          notNull: true,
          notNullName: 'users_id_nn',
          notNullComment: 'nn comment',
          identity: IDENTITY,
          comment: 'id comment',
        }),
        makeColumn('email', {
          default: "'unknown'",
          collation: '"C"',
          storage: 'extended',
          compression: 'lz4',
          statisticsTarget: 0,
          comment: 'email comment',
        }),
      ],
      primaryKey: {
        name: 'users_pkey',
        columns: ['id'],
        deferrable: true,
        initiallyDeferred: true,
        comment: 'pk comment',
      } satisfies PrimaryKey,
      uniqueConstraints: [
        makeUnique({
          name: 'users_email_key',
          columns: ['email'],
          deferrable: false,
          initiallyDeferred: false,
          comment: 'uq comment',
        }),
      ],
      checkConstraints: [
        makeCheck({
          name: 'users_id_check',
          expression: 'id > 0',
          enforcement: 'not-valid',
          comment: 'ck comment',
        }),
      ],
      foreignKeys: [
        makeForeignKey({
          name: 'users_org_fkey',
          columns: ['org_id'],
          referencedTable: { schema: 'app', name: 'orgs' },
          referencedColumns: ['id'],
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
          deferrable: true,
          initiallyDeferred: false,
          enforcement: 'not-enforced',
          comment: 'fk comment',
        }),
      ],
      indexes: [
        makeIndex({
          name: 'users_email_idx',
          unique: true,
          columns: ['email'],
          concurrently: true,
          comment: 'idx comment',
        }),
      ],
      persistence: 'unlogged',
      comment: 'table comment',
    },
  ],
  sequences: [
    makeSequence('users_id_seq', {
      schema: 'app',
      dataType: 'bigint',
      maxValue: '9223372036854775807',
      ownedBy: { table: { schema: 'app', name: 'users' }, column: 'id' },
      comment: 'seq comment',
    }),
  ],
  views: [
    makeView('active_users', {
      schema: 'app',
      definition: 'SELECT id FROM app.users WHERE id > 0',
      checkOption: 'local',
      comment: 'view comment',
    }),
    makeView('user_stats', {
      schema: 'app',
      materialized: true,
      definition: 'SELECT count(*) FROM app.users',
      indexes: [
        makeIndex({ name: 'user_stats_idx', columns: ['count'], comment: 'mv idx comment' }),
      ],
      comment: 'matview comment',
    }),
  ],
  extensions: [makeExtension('pgcrypto', { comment: 'ext comment' })],
};

const EXPECTED_RICH =
  '# Schema\n' +
  '\n' +
  '## Tables\n' +
  '\n' +
  '### Table `app.users`\n' +
  '\n' +
  '- Comment: `table comment`\n' +
  '- Persistence: `unlogged`\n' +
  '\n' +
  '#### Columns\n' +
  '\n' +
  '- Column `id`: type `bigint`, not null, default (none), collation (none), storage (none), ' +
  'compression (none), statistics target (none), comment `id comment`, not-null comment `nn comment`\n' +
  '  - Not-null constraint name: `users_id_nn`\n' +
  '  - Identity: generation `always`, sequence `app.users_id_seq`, increment `1`, min `1`, ' +
  'max `9223372036854775807`, start `1`, cache `1`, cycle no\n' +
  '- Column `email`: type `text`, nullable, default `\'unknown\'`, collation `"C"`, ' +
  'storage `extended`, compression `lz4`, statistics target 0, comment `email comment`, ' +
  'not-null comment (none)\n' +
  '\n' +
  '#### Primary key\n' +
  '\n' +
  '- name: `users_pkey`, columns: (`id`), deferrable: yes, initially deferred: yes, ' +
  'comment: `pk comment`\n' +
  '\n' +
  '#### Unique constraints\n' +
  '\n' +
  '- name: `users_email_key`, columns: (`email`), deferrable: no, initially deferred: no, ' +
  'comment: `uq comment`\n' +
  '\n' +
  '#### Check constraints\n' +
  '\n' +
  '- name: `users_id_check`, expression: `id > 0`, enforcement: `not-valid`, ' +
  'comment: `ck comment`\n' +
  '\n' +
  '#### Foreign keys\n' +
  '\n' +
  '- name: `users_org_fkey`, columns: (`org_id`), referenced table: `app.orgs`, ' +
  'referenced columns: (`id`), on update: `CASCADE`, on delete: `RESTRICT`, ' +
  'enforcement: `not-enforced`, deferrable: yes, initially deferred: no, comment: `fk comment`\n' +
  '\n' +
  '#### Indexes\n' +
  '\n' +
  '- name: `users_email_idx`, unique: yes, columns: (`email`), concurrently: yes, ' +
  'comment: `idx comment`\n' +
  '\n' +
  '## Sequences\n' +
  '\n' +
  '### Sequence `app.users_id_seq`\n' +
  '\n' +
  '- data type: `bigint`\n' +
  '- increment: `1`\n' +
  '- min: `1`\n' +
  '- max: `9223372036854775807`\n' +
  '- start: `1`\n' +
  '- cache: `1`\n' +
  '- cycle: no\n' +
  '- owned by: `app.users.id`\n' +
  '- comment: `seq comment`\n' +
  '\n' +
  '## Views\n' +
  '\n' +
  '### View `app.active_users`\n' +
  '\n' +
  '- definition: `SELECT id FROM app.users WHERE id > 0`\n' +
  '- check option: `local`\n' +
  '- comment: `view comment`\n' +
  '\n' +
  '### Materialized view `app.user_stats`\n' +
  '\n' +
  '- definition: `SELECT count(*) FROM app.users`\n' +
  '- comment: `matview comment`\n' +
  '\n' +
  '#### Indexes\n' +
  '\n' +
  '- name: `user_stats_idx`, unique: no, columns: (`count`), concurrently: (none), comment: `mv idx comment`\n' +
  '\n' +
  '## Extensions\n' +
  '\n' +
  '### Extension `pgcrypto`\n' +
  '\n' +
  '- schema: `public`\n' +
  '- comment: `ext comment`\n';

test('renders all four families, both view kinds, nested bullets and matview indexes', () => {
  assert.equal(renderMarkdown(RICH_MODEL), EXPECTED_RICH);
});

test('renders all 11 comment slots', () => {
  const model = modelWith({
    tables: [
      makeTable('t', {
        comment: 'marker',
        columns: [
          makeColumn('c', {
            notNull: true,
            notNullName: 'nn',
            notNullComment: 'marker',
            comment: 'marker',
          }),
        ],
        primaryKey: { columns: ['c'], comment: 'marker' },
        uniqueConstraints: [makeUnique({ columns: ['c'], comment: 'marker' })],
        checkConstraints: [makeCheck({ expression: 'c > 0', comment: 'marker' })],
        foreignKeys: [makeForeignKey({ comment: 'marker' })],
        indexes: [makeIndex({ columns: ['c'], comment: 'marker' })],
      }),
    ],
    sequences: [makeSequence('s', { comment: 'marker' })],
    views: [
      makeView('v', { comment: 'marker' }),
      makeView('mv', {
        materialized: true,
        indexes: [makeIndex({ columns: ['c'] })],
      }),
    ],
    extensions: [makeExtension('e', { comment: 'marker' })],
  });
  const output = renderMarkdown(model);
  assert.equal(output.split('`marker`').length - 1, 11);
  assert.equal(output.includes('not-null comment `marker`'), true);
});

test('renders nested not-null-name and identity bullets in the pinned field order', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          columns: [makeColumn('c', { notNull: true, notNullName: 'nn', identity: IDENTITY })],
        }),
      ],
    }),
  );
  assert.deepEqual(linesAfter(output, '#### Columns'), [
    '- Column `c`: type `text`, not null, default (none), collation (none), storage (none), ' +
      'compression (none), statistics target (none), comment (none), not-null comment (none)',
    '  - Not-null constraint name: `nn`',
    '  - Identity: generation `always`, sequence `app.users_id_seq`, increment `1`, ' +
      'min `1`, max `9223372036854775807`, start `1`, cache `1`, cycle no',
  ]);
});

// ---------------------------------------------------------------------------
// Determinism under shuffled input; columns are exempt (source order is semantic).
// ---------------------------------------------------------------------------

function reversed<T>(items: readonly T[]): readonly T[] {
  return [...items].reverse();
}

function shuffled(model: Model): Model {
  return {
    tables: reversed(model.tables).map((table) => ({
      ...table,
      columns: table.columns,
      foreignKeys: reversed(table.foreignKeys),
      uniqueConstraints: reversed(table.uniqueConstraints),
      checkConstraints: reversed(table.checkConstraints),
      indexes: reversed(table.indexes),
    })),
    sequences: reversed(model.sequences),
    views: reversed(model.views).map((view) => ({
      ...view,
      ...(view.indexes === undefined ? {} : { indexes: reversed(view.indexes) }),
    })),
    extensions: reversed(model.extensions),
  };
}

test('renders a shuffled model byte-identically to the ordered one', () => {
  const many = modelWith({
    tables: [
      makeTable('a', {
        foreignKeys: [makeForeignKey({ columns: ['a'] }), makeForeignKey({ columns: ['b'] })],
        uniqueConstraints: [makeUnique({ columns: ['a'] }), makeUnique({ columns: ['b'] })],
        checkConstraints: [makeCheck({ expression: 'a > 0' }), makeCheck({ expression: 'b > 0' })],
        indexes: [makeIndex({ columns: ['a'] }), makeIndex({ columns: ['b'] })],
      }),
      makeTable('b', {
        schema: 'z',
        columns: [makeColumn('z'), makeColumn('a')],
        indexes: [makeIndex({ columns: ['z'] }), makeIndex({ columns: ['a'] })],
      }),
    ],
    sequences: [makeSequence('a'), makeSequence('b', { schema: 'z' })],
    views: [
      makeView('a'),
      makeView('b', {
        materialized: true,
        indexes: [makeIndex({ columns: ['a'] }), makeIndex({ columns: ['b'] })],
      }),
    ],
    extensions: [makeExtension('a'), makeExtension('z')],
  });
  const other = shuffled(many);
  assert.notEqual(JSON.stringify(other), JSON.stringify(many));
  assert.equal(renderMarkdown(other), renderMarkdown(many));
});

test('shuffling the rich fixture leaves its pinned bytes unchanged', () => {
  assert.notEqual(JSON.stringify(shuffled(RICH_MODEL)), JSON.stringify(RICH_MODEL));
  assert.equal(renderMarkdown(shuffled(RICH_MODEL)), EXPECTED_RICH);
});

// ---------------------------------------------------------------------------
// Escaping battery: code spans, line endings, controls, pipes, quoted spans.
// ---------------------------------------------------------------------------

const COLUMN_PREFIX = '# Schema\n\n## Tables\n\n### Table `s.t`\n\n#### Columns\n\n';

function renderColumnComment(value: string): string {
  return renderMarkdown(
    modelWith({
      tables: [makeTable('t', { schema: 's', columns: [makeColumn('c', { comment: value })] })],
    }),
  );
}

function expectedColumnComment(value: string): string {
  return (
    COLUMN_PREFIX +
    '- Column `c`: type `text`, nullable, default (none), collation (none), storage (none), ' +
    `compression (none), statistics target (none), comment ${value}, not-null comment (none)\n`
  );
}

test('escapes backticks with a fence one longer than the longest run', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['plain', '`plain`'],
    ['a`b', '``a`b``'],
    ['`lead', '`` `lead ``'],
    ['trail`', '`` trail` ``'],
    ['``double``', '``` ``double`` ```'],
    ['a``b', '```a``b```'],
    ['a```b', '````a```b````'],
    ['a\\`b', '``a\\`b``'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(renderColumnComment(input), expectedColumnComment(expected), input);
  }
});

test('maps CRLF, lone CR and LF to one <br> each', () => {
  assert.equal(renderColumnComment('a\r\nb\rc\nd'), expectedColumnComment('`a<br>b<br>c<br>d`'));
  assert.equal(renderColumnComment('\r\n'), expectedColumnComment('`<br>`'));
});

test('renders a tab as the two literal characters \\t', () => {
  assert.equal(renderColumnComment('a\tb'), expectedColumnComment('`a\\tb`'));
});

test('maps C0, DEL and C1 controls to uppercase \\uXXXX', () => {
  const input = String.fromCharCode(0, 1, 31, 127, 128, 159);
  assert.equal(
    renderColumnComment(input),
    expectedColumnComment('`\\u0000\\u0001\\u001F\\u007F\\u0080\\u009F`'),
  );
});

test('escapes a pipe inside a code span with a backslash', () => {
  assert.equal(renderColumnComment('a|b'), expectedColumnComment('`a\\|b`'));
});

test('keeps quoted-span newlines as <br> inside one code span', () => {
  assert.equal(
    renderColumnComment("where x = 'a\r\nb'"),
    expectedColumnComment("`where x = 'a<br>b'`"),
  );
});

test('renders absent as bare (none), empty arrays as (none), numbers in decimal', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('t', {
          columns: [makeColumn('c', { statisticsTarget: 0, default: '' })],
          indexes: [makeIndex({ columns: [] })],
        }),
      ],
    }),
  );
  assert.equal(
    linesAfter(output, '#### Columns')[0],
    '- Column `c`: type `text`, nullable, default ``, collation (none), storage (none), ' +
      'compression (none), statistics target 0, comment (none), not-null comment (none)',
  );
  assert.equal(
    linesAfter(output, '#### Indexes')[0],
    '- name: (none), unique: no, columns: (none), concurrently: (none), comment: (none)',
  );
  assert.equal(output.includes('Persistence: (none)'), false);
});

test('uses one code span for a qualified name', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [makeTable('t', { schema: 'we`ird' })],
      sequences: [
        makeSequence('s', {
          schema: 'a',
          ownedBy: { table: { schema: 'we`ird', name: 't' }, column: 'c' },
        }),
      ],
    }),
  );
  assert.equal(output.includes('### Table ``we`ird.t``\n'), true);
  assert.equal(output.includes('- owned by: ``we`ird.t.c``\n'), true);
  assert.equal(output.includes('`we`ird`.`t`'), false);
});

// ---------------------------------------------------------------------------
// Block layout: one blank after every heading, none between bullets, one final LF.
// ---------------------------------------------------------------------------

test('pins the block layout: blank after headings, contiguous bullets, one final LF', () => {
  const output = renderMarkdown(RICH_MODEL);
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.endsWith('\n\n'), false);
  assert.equal(output.includes('\n\n\n'), false);

  const lines = output.split('\n');
  for (const [index, line] of lines.entries()) {
    const next = lines[index + 1];
    if (line.startsWith('#')) assert.equal(next, '', `heading needs one blank: ${line}`);
    if (line.startsWith('- ') && next?.startsWith('- ')) {
      assert.equal(next.startsWith('  - '), line.startsWith('  - '));
    }
  }
  assert.deepEqual(
    lines.filter((line) => line.startsWith('### ') || line.startsWith('## ')),
    [
      '## Tables',
      '### Table `app.users`',
      '## Sequences',
      '### Sequence `app.users_id_seq`',
      '## Views',
      '### View `app.active_users`',
      '### Materialized view `app.user_stats`',
      '## Extensions',
      '### Extension `pgcrypto`',
    ],
  );
});

test('separates adjacent entity blocks with exactly one blank line', () => {
  const output = renderMarkdown(
    modelWith({
      tables: [
        makeTable('a', { columns: [makeColumn('c')] }),
        makeTable('b', { columns: [makeColumn('c')] }),
      ],
    }),
  );
  assert.equal(
    output,
    '# Schema\n\n## Tables\n\n### Table `public.a`\n\n#### Columns\n\n' +
      '- Column `c`: type `text`, nullable, default (none), collation (none), storage (none), ' +
      'compression (none), statistics target (none), comment (none), not-null comment (none)\n' +
      '\n### Table `public.b`\n\n#### Columns\n\n' +
      '- Column `c`: type `text`, nullable, default (none), collation (none), storage (none), ' +
      'compression (none), statistics target (none), comment (none), not-null comment (none)\n',
  );
});
