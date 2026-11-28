import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  Change,
  CheckConstraint,
  Column,
  CommentTarget,
  DefaultPrivilege,
  Diagnostic,
  ExclusionConstraint,
  Extension,
  ExtensionIdentity,
  ForeignKey,
  Grant,
  Hazard,
  HazardEntity,
  Identity,
  Index,
  IndexOwner,
  Model,
  PrimaryKey,
  Sequence,
  SequenceIdentity,
  Step,
  Table,
  TableChange,
  TableIdentity,
  TransactionGroup,
  UniqueConstraint,
  View,
  ViewIdentity,
} from '@schemamill/core';
import { version } from '@schemamill/core';

import { formatDiagnostics } from './diagnostics.ts';
import { buildJsonDocument, stringifyJsonDocument } from './json.ts';
import type { JsonDocument, JsonDocumentInput, JsonSideInput } from './json.ts';
import { importPair } from './run.ts';

/**
 * The JSON mapper contract, pinned without spawning the CLI: the envelope shape, the DTO key sets
 * for every documented kind, the documented field order, and byte determinism. Command wiring and
 * the `--json` stream/exit matrix belong to the E2E workstream; this file pins the pure mapper the
 * command will call.
 */

const EMPTY_MODEL: Model = { tables: [], sequences: [], views: [], extensions: [] };

// ---------------------------------------------------------------------------
// Payload fixtures. Every model value is built with the field names `serializeModel` uses; the
// only `comment` left on a payload is the one a comment target needs stripped of its own text.
// ---------------------------------------------------------------------------

const TABLE_ID: TableIdentity = { schema: 'public', name: 'widgets' };
const SEQUENCE_ID: SequenceIdentity = { schema: 'public', name: 'widget_seq' };
const VIEW_ID: ViewIdentity = { schema: 'public', name: 'active_widgets' };
const EXTENSION_ID: ExtensionIdentity = { name: 'pgcrypto' };

const COLUMN: Column = {
  name: 'id',
  type: 'integer',
  notNull: true,
  notNullComment: 'not-null note',
};
const PRIMARY_KEY: PrimaryKey = { columns: ['id'] };
const FOREIGN_KEY: ForeignKey = {
  columns: ['owner_id'],
  referencedTable: { schema: 'public', name: 'owners' },
  referencedColumns: ['id'],
};
const UNIQUE_CONSTRAINT: UniqueConstraint = { columns: ['id'] };
const CHECK_CONSTRAINT: CheckConstraint = { expression: 'id > 0' };
const EXCLUSION_CONSTRAINT: ExclusionConstraint = {
  name: 'widgets_no_overlap',
  elements: 'id WITH =',
  where: 'id > 0',
  deferrable: true,
};
const INDEX: Index = { unique: false, columns: ['id'] };
const GRANT: Grant = {
  grantee: 'app_user',
  privileges: ['SELECT'],
  columns: ['email'],
  grantOption: true,
};
const DEFAULT_PRIVILEGE: DefaultPrivilege = {
  roles: ['postgres'],
  schemas: ['app'],
  objectType: 'table',
  kind: 'grant',
  grants: [GRANT],
};
const IDENTITY: Identity = {
  generated: 'always',
  increment: '1',
  minValue: '1',
  maxValue: '2147483647',
  start: '1',
  cache: '1',
  cycle: false,
};
const SEQUENCE: Sequence = {
  schema: 'public',
  name: 'widget_seq',
  dataType: 'integer',
  increment: '1',
  minValue: '1',
  maxValue: '2147483647',
  start: '1',
  cache: '1',
  cycle: false,
  owner: 'postgres',
  privileges: [GRANT],
};
const VIEW: View = {
  schema: 'public',
  name: 'active_widgets',
  materialized: false,
  definition: 'SELECT 1',
};
const EXTENSION: Extension = { name: 'pgcrypto', schema: 'public' };
const TABLE: Table = {
  ...TABLE_ID,
  columns: [COLUMN],
  primaryKey: PRIMARY_KEY,
  foreignKeys: [FOREIGN_KEY],
  uniqueConstraints: [UNIQUE_CONSTRAINT],
  checkConstraints: [CHECK_CONSTRAINT],
  exclusionConstraints: [EXCLUSION_CONSTRAINT],
  indexes: [INDEX],
  persistence: 'unlogged',
  owner: 'postgres',
  privileges: [GRANT],
};
const TABLE_OWNER: IndexOwner = { kind: 'table', table: TABLE_ID };
const MATVIEW_OWNER: IndexOwner = { kind: 'materialized-view', view: VIEW_ID };

const COMMENT_TARGETS: readonly CommentTarget[] = [
  { kind: 'table', table: TABLE_ID },
  { kind: 'column', table: TABLE_ID, column: 'id' },
  {
    kind: 'not-null',
    table: TABLE_ID,
    column: { name: 'id', type: 'integer', notNull: true },
  },
  { kind: 'sequence', sequence: SEQUENCE_ID },
  { kind: 'view', view: VIEW_ID, materialized: false },
  { kind: 'extension', extension: EXTENSION_ID },
  { kind: 'index', table: TABLE_ID, index: INDEX },
  { kind: 'primary-key', table: TABLE_ID, primaryKey: PRIMARY_KEY },
  { kind: 'unique-constraint', table: TABLE_ID, uniqueConstraint: UNIQUE_CONSTRAINT },
  { kind: 'check-constraint', table: TABLE_ID, checkConstraint: CHECK_CONSTRAINT },
  {
    kind: 'exclusion-constraint',
    table: TABLE_ID,
    exclusionConstraint: EXCLUSION_CONSTRAINT,
  },
  { kind: 'foreign-key', table: TABLE_ID, foreignKey: FOREIGN_KEY },
];

/** One instance of every `TableChange` kind, inside a single `table-changed` change. */
const TABLE_CHANGES: readonly TableChange[] = [
  { kind: 'column-added', column: COLUMN },
  { kind: 'column-removed', column: COLUMN },
  {
    kind: 'column-changed',
    name: 'id',
    fields: [{ field: 'type', before: 'int', after: 'integer' }],
    identity: { kind: 'changed', fields: [{ field: 'increment', before: '1', after: '2' }] },
    attributes: { type: 'integer', collation: 'C' },
  },
  { kind: 'primary-key-added', primaryKey: PRIMARY_KEY },
  { kind: 'primary-key-removed', primaryKey: PRIMARY_KEY },
  { kind: 'primary-key-changed', before: PRIMARY_KEY, after: PRIMARY_KEY },
  { kind: 'foreign-key-added', foreignKey: FOREIGN_KEY },
  { kind: 'foreign-key-removed', foreignKey: FOREIGN_KEY },
  { kind: 'foreign-key-changed', before: FOREIGN_KEY, after: FOREIGN_KEY },
  { kind: 'unique-constraint-added', uniqueConstraint: UNIQUE_CONSTRAINT },
  { kind: 'unique-constraint-removed', uniqueConstraint: UNIQUE_CONSTRAINT },
  { kind: 'unique-constraint-changed', before: UNIQUE_CONSTRAINT, after: UNIQUE_CONSTRAINT },
  { kind: 'check-constraint-added', checkConstraint: CHECK_CONSTRAINT },
  { kind: 'check-constraint-removed', checkConstraint: CHECK_CONSTRAINT },
  { kind: 'check-constraint-changed', before: CHECK_CONSTRAINT, after: CHECK_CONSTRAINT },
  {
    kind: 'exclusion-constraint-added',
    exclusionConstraint: EXCLUSION_CONSTRAINT,
  },
  {
    kind: 'exclusion-constraint-removed',
    exclusionConstraint: EXCLUSION_CONSTRAINT,
  },
  {
    kind: 'exclusion-constraint-changed',
    before: EXCLUSION_CONSTRAINT,
    after: EXCLUSION_CONSTRAINT,
  },
  { kind: 'index-added', index: INDEX },
  { kind: 'index-removed', index: INDEX },
  { kind: 'index-changed', before: INDEX, after: INDEX },
  { kind: 'persistence-changed', before: 'unlogged' },
  { kind: 'owner-changed', before: 'postgres', after: 'app' },
  { kind: 'privileges-changed', before: [GRANT], after: [GRANT] },
];

/** One instance of every `Change` kind, plus one `comment-changed` per `CommentTarget` kind. */
const CHANGES: readonly Change[] = [
  { kind: 'table-added', table: TABLE },
  { kind: 'table-removed', table: TABLE },
  { kind: 'table-changed', table: TABLE_ID, changes: TABLE_CHANGES },
  { kind: 'sequence-added', sequence: SEQUENCE },
  { kind: 'sequence-removed', sequence: SEQUENCE },
  {
    kind: 'sequence-changed',
    sequence: SEQUENCE_ID,
    changes: [
      { field: 'dataType', before: 'integer', after: 'bigint' },
      { field: 'cycle', before: false, after: true },
      { field: 'maxValue', before: '1', after: '2', converted: true },
      { field: 'ownedBy', after: { table: TABLE_ID, column: 'id' } },
      { field: 'owner', before: 'postgres', after: 'app' },
      { field: 'privileges', before: [GRANT], after: [GRANT] },
    ],
  },
  {
    kind: 'default-privileges-changed',
    before: [],
    after: [DEFAULT_PRIVILEGE],
  },
  { kind: 'view-added', view: VIEW },
  { kind: 'view-removed', view: VIEW },
  {
    kind: 'view-changed',
    view: VIEW_ID,
    changes: [{ field: 'checkOption', after: 'local' }],
    before: VIEW,
    after: VIEW,
  },
  { kind: 'view-index-added', owner: MATVIEW_OWNER, index: INDEX },
  { kind: 'view-index-removed', owner: MATVIEW_OWNER, index: INDEX },
  { kind: 'view-index-changed', owner: MATVIEW_OWNER, before: INDEX, after: INDEX },
  { kind: 'extension-added', extension: EXTENSION },
  { kind: 'extension-removed', extension: EXTENSION },
  {
    kind: 'extension-changed',
    extension: EXTENSION_ID,
    changes: [{ field: 'schema', before: 'public', after: 'extensions' }],
  },
  ...COMMENT_TARGETS.map((target): Change => ({
    kind: 'comment-changed',
    target,
    before: 'old',
    after: 'new',
  })),
];

/** One instance of every `Step` kind, plus one `comment` step per `CommentTarget` kind. */
const STEPS: readonly Step[] = [
  { kind: 'create-schema', schema: 'extensions' },
  { kind: 'create-table', table: TABLE },
  { kind: 'drop-table', table: TABLE_ID },
  { kind: 'add-column', table: TABLE_ID, column: COLUMN },
  { kind: 'drop-column', table: TABLE_ID, column: COLUMN },
  {
    kind: 'alter-column',
    table: TABLE_ID,
    name: 'id',
    fields: [{ field: 'default', after: '0' }],
    attributes: { type: 'integer' },
  },
  { kind: 'drop-not-null', table: TABLE_ID, column: 'id', name: 'nn_id' },
  { kind: 'add-not-null', table: TABLE_ID, column: 'id' },
  { kind: 'alter-persistence', table: TABLE_ID, persistence: 'unlogged' },
  { kind: 'add-identity', table: TABLE_ID, name: 'id', identity: IDENTITY },
  { kind: 'drop-identity', table: TABLE_ID, name: 'id' },
  {
    kind: 'alter-identity',
    table: TABLE_ID,
    name: 'id',
    fields: [{ field: 'minValue', before: '1', after: '2', converted: true }],
  },
  { kind: 'add-primary-key', table: TABLE_ID, primaryKey: PRIMARY_KEY },
  { kind: 'drop-primary-key', table: TABLE_ID, primaryKey: PRIMARY_KEY },
  { kind: 'add-foreign-key', table: TABLE_ID, foreignKey: FOREIGN_KEY },
  { kind: 'drop-foreign-key', table: TABLE_ID, foreignKey: FOREIGN_KEY },
  { kind: 'add-unique-constraint', table: TABLE_ID, uniqueConstraint: UNIQUE_CONSTRAINT },
  { kind: 'drop-unique-constraint', table: TABLE_ID, uniqueConstraint: UNIQUE_CONSTRAINT },
  { kind: 'add-check-constraint', table: TABLE_ID, checkConstraint: CHECK_CONSTRAINT },
  { kind: 'drop-check-constraint', table: TABLE_ID, checkConstraint: CHECK_CONSTRAINT },
  {
    kind: 'add-exclusion-constraint',
    table: TABLE_ID,
    exclusionConstraint: EXCLUSION_CONSTRAINT,
  },
  {
    kind: 'drop-exclusion-constraint',
    table: TABLE_ID,
    exclusionConstraint: EXCLUSION_CONSTRAINT,
  },
  { kind: 'create-index', owner: TABLE_OWNER, index: INDEX },
  { kind: 'drop-index', owner: TABLE_OWNER, index: INDEX },
  { kind: 'create-index-concurrently', owner: MATVIEW_OWNER, index: INDEX },
  { kind: 'drop-index-concurrently', owner: MATVIEW_OWNER, index: INDEX },
  { kind: 'create-sequence', sequence: SEQUENCE },
  { kind: 'drop-sequence', sequence: SEQUENCE_ID },
  {
    kind: 'alter-sequence',
    sequence: SEQUENCE_ID,
    fields: [{ field: 'ownedBy', before: { table: TABLE_ID, column: 'id' } }],
  },
  { kind: 'create-extension', extension: EXTENSION },
  {
    kind: 'alter-extension',
    extension: EXTENSION_ID,
    fields: [{ field: 'schema', before: 'public', after: 'extensions' }],
  },
  { kind: 'drop-extension', extension: EXTENSION_ID },
  { kind: 'create-view', view: VIEW },
  { kind: 'drop-view', view: VIEW_ID, materialized: true },
  { kind: 'replace-view', view: VIEW },
  {
    kind: 'alter-owner',
    object: { kind: 'table', table: TABLE_ID },
    owner: 'app',
  },
  { kind: 'grant', object: { kind: 'table', table: TABLE_ID }, grant: GRANT },
  { kind: 'revoke', object: { kind: 'sequence', sequence: SEQUENCE_ID }, grant: GRANT },
  { kind: 'alter-default-privileges', privilege: DEFAULT_PRIVILEGE },
  ...COMMENT_TARGETS.map((target): Step => ({ kind: 'comment', target, text: 'a comment' })),
];

const SEQUENCE_ENTITY: HazardEntity = { kind: 'sequence', sequence: SEQUENCE_ID };
const IDENTITY_ENTITY: HazardEntity = { kind: 'identity-column', table: TABLE_ID, column: 'id' };
const TABLE_ENTITY: HazardEntity = { kind: 'table', table: TABLE_ID };
const INDEX_COLLISION_ENTITY: HazardEntity = {
  kind: 'name-collision',
  scope: 'index',
  schema: 'public',
  names: ['shared_idx', 'shared_idx'],
};
const CONSTRAINT_COLLISION_ENTITY: HazardEntity = {
  kind: 'name-collision',
  scope: 'constraint',
  schema: 'public',
  table: 't',
  names: ['t_a_key', 't_a_key'],
};
const DECLARATION_ENTITY: HazardEntity = {
  kind: 'unsupported-declaration',
  schema: 'public',
  table: 't',
  declaration: 'named-not-null',
  targetVersion: 13,
  floor: 18,
};

/** One instance of every `Hazard` kind, spanning every `HazardEntity` kind. */
const HAZARDS: readonly Hazard[] = [
  { kind: 'increment-zero', step: 0, entity: SEQUENCE_ENTITY, increment: '0' },
  { kind: 'cache-nonpositive', step: 1, entity: IDENTITY_ENTITY, cache: '0' },
  { kind: 'bounds-inverted', step: 2, entity: SEQUENCE_ENTITY, minValue: '10', maxValue: '1' },
  {
    kind: 'start-out-of-bounds',
    step: 3,
    entity: SEQUENCE_ENTITY,
    start: '0',
    minValue: '1',
    maxValue: '10',
  },
  {
    kind: 'bound-out-of-type-range',
    step: 4,
    entity: SEQUENCE_ENTITY,
    dataType: 'integer',
    field: 'max',
    value: '9223372036854775807',
  },
  {
    kind: 'bound-tightened',
    step: 5,
    entity: IDENTITY_ENTITY,
    field: 'min',
    before: '1',
    after: '5',
  },
  { kind: 'table-rewrite', step: 6, entity: TABLE_ENTITY, persistence: 'unlogged' },
  { kind: 'render-refusal', step: 7, entity: INDEX_COLLISION_ENTITY },
  { kind: 'render-refusal', step: 8, entity: CONSTRAINT_COLLISION_ENTITY },
  { kind: 'render-refusal', step: 9, entity: DECLARATION_ENTITY },
];

const GROUPS: readonly TransactionGroup[] = [
  { start: 0, end: 2, transactional: true },
  { start: 2, end: 3, transactional: false },
];

const SKIP_DIAGNOSTIC: Diagnostic = {
  kind: 'skip',
  code: 'unsupported-statement',
  object: 'public.gone',
  message: 'skipped unsupported statement',
  position: { offset: 12, line: 2, column: 3 },
};
const FLAG_DIAGNOSTIC: Diagnostic = {
  kind: 'flag',
  code: 'unsupported-attribute',
  object: 'public.widgets',
  message: 'flagged an unsupported attribute',
};
const ERROR_DIAGNOSTIC: Diagnostic = {
  kind: 'error',
  code: 'parse-failure',
  message: 'could not parse',
};

// ---------------------------------------------------------------------------
// Mapper inputs
// ---------------------------------------------------------------------------

const DUMP_BASELINE: JsonSideInput = {
  source: 'dump',
  path: 'baseline.sql',
  model: EMPTY_MODEL,
  diagnostics: [SKIP_DIAGNOSTIC, FLAG_DIAGNOSTIC, ERROR_DIAGNOSTIC],
};
const DUMP_TARGET: JsonSideInput = {
  source: 'dump',
  path: 'target.sql',
  model: EMPTY_MODEL,
  diagnostics: [],
};
const WORKSPACE_TARGET: JsonSideInput = {
  source: 'workspace',
  root: '/work/project',
  model: EMPTY_MODEL,
  diagnostics: [],
};

function compareInput(
  changes: readonly Change[] = [],
  baseline: JsonSideInput = DUMP_BASELINE,
  target: JsonSideInput = WORKSPACE_TARGET,
): JsonDocumentInput {
  return { command: 'compare', baseline, target, changes };
}

function planInput(
  steps: readonly Step[] = [],
  hazards: readonly Hazard[] = [],
  groups: readonly TransactionGroup[] = GROUPS,
): JsonDocumentInput {
  return {
    command: 'plan',
    baseline: DUMP_BASELINE,
    target: WORKSPACE_TARGET,
    targetVersion: 16,
    steps,
    groups,
    hazards,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** `?` marks an optional field: allowed but not required. Order-independent key-set equality. */
function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const required = expected.filter((key) => !key.endsWith('?')).map((key) => key);
  const optional = expected.filter((key) => key.endsWith('?')).map((key) => key.slice(0, -1));
  const actual = Object.keys(value);
  for (const key of required) {
    assert.ok(actual.includes(key), `${label} is missing ${key}`);
  }
  for (const key of actual) {
    assert.ok(
      required.includes(key) || optional.includes(key),
      `${label} has unexpected key ${key}`,
    );
  }
  assert.equal(new Set(actual).size, actual.length, `${label} repeats a key`);
}

const CHANGE_KEYS: Record<Change['kind'], readonly string[]> = {
  'table-added': ['kind', 'table'],
  'table-removed': ['kind', 'table'],
  'table-changed': ['kind', 'table', 'changes'],
  'sequence-added': ['kind', 'sequence'],
  'sequence-removed': ['kind', 'sequence'],
  'sequence-changed': ['kind', 'sequence', 'changes'],
  'view-added': ['kind', 'view'],
  'view-removed': ['kind', 'view'],
  'view-changed': ['kind', 'view', 'changes', 'before', 'after'],
  'view-index-added': ['kind', 'owner', 'index'],
  'view-index-removed': ['kind', 'owner', 'index'],
  'view-index-changed': ['kind', 'owner', 'before', 'after'],
  'extension-added': ['kind', 'extension'],
  'extension-removed': ['kind', 'extension'],
  'extension-changed': ['kind', 'extension', 'changes'],
  'default-privileges-changed': ['kind', 'before', 'after'],
  'comment-changed': ['kind', 'target', 'before?', 'after?'],
};

const TABLE_CHANGE_KEYS: Record<TableChange['kind'], readonly string[]> = {
  'column-added': ['kind', 'column'],
  'column-removed': ['kind', 'column'],
  'column-changed': ['kind', 'name', 'fields', 'identity?', 'attributes?'],
  'primary-key-added': ['kind', 'primaryKey'],
  'primary-key-removed': ['kind', 'primaryKey'],
  'primary-key-changed': ['kind', 'before', 'after'],
  'foreign-key-added': ['kind', 'foreignKey'],
  'foreign-key-removed': ['kind', 'foreignKey'],
  'foreign-key-changed': ['kind', 'before', 'after'],
  'unique-constraint-added': ['kind', 'uniqueConstraint'],
  'unique-constraint-removed': ['kind', 'uniqueConstraint'],
  'unique-constraint-changed': ['kind', 'before', 'after'],
  'check-constraint-added': ['kind', 'checkConstraint'],
  'check-constraint-removed': ['kind', 'checkConstraint'],
  'check-constraint-changed': ['kind', 'before', 'after'],
  'exclusion-constraint-added': ['kind', 'exclusionConstraint'],
  'exclusion-constraint-removed': ['kind', 'exclusionConstraint'],
  'exclusion-constraint-changed': ['kind', 'before', 'after'],
  'index-added': ['kind', 'index'],
  'index-removed': ['kind', 'index'],
  'index-changed': ['kind', 'before', 'after'],
  'persistence-changed': ['kind', 'before?', 'after?'],
  'owner-changed': ['kind', 'before?', 'after?'],
  'privileges-changed': ['kind', 'before?', 'after?'],
};

const STEP_KEYS: Record<Step['kind'], readonly string[]> = {
  'create-schema': ['kind', 'schema'],
  'create-table': ['kind', 'table'],
  'drop-table': ['kind', 'table'],
  'add-column': ['kind', 'table', 'column'],
  'drop-column': ['kind', 'table', 'column'],
  'alter-column': ['kind', 'table', 'name', 'fields', 'attributes?'],
  'drop-not-null': ['kind', 'table', 'column', 'name?'],
  'add-not-null': ['kind', 'table', 'column', 'name?'],
  'alter-persistence': ['kind', 'table', 'persistence?'],
  'add-identity': ['kind', 'table', 'name', 'identity'],
  'drop-identity': ['kind', 'table', 'name'],
  'alter-identity': ['kind', 'table', 'name', 'fields'],
  'add-primary-key': ['kind', 'table', 'primaryKey'],
  'drop-primary-key': ['kind', 'table', 'primaryKey'],
  'add-foreign-key': ['kind', 'table', 'foreignKey'],
  'drop-foreign-key': ['kind', 'table', 'foreignKey'],
  'add-unique-constraint': ['kind', 'table', 'uniqueConstraint'],
  'drop-unique-constraint': ['kind', 'table', 'uniqueConstraint'],
  'add-check-constraint': ['kind', 'table', 'checkConstraint'],
  'drop-check-constraint': ['kind', 'table', 'checkConstraint'],
  'add-exclusion-constraint': ['kind', 'table', 'exclusionConstraint'],
  'drop-exclusion-constraint': ['kind', 'table', 'exclusionConstraint'],
  'create-index': ['kind', 'owner', 'index'],
  'drop-index': ['kind', 'owner', 'index'],
  'create-index-concurrently': ['kind', 'owner', 'index'],
  'drop-index-concurrently': ['kind', 'owner', 'index'],
  'create-sequence': ['kind', 'sequence'],
  'drop-sequence': ['kind', 'sequence'],
  'alter-sequence': ['kind', 'sequence', 'fields'],
  'create-extension': ['kind', 'extension'],
  'alter-extension': ['kind', 'extension', 'fields'],
  'drop-extension': ['kind', 'extension'],
  'create-view': ['kind', 'view'],
  'drop-view': ['kind', 'view', 'materialized'],
  'replace-view': ['kind', 'view'],
  'alter-owner': ['kind', 'object', 'owner'],
  grant: ['kind', 'object', 'grant'],
  revoke: ['kind', 'object', 'grant'],
  'alter-default-privileges': ['kind', 'privilege'],
  comment: ['kind', 'target', 'text?'],
};

const HAZARD_KEYS: Record<Hazard['kind'], readonly string[]> = {
  'increment-zero': ['kind', 'step', 'entity', 'increment'],
  'cache-nonpositive': ['kind', 'step', 'entity', 'cache'],
  'bounds-inverted': ['kind', 'step', 'entity', 'minValue', 'maxValue'],
  'start-out-of-bounds': ['kind', 'step', 'entity', 'start', 'minValue', 'maxValue'],
  'bound-out-of-type-range': ['kind', 'step', 'entity', 'dataType', 'field', 'value'],
  'bound-tightened': ['kind', 'step', 'entity', 'field', 'before', 'after'],
  'table-rewrite': ['kind', 'step', 'entity', 'persistence?'],
  'render-refusal': ['kind', 'step', 'entity'],
};

const COMMENT_TARGET_KEYS: Record<CommentTarget['kind'], readonly string[]> = {
  table: ['kind', 'table'],
  column: ['kind', 'table', 'column'],
  'not-null': ['kind', 'table', 'column'],
  sequence: ['kind', 'sequence'],
  view: ['kind', 'view', 'materialized'],
  extension: ['kind', 'extension'],
  index: ['kind', 'table', 'index'],
  'primary-key': ['kind', 'table', 'primaryKey'],
  'unique-constraint': ['kind', 'table', 'uniqueConstraint'],
  'check-constraint': ['kind', 'table', 'checkConstraint'],
  'exclusion-constraint': ['kind', 'table', 'exclusionConstraint'],
  'foreign-key': ['kind', 'table', 'foreignKey'],
};

const HAZARD_ENTITY_KEYS: Record<HazardEntity['kind'], readonly string[]> = {
  sequence: ['kind', 'sequence'],
  'identity-column': ['kind', 'table', 'column'],
  table: ['kind', 'table'],
  'name-collision': ['kind', 'scope', 'schema', 'table?', 'names'],
  'unsupported-declaration': ['kind', 'schema', 'table?', 'declaration', 'targetVersion', 'floor'],
};

const INDEX_OWNER_KEYS: Record<IndexOwner['kind'], readonly string[]> = {
  table: ['kind', 'table'],
  'materialized-view': ['kind', 'view'],
};

const PRIVILEGE_OBJECT_KEYS: Record<string, readonly string[]> = {
  table: ['kind', 'table'],
  sequence: ['kind', 'sequence'],
};

const DIAGNOSTIC_KEYS: Record<Diagnostic['kind'], readonly string[]> = {
  skip: ['kind', 'code', 'object', 'message', 'position?'],
  flag: ['kind', 'code', 'object', 'message', 'position?'],
  error: ['kind', 'code', 'message', 'position?'],
};

function kindOf(value: object): string {
  const kind = (value as { kind?: unknown }).kind;
  assert.equal(typeof kind, 'string', 'a DTO has no string kind');
  return kind as string;
}

function fieldOf(value: object, name: string): unknown {
  return (value as Record<string, unknown>)[name];
}

function assertKinds(
  values: readonly object[],
  table: Readonly<Record<string, readonly string[]>>,
  label: string,
): void {
  for (const value of values) {
    const kind = kindOf(value);
    const expected = table[kind];
    assert.ok(expected !== undefined, `${label} has no key set for ${kind}`);
    assertExactKeys(value, expected, `${label}/${kind}`);
  }
}

function assertCoverage(
  kinds: readonly string[],
  table: Readonly<Record<string, readonly string[]>>,
  label: string,
): void {
  const seen = new Set(kinds);
  for (const kind of Object.keys(table)) {
    assert.ok(seen.has(kind), `${label} fixture does not cover ${kind}`);
  }
}

/** Every field name any documented DTO may carry; an internal addition fails this whitelist. */
const ALLOWED_KEYS = new Set<string>([
  // Envelope
  'schemaVersion',
  'command',
  'schemamill',
  'version',
  'workspace',
  'root',
  'sides',
  'baseline',
  'target',
  'source',
  'path',
  'model',
  'tables',
  'sequences',
  'views',
  'extensions',
  'diagnostics',
  'result',
  'changes',
  'targetVersion',
  'steps',
  'groups',
  'hazards',
  'start',
  'end',
  'transactional',
  // Diagnostics
  'kind',
  'code',
  'object',
  'message',
  'position',
  'line',
  'column',
  'offset',
  // Model payloads
  'schema',
  'name',
  'columns',
  'primaryKey',
  'foreignKey',
  'uniqueConstraint',
  'checkConstraint',
  'exclusionConstraint',
  'index',
  'foreignKeys',
  'uniqueConstraints',
  'checkConstraints',
  'exclusionConstraints',
  'indexes',
  'persistence',
  'comment',
  'type',
  'notNull',
  'notNullName',
  'notNullComment',
  'default',
  'identity',
  'collation',
  'storage',
  'compression',
  'statisticsTarget',
  'generated',
  'sequenceName',
  'increment',
  'minValue',
  'maxValue',
  'cache',
  'cycle',
  'deferrable',
  'initiallyDeferred',
  'expression',
  'elements',
  'accessMethod',
  'enforcement',
  'referencedTable',
  'referencedColumns',
  'onUpdate',
  'onDelete',
  'unique',
  'include',
  'where',
  'concurrently',
  'dataType',
  'ownedBy',
  'owner',
  'privileges',
  'defaultPrivileges',
  'privilege',
  'grant',
  'grants',
  'grantee',
  'grantOption',
  'objectType',
  'object',
  'roles',
  'schemas',
  'materialized',
  'definition',
  'dependsOn',
  'checkOption',
  // Field changes and change/step/hazard payloads
  'field',
  'fields',
  'attributes',
  'before',
  'after',
  'converted',
  'reason',
  'table',
  'sequence',
  'view',
  'owner',
  'extension',
  'entity',
  'step',
  'scope',
  'names',
  'declaration',
  'floor',
  'value',
  'text',
]);

function assertNoInternalKeys(value: unknown, path = '$', unknown: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInternalKeys(entry, `${path}[${index}]`, unknown));
    return unknown;
  }
  if (value === null || typeof value !== 'object') return unknown;
  for (const [key, child] of Object.entries(value)) {
    if (!ALLOWED_KEYS.has(key)) unknown.push(`${path}.${key}`);
    assertNoInternalKeys(child, `${path}.${key}`, unknown);
  }
  return unknown;
}

function collect(values: readonly object[], field: string): readonly object[] {
  return values.flatMap((value) => {
    const nested = fieldOf(value, field);
    return Array.isArray(nested) ? (nested as object[]) : [];
  });
}

/** Only `table-changed` carries `TableChange[]`; other changes' `changes` are field differences. */
function tableChangesOf(changes: readonly object[]): readonly object[] {
  return collect(
    changes.filter((change) => kindOf(change) === 'table-changed'),
    'changes',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the compare document has the documented envelope and carries only changes', () => {
  const document = buildJsonDocument(compareInput());
  assert.equal(document.command, 'compare');
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.schemamill, { version });
  assert.deepEqual(document.workspace, { root: '/work/project' });
  assert.deepEqual(document.sides, {
    baseline: {
      source: 'dump',
      path: 'baseline.sql',
      model: { tables: 0, sequences: 0, views: 0, extensions: 0 },
    },
    target: {
      source: 'workspace',
      model: { tables: 0, sequences: 0, views: 0, extensions: 0 },
    },
  });
  assert.deepEqual(document.diagnostics.baseline.map(kindOf), ['skip', 'flag', 'error']);
  assert.deepEqual(document.diagnostics.target, []);
  assert.deepEqual(document.result, { changes: [] });
  assert.deepEqual(stringifyJsonDocument(document), `${JSON.stringify(document, null, 2)}\n`);
});

test('the plan document carries targetVersion, steps, groups and hazards and no SQL', () => {
  const document = buildJsonDocument(planInput(STEPS, HAZARDS));
  assert.equal(document.command, 'plan');
  assert.deepEqual(Object.keys(document.result), ['targetVersion', 'steps', 'groups', 'hazards']);
  assert.equal(document.result.targetVersion, 16);
  assert.deepEqual(document.result.groups, GROUPS);
  assert.equal(document.result.steps.length, STEPS.length);
  assert.equal(document.result.hazards.length, HAZARDS.length);
  assert.ok(!('sql' in document.result), 'the plan document must not embed rendered SQL');
  assert.ok(!JSON.stringify(document).includes('CREATE TABLE'), 'no rendered SQL leaked');
});

test('the workspace is null when neither side used one and a dump path is present only for dumps', () => {
  const document = buildJsonDocument(compareInput([], DUMP_BASELINE, DUMP_TARGET));
  assert.equal(document.workspace, null);
  assert.deepEqual(Object.keys(document.sides.baseline), ['source', 'path', 'model']);
  assert.deepEqual(Object.keys(document.sides.target), ['source', 'path', 'model']);
});

test('every documented kind maps with exact recursive keys and the fixtures cover them all', () => {
  const compare = buildJsonDocument(compareInput(CHANGES));
  const plan = buildJsonDocument(planInput(STEPS, HAZARDS));
  assert.equal(compare.command, 'compare');
  assert.equal(plan.command, 'plan');

  const changes = compare.result.changes;
  const steps = plan.result.steps;
  const hazards = plan.result.hazards;
  assertKinds(changes, CHANGE_KEYS, 'change');
  assertKinds(tableChangesOf(changes), TABLE_CHANGE_KEYS, 'table change');
  assertKinds(steps, STEP_KEYS, 'step');
  assertKinds(hazards, HAZARD_KEYS, 'hazard');
  assertKinds(
    [...compare.diagnostics.baseline, ...compare.diagnostics.target],
    DIAGNOSTIC_KEYS,
    'diagnostic',
  );

  const targets = [
    ...changes.map((change) => fieldOf(change, 'target')).filter((value) => value !== undefined),
    ...steps.map((step) => fieldOf(step, 'target')).filter((value) => value !== undefined),
  ] as object[];
  assertKinds(targets, COMMENT_TARGET_KEYS, 'comment target');
  assertKinds(
    hazards.map((hazard) => fieldOf(hazard, 'entity') as object),
    HAZARD_ENTITY_KEYS,
    'hazard entity',
  );
  assertKinds(
    [...changes, ...steps]
      .map((dto) => fieldOf(dto, 'owner'))
      .filter((value) => typeof value === 'object' && value !== null),
    INDEX_OWNER_KEYS,
    'index owner',
  );
  const privilegeObjects = [...changes, ...steps]
    .map((dto) => fieldOf(dto, 'object'))
    .filter((value) => typeof value === 'object' && value !== null);
  assertKinds(privilegeObjects, PRIVILEGE_OBJECT_KEYS, 'privilege object');

  assertCoverage(changes.map(kindOf), CHANGE_KEYS, 'change');
  assertCoverage(tableChangesOf(changes).map(kindOf), TABLE_CHANGE_KEYS, 'table change');
  assertCoverage(steps.map(kindOf), STEP_KEYS, 'step');
  assertCoverage(hazards.map(kindOf), HAZARD_KEYS, 'hazard');
  assertCoverage(targets.map(kindOf), COMMENT_TARGET_KEYS, 'comment target');
  assertCoverage(
    hazards.map((hazard) => kindOf(fieldOf(hazard, 'entity') as object)),
    HAZARD_ENTITY_KEYS,
    'hazard entity',
  );
  assertCoverage(
    [...changes, ...steps]
      .map((dto) => fieldOf(dto, 'owner'))
      .filter((value) => typeof value === 'object' && value !== null)
      .map(kindOf),
    INDEX_OWNER_KEYS,
    'index owner',
  );
  assertCoverage(privilegeObjects.map(kindOf), PRIVILEGE_OBJECT_KEYS, 'privilege object');

  // No internal field leaks anywhere in either document.
  assert.deepEqual(
    [...assertNoInternalKeys(compare), ...assertNoInternalKeys(plan)],
    [],
    'every key in both documents must be a documented field',
  );
});

/**
 * D7 — the numeric statistics target travels through the JSON mapper unchanged, including 0,
 * and the absent side is omitted rather than nulled. The model payload, the differing-field
 * payload and the step's `attributes` payload each get their own exact recursive key set.
 */
test('a column statistics target maps with exact recursive keys on both sides', () => {
  const document = buildJsonDocument(
    compareInput([
      {
        kind: 'table-changed',
        table: TABLE_ID,
        changes: [
          {
            kind: 'column-added',
            column: { name: 'measured', type: 'integer', notNull: false, statisticsTarget: 500 },
          },
          {
            kind: 'column-changed',
            name: 'measured',
            fields: [
              { field: 'statisticsTarget', after: 500 },
              { field: 'statisticsTarget', before: 500 },
              { field: 'statisticsTarget', after: 0 },
            ],
            attributes: { type: 'integer', statisticsTarget: 500 },
          },
        ],
      },
    ]),
  );
  assert.equal(document.command, 'compare');
  const [tableChange] = document.result.changes;
  assert.notEqual(tableChange, undefined);
  const [addition, change] = fieldOf(tableChange!, 'changes') as object[];
  assert.notEqual(addition, undefined);
  assert.notEqual(change, undefined);

  assertExactKeys(addition!, ['kind', 'column'], 'statistics target addition');
  const column = fieldOf(addition!, 'column') as object;
  assertExactKeys(
    column,
    ['name', 'type', 'notNull', 'statisticsTarget'],
    'statistics target column',
  );
  assert.equal(fieldOf(column, 'statisticsTarget'), 500);

  assertExactKeys(change!, ['kind', 'name', 'fields', 'attributes'], 'statistics target change');
  const fields = fieldOf(change!, 'fields') as object[];
  assert.deepEqual(fields, [
    { field: 'statisticsTarget', after: 500 },
    { field: 'statisticsTarget', before: 500 },
    { field: 'statisticsTarget', after: 0 },
  ]);
  for (const field of fields) {
    assertExactKeys(field, ['field', 'before?', 'after?'], 'statistics target field change');
  }
  const attributes = fieldOf(change!, 'attributes') as object;
  assertExactKeys(attributes, ['type', 'statisticsTarget'], 'statistics target attributes');
  assert.equal(fieldOf(attributes, 'statisticsTarget'), 500);
  assert.deepEqual(assertNoInternalKeys(document), []);
});

test('diagnostics carry object and position.offset where present', () => {
  const document = buildJsonDocument(compareInput()) as Extract<
    JsonDocument,
    { command: 'compare' }
  >;
  const [skip, flag, error] = document.diagnostics.baseline;
  assert.deepEqual(skip, {
    kind: 'skip',
    code: 'unsupported-statement',
    object: 'public.gone',
    message: 'skipped unsupported statement',
    position: { line: 2, column: 3, offset: 12 },
  });
  assert.deepEqual(flag, {
    kind: 'flag',
    code: 'unsupported-attribute',
    object: 'public.widgets',
    message: 'flagged an unsupported attribute',
  });
  assert.deepEqual(error, { kind: 'error', code: 'parse-failure', message: 'could not parse' });
});

test('empty arrays serialize as [] and optional fields are omitted, not null', () => {
  const document = buildJsonDocument(compareInput([], DUMP_TARGET, WORKSPACE_TARGET));
  const text = stringifyJsonDocument(document);
  assert.ok(text.includes('"changes": []'));
  assert.ok(text.includes('"baseline": []'));
  assert.ok(text.includes('"target": []'));
  assert.ok(text.includes('"diagnostics": {'));
  assert.ok(!text.includes('"object": null'));
  assert.ok(!text.includes('"position": null'));
  const plan = stringifyJsonDocument(buildJsonDocument(planInput([], [], [])));
  assert.ok(plan.includes('"steps": []'));
  assert.ok(plan.includes('"groups": []'));
  assert.ok(plan.includes('"hazards": []'));
});

test('the documented field order is stable at every level', () => {
  const compare = buildJsonDocument(compareInput(CHANGES));
  const plan = buildJsonDocument(planInput(STEPS, HAZARDS));
  assert.equal(compare.command, 'compare');
  assert.equal(plan.command, 'plan');
  assert.deepEqual(Object.keys(compare), [
    'schemaVersion',
    'command',
    'schemamill',
    'workspace',
    'sides',
    'diagnostics',
    'result',
  ]);
  assert.deepEqual(Object.keys(compare.schemamill), ['version']);
  assert.deepEqual(Object.keys(compare.workspace!), ['root']);
  assert.deepEqual(Object.keys(compare.sides), ['baseline', 'target']);
  assert.deepEqual(Object.keys(compare.sides.baseline), ['source', 'path', 'model']);
  assert.deepEqual(Object.keys(compare.sides.baseline.model), [
    'tables',
    'sequences',
    'views',
    'extensions',
  ]);
  assert.deepEqual(Object.keys(compare.diagnostics), ['baseline', 'target']);
  assert.deepEqual(Object.keys(compare.diagnostics.baseline[0]!), [
    'kind',
    'code',
    'object',
    'message',
    'position',
  ]);
  assert.deepEqual(Object.keys(compare.diagnostics.baseline[0]!.position!), [
    'line',
    'column',
    'offset',
  ]);
  assert.deepEqual(Object.keys(compare.result), ['changes']);
  assert.deepEqual(Object.keys(plan.result), ['targetVersion', 'steps', 'groups', 'hazards']);
  assert.deepEqual(Object.keys(plan.result.groups[0]!), ['start', 'end', 'transactional']);
  assert.deepEqual(Object.keys(plan.result.hazards[0]!), ['kind', 'step', 'entity', 'increment']);
  assert.deepEqual(Object.keys(plan.result.steps[0]!), ['kind', 'schema']);
  assert.deepEqual(Object.keys(compare.result.changes[0]!), ['kind', 'table']);
});

test('mapping the same inputs twice produces identical bytes', () => {
  const compare = compareInput(CHANGES);
  const plan = planInput(STEPS, HAZARDS);
  assert.equal(
    stringifyJsonDocument(buildJsonDocument(compare)),
    stringifyJsonDocument(buildJsonDocument(compare)),
  );
  assert.equal(
    stringifyJsonDocument(buildJsonDocument(plan)),
    stringifyJsonDocument(buildJsonDocument(plan)),
  );
  // Two-space indentation and exactly one trailing newline.
  const bytes = stringifyJsonDocument(buildJsonDocument(compareInput()));
  assert.ok(bytes.startsWith('{\n  "schemaVersion": 1,\n'));
  assert.ok(bytes.endsWith('\n'));
  assert.ok(!bytes.endsWith('\n\n'));
});

/**
 * D2b — the mapper's inputs reach the command without changing the human path.
 *
 * One side resolves from a workspace (so its root must travel), the other is a dump carrying a
 * psql meta-command (so its skip diagnostic must travel with `object` and `position`). The stderr
 * the call writes is captured and compared with `formatDiagnostics`, pinning the byte-identical
 * default path: widening `importPair`'s return value neither adds a line nor reorders one.
 */
test('importPair surfaces per-side diagnostics and the workspace root without new stderr', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'schemamill-run-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.schemamill'), { recursive: true });
  await writeFile(
    join(dir, '.schemamill', 'model.json'),
    `${JSON.stringify(EMPTY_MODEL, null, 2)}\n`,
    'utf8',
  );
  const dumpPath = join(dir, 'target.sql');
  await writeFile(dumpPath, `${String.raw`\echo hello`}\n`, 'utf8');

  const originalCwd = process.cwd();
  const stream: { write: (chunk: string | Uint8Array) => boolean } = process.stderr;
  const originalWrite = stream.write;
  let stderr = '';
  try {
    stream.write = (chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    };
    process.chdir(dir);
    const imported = await importPair(
      { kind: 'workspace' },
      { kind: 'path', path: dumpPath },
      true,
    );
    assert.notEqual(imported, null);
    const pair = imported!;

    // The existing fields still carry the models and the exit code.
    assert.deepEqual(pair.baseline, EMPTY_MODEL);
    assert.deepEqual(pair.target, EMPTY_MODEL);
    assert.equal(pair.exitCode, 0);

    // The workspace side carries its root and no diagnostics; the dump side carries every
    // diagnostic in dump order, including the skip's object and source position.
    assert.deepEqual(pair.sides.baseline, {
      source: 'workspace',
      root: process.cwd(),
      diagnostics: [],
    });
    const diagnostics = pair.sides.target.diagnostics;
    assert.ok(diagnostics.length > 0);
    const skip = diagnostics[0]!;
    assert.equal(skip.kind, 'skip');
    assert.equal(skip.code, 'psql-meta-command');
    assert.equal(skip.object, String.raw`\echo`);
    assert.ok(skip.position !== undefined);
    assert.deepEqual(pair.sides.target, {
      source: 'dump',
      path: dumpPath,
      diagnostics,
    });

    // The human path's stderr is unchanged: baseline contributes nothing, target prints its
    // counts line and its one skip line under --verbose, in that order.
    assert.equal(stderr, formatDiagnostics('target', diagnostics, true));
  } finally {
    process.chdir(originalCwd);
    stream.write = originalWrite;
  }
});

test('the JSON mapper carries view output columns and their incompatibility diagnostic', () => {
  const before: View = {
    ...VIEW,
    columns: [
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'text' },
    ],
  };
  const after: View = {
    ...VIEW,
    columns: [
      { name: 'x', type: 'integer' },
      { name: 'b', type: 'text' },
    ],
  };
  const document = buildJsonDocument(
    compareInput([
      {
        kind: 'view-changed',
        view: VIEW_ID,
        changes: [
          {
            field: 'columns',
            before: before.columns,
            after: after.columns,
            column: 'a',
            reason: 'renamed to x',
          },
        ],
        before,
        after,
      },
    ]),
  );
  const result = document.result as {
    changes: readonly {
      before: object;
      after: object;
      changes: readonly object[];
    }[];
  };

  assert.deepEqual(result.changes[0]!.before, before);
  assert.deepEqual(result.changes[0]!.after, after);
  assert.deepEqual(result.changes[0]!.changes[0], {
    field: 'columns',
    before: [
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'text' },
    ],
    after: [
      { name: 'x', type: 'integer' },
      { name: 'b', type: 'text' },
    ],
    column: 'a',
    reason: 'renamed to x',
  });
});

test('the JSON mapper carries view dependencies alongside output columns', () => {
  const view: View = {
    ...VIEW,
    columns: [{ name: 'id', type: 'integer' }],
    dependsOn: [
      { kind: 'view', schema: 'public', name: 'base' },
      { kind: 'relation', schema: 'public', name: 'events' },
    ],
  };
  const document = buildJsonDocument(compareInput([{ kind: 'view-added', view }]));
  const result = document.result as { changes: readonly { view: object }[] };
  const mapped = result.changes[0]!.view;

  assertExactKeys(
    mapped,
    ['schema', 'name', 'materialized', 'definition', 'columns', 'dependsOn'],
    'view',
  );
  assert.deepEqual(mapped, view);
  const bytes = stringifyJsonDocument(document);
  assert.ok(bytes.includes('"columns": ['));
  assert.ok(bytes.includes('"dependsOn": ['));
  assert.deepEqual(assertNoInternalKeys(document), []);
});

test('the JSON mapper carries expression elements, INCLUDE, and the partial WHERE', () => {
  const entry: Index = {
    name: 't_idx',
    unique: false,
    columns: ['a', { expression: 'lower(b)' }],
    include: ['c'],
    where: 'a > 0',
  };
  const document = buildJsonDocument(
    compareInput([
      {
        kind: 'table-changed',
        table: TABLE_ID,
        changes: [{ kind: 'index-added', index: entry }],
      },
    ]),
  );
  const result = document.result as {
    changes: readonly { changes: readonly { index: unknown }[] }[];
  };
  assert.deepEqual(result.changes[0]!.changes[0]!.index, {
    name: 't_idx',
    unique: false,
    columns: ['a', { expression: 'lower(b)' }],
    include: ['c'],
    where: 'a > 0',
  });
});
