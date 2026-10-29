import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Identity, IdentityGeneration } from './identity.ts';
import type {
  CheckConstraint,
  Column,
  ColumnCompression,
  ColumnStorage,
  ConstraintEnforcement,
  Extension,
  ForeignKey,
  Index,
  Model,
  PrimaryKey,
  ReferentialAction,
  Sequence,
  SequenceDataType,
  SequenceOwner,
  Table,
  TableIdentity,
  TablePersistence,
  UniqueConstraint,
  View,
  ViewCheckOption,
} from './model.ts';

/**
 * The workspace container on disk: the layout of a user's model and how a starting path
 * resolves to it.
 *
 * Layout (ADR 0010): a workspace root is a directory holding a hidden `.schemamill/`
 * directory, and the canonical model lives at `.schemamill/model.json` as bare model JSON —
 * no wrapper and no version field. The marker directory is tool-managed: the model is read
 * and written through this module, never hand-edited.
 *
 * Resolution is lexical — `path.resolve` then a walk to the filesystem root, with no
 * `realpath` or symlink resolution — and the nearest marker wins: a corrupt nearest root is
 * reported, never skipped over. `startPath` is required; core never consults the process's
 * working directory.
 *
 * `initWorkspace` refuses to overwrite an existing marker (the repair for a crash between
 * the marker and the model is to remove `.schemamill/` and re-run), refuses to nest a
 * workspace inside an existing one, claims the marker with an atomic `mkdir`, and then
 * writes the canonical model it is given — the empty model unless the caller supplies one.
 *
 * `serializeModel` is internal to this module — `initWorkspace` and `writeWorkspaceModel` use
 * it, and tests pin its exact bytes. `writeWorkspaceModel` is the public writer: it replaces
 * an existing workspace's model atomically, through a same-directory temp file and a rename,
 * and never creates a marker, a directory, or a workspace.
 */

/** The hidden marker directory a workspace root contains. */
export const WORKSPACE_DIR_NAME = '.schemamill';

/** The canonical model's file name inside the marker directory. */
export const WORKSPACE_MODEL_FILE_NAME = 'model.json';

/**
 * Stable machine-readable codes for workspace failures:
 * - `workspace-not-found` — the walk found no marker up to the filesystem root;
 * - `workspace-marker-invalid` — `.schemamill` exists but is not a directory;
 * - `workspace-inaccessible` — a marker's state could not be inspected;
 * - `workspace-model-missing` — a marker exists but holds no `model.json`;
 * - `workspace-model-unreadable` — the model file could not be read;
 * - `workspace-model-invalid` — the model file is not valid JSON or not a canonical model;
 * - `workspace-target-not-directory` — init's target exists but is not a directory;
 * - `workspace-already-exists` — init's target already holds a `.schemamill` marker;
 * - `workspace-inside-workspace` — init's target sits inside an existing workspace;
 * - `workspace-io` — init could not create the target, the marker, or the model file, or a
 *   write could not update an existing model file.
 */
export type WorkspaceDiagnosticCode =
  | 'workspace-not-found'
  | 'workspace-marker-invalid'
  | 'workspace-inaccessible'
  | 'workspace-model-missing'
  | 'workspace-model-unreadable'
  | 'workspace-model-invalid'
  | 'workspace-target-not-directory'
  | 'workspace-already-exists'
  | 'workspace-inside-workspace'
  | 'workspace-io';

/** One workspace failure: a stable code and a factual, path-naming message. */
export interface WorkspaceDiagnostic {
  readonly code: WorkspaceDiagnosticCode;
  readonly message: string;
}

/** A resolved workspace: its root and the model read from it, or the failure. */
export type WorkspaceResolution =
  | { readonly ok: true; readonly root: string; readonly model: Model }
  | { readonly ok: false; readonly diagnostic: WorkspaceDiagnostic };

/** The outcome of `initWorkspace`: the new workspace's root, or the failure. */
export type WorkspaceInitResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly diagnostic: WorkspaceDiagnostic };

/** The outcome of `writeWorkspaceModel`: the existing workspace's root, or the failure. */
export type WorkspaceWriteResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly diagnostic: WorkspaceDiagnostic };

/** The walk's outcome: the nearest workspace root, or the resolution failure. */
type WorkspaceRootResult =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly diagnostic: WorkspaceDiagnostic };

/**
 * The model `initWorkspace` writes when the caller supplies none: no tables, sequences, views,
 * or extensions.
 */
const EMPTY_MODEL: Model = { tables: [], sequences: [], views: [], extensions: [] };

/**
 * Resolves the workspace nearest `startPath` and reads its model.
 *
 * Resolution walks lexically from `startPath` to the filesystem root and the first marker
 * found wins — including a corrupt one, which is reported rather than skipped over.
 */
export async function resolveWorkspace(startPath: string): Promise<WorkspaceResolution> {
  const found = await findWorkspaceRoot(startPath);
  if (!found.ok) return found;
  return await readWorkspaceModel(found.root, join(found.root, WORKSPACE_DIR_NAME));
}

/**
 * The walk behind resolution: the workspace root nearest `startPath`, or the same failures.
 *
 * Each candidate's `.schemamill` is inspected, an absent marker moves the walk to `dirname`,
 * and the walk stops at the fixed point (`dirname(dir) === dir`) after checking the filesystem
 * root. The marker is only inspected, never read, so a corrupt or missing model does not stop
 * a caller that intends to write over it.
 */
async function findWorkspaceRoot(startPath: string): Promise<WorkspaceRootResult> {
  const start = resolve(startPath);
  let dir = start;
  for (;;) {
    const marker = join(dir, WORKSPACE_DIR_NAME);
    let stats: Stats;
    try {
      stats = await stat(marker);
    } catch (error) {
      if (isAbsent(error)) {
        const parent = dirname(dir);
        if (parent === dir) {
          return failure('workspace-not-found', `no workspace found from ${start}`);
        }
        dir = parent;
        continue;
      }
      return failure('workspace-inaccessible', `cannot access ${marker}: ${reason(error)}`);
    }
    if (!stats.isDirectory()) {
      return failure('workspace-marker-invalid', `${marker} is not a directory`);
    }
    return { ok: true, root: dir };
  }
}

/**
 * Writes `model` into the existing workspace nearest `startPath` as its canonical model,
 * replacing any previous bytes atomically.
 *
 * The writer never creates a workspace: it creates no marker, no directory, and no workspace,
 * and a start path with no marker above it fails with `workspace-not-found`. The model is
 * serialized with `serializeModel`, written to a uniquely named temp file in the marker
 * directory, and renamed over `model.json`, so a reader sees either the old or the new
 * complete file and a failed write leaves the previous model intact. An existing model that
 * is corrupt or missing is replaced — a write repairs it. Failures stay in the result union;
 * the writer never throws for an fs failure.
 */
export async function writeWorkspaceModel(
  startPath: string,
  model: Model,
): Promise<WorkspaceWriteResult> {
  const found = await findWorkspaceRoot(startPath);
  if (!found.ok) return found;
  const diagnostic = await writeModelFile(join(found.root, WORKSPACE_DIR_NAME), model);
  if (diagnostic !== null) return { ok: false, diagnostic };
  return { ok: true, root: found.root };
}

/**
 * Creates a workspace rooted at `targetPath` holding `model` as its canonical model,
 * defaulting to the empty model.
 *
 * The target is created when absent (recursively). An existing `.schemamill` refuses with a
 * repair hint, and the nearest ancestor holding a `.schemamill` directory refuses nesting —
 * a workspace containing another is allowed, since nearest-wins decides resolution. The
 * marker is claimed with an atomic `mkdir`, so racing inits cannot both win; a crash between
 * the marker and the model leaves a marker without a model, which resolution reports as
 * `workspace-model-missing` and `init` repairs after `remove <target>/.schemamill`. A failed
 * model write removes the marker it just created before reporting.
 */
export async function initWorkspace(
  targetPath: string,
  model: Model = EMPTY_MODEL,
): Promise<WorkspaceInitResult> {
  const target = resolve(targetPath);
  const marker = join(target, WORKSPACE_DIR_NAME);

  let targetStats: Stats | undefined;
  try {
    targetStats = await stat(target);
  } catch (error) {
    if (!isAbsent(error)) {
      return failure('workspace-io', `cannot create ${target}: ${reason(error)}`);
    }
  }
  if (targetStats !== undefined && !targetStats.isDirectory()) {
    return failure('workspace-target-not-directory', `${target} is not a directory`);
  }
  if (targetStats === undefined) {
    try {
      await mkdir(target, { recursive: true });
    } catch (error) {
      return failure('workspace-io', `cannot create ${target}: ${reason(error)}`);
    }
  }

  // A marker entry — a file or a directory — is never overwritten; the hint is the
  // documented repair for the crash window between the marker and the model.
  let markerPresent = false;
  try {
    await stat(marker);
    markerPresent = true;
  } catch (error) {
    if (!isAbsent(error)) {
      return failure('workspace-io', `cannot create ${marker}: ${reason(error)}`);
    }
  }
  if (markerPresent) return alreadyExists(target, marker);

  const ancestor = await findAncestorWorkspace(target);
  if (ancestor !== undefined) {
    return failure(
      'workspace-inside-workspace',
      `${target} is inside the workspace at ${ancestor}`,
    );
  }

  try {
    await mkdir(marker, { recursive: false });
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') return alreadyExists(target, marker);
    return failure('workspace-io', `cannot create ${marker}: ${reason(error)}`);
  }

  const diagnostic = await writeModelFile(marker, model);
  if (diagnostic !== null) {
    try {
      await rm(marker, { recursive: true, force: true });
    } catch {
      // Best effort: the write failure is the diagnostic worth reporting.
    }
    return { ok: false, diagnostic };
  }
  return { ok: true, root: target };
}

/**
 * `model` as the canonical model file text: entities rebuilt in their declaration order with
 * `undefined` optionals omitted, `tables`, `sequences`, `views`, and `extensions` re-sorted into
 * canonical order (schema then name for the first three, name alone for extensions, JavaScript
 * string comparison), nested arrays kept as stored, two-space JSON, and a trailing newline.
 * `views` always follows `sequences`, and `extensions` always follows `views`. Deterministic:
 * one model always serializes to the same bytes.
 *
 * Exported for tests; `writeWorkspaceModel` is the public writer that persists these bytes.
 */
export function serializeModel(model: Model): string {
  const value = {
    tables: [...model.tables].sort(compareNames).map(serializeTable),
    sequences: [...model.sequences].sort(compareNames).map(serializeSequence),
    views: [...model.views].sort(compareNames).map(serializeView),
    extensions: [...model.extensions].sort(compareExtensions).map(serializeExtension),
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Reads and validates `<marker>/model.json`, reporting a path-named failure. */
async function readWorkspaceModel(root: string, marker: string): Promise<WorkspaceResolution> {
  const modelPath = join(marker, WORKSPACE_MODEL_FILE_NAME);
  let text: string;
  try {
    text = await readFile(modelPath, 'utf8');
  } catch (error) {
    if (isAbsent(error)) {
      return failure('workspace-model-missing', `no model file at ${modelPath}`);
    }
    return failure('workspace-model-unreadable', `cannot read ${modelPath}: ${reason(error)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return failure('workspace-model-invalid', `cannot parse ${modelPath}: ${reason(error)}`);
  }

  const parsed = parseModel(payload);
  if (!parsed.ok) {
    return failure('workspace-model-invalid', `invalid model: ${parsed.message}`);
  }
  return { ok: true, root, model: parsed.value };
}

/**
 * Writes `model` as `<marker>/model.json` through a same-directory temp file and an atomic
 * rename, returning the failure or `null`.
 *
 * The temp name is unique per call, so concurrent writers cannot clobber each other's temp
 * file (the last rename wins). A failed write removes only the temp file, never the model
 * path, so the previous model survives a failure.
 */
async function writeModelFile(marker: string, model: Model): Promise<WorkspaceDiagnostic | null> {
  const modelPath = join(marker, WORKSPACE_MODEL_FILE_NAME);
  const tempPath = join(marker, `${WORKSPACE_MODEL_FILE_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, serializeModel(model), 'utf8');
    await rename(tempPath, modelPath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Best effort: the write failure is the diagnostic worth reporting.
    }
    return { code: 'workspace-io', message: `cannot write ${modelPath}: ${reason(error)}` };
  }
  return null;
}

/** The failure arm both workspace results share. */
function failure(
  code: WorkspaceDiagnosticCode,
  message: string,
): { readonly ok: false; readonly diagnostic: WorkspaceDiagnostic } {
  return { ok: false, diagnostic: { code, message } };
}

/** The already-exists failure, whose message names the documented repair. */
function alreadyExists(
  target: string,
  marker: string,
): { readonly ok: false; readonly diagnostic: WorkspaceDiagnostic } {
  return failure(
    'workspace-already-exists',
    `workspace already exists at ${target}: remove ${marker} to re-create it`,
  );
}

/**
 * The nearest ancestor of `target` holding a `.schemamill` directory, or `undefined`. Only
 * ancestors are checked — a workspace may contain another — and a non-directory entry or a
 * stat failure on an ancestor does not block init.
 */
async function findAncestorWorkspace(target: string): Promise<string | undefined> {
  let ancestor = dirname(target);
  for (;;) {
    const marker = join(ancestor, WORKSPACE_DIR_NAME);
    try {
      if ((await stat(marker)).isDirectory()) return ancestor;
    } catch {
      // A marker that cannot be inspected does not make the target nested.
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
}

/** Whether an fs failure says the path does not exist. */
function isAbsent(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** An fs failure's errno code, when the thrown value carries one. */
function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

/** The message of a thrown value, stringified when it is not an `Error`. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Any schema-qualified name: a table, sequence, view, or identity sequence name. */
interface QualifiedName {
  readonly schema: string;
  readonly name: string;
}

/** Tables, sequences, and views in canonical order: schema, then name, plain string comparison. */
function compareNames(left: QualifiedName, right: QualifiedName): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

/** Extensions in canonical order: name alone, plain string comparison. */
function compareExtensions(left: Extension, right: Extension): number {
  return compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A copy of `name` with its fields in declaration order. */
function serializeName(name: QualifiedName): {
  readonly schema: string;
  readonly name: string;
} {
  return { schema: name.schema, name: name.name };
}

function serializeTable(table: Table): object {
  return {
    schema: table.schema,
    name: table.name,
    columns: table.columns.map(serializeColumn),
    ...(table.primaryKey === undefined ? {} : { primaryKey: serializeKey(table.primaryKey) }),
    foreignKeys: table.foreignKeys.map(serializeForeignKey),
    uniqueConstraints: table.uniqueConstraints.map(serializeKey),
    checkConstraints: table.checkConstraints.map(serializeCheckConstraint),
    indexes: table.indexes.map(serializeIndex),
    ...(table.persistence === undefined ? {} : { persistence: table.persistence }),
    ...(table.comment === undefined ? {} : { comment: table.comment }),
  };
}

function serializeColumn(column: Column): object {
  return {
    name: column.name,
    type: column.type,
    notNull: column.notNull,
    ...(column.notNullName === undefined ? {} : { notNullName: column.notNullName }),
    ...(column.default === undefined ? {} : { default: column.default }),
    ...(column.identity === undefined ? {} : { identity: serializeIdentity(column.identity) }),
    ...(column.collation === undefined ? {} : { collation: column.collation }),
    ...(column.storage === undefined ? {} : { storage: column.storage }),
    ...(column.compression === undefined ? {} : { compression: column.compression }),
    ...(column.comment === undefined ? {} : { comment: column.comment }),
  };
}

function serializeIdentity(identity: Identity): object {
  return {
    generated: identity.generated,
    ...(identity.sequenceName === undefined
      ? {}
      : { sequenceName: serializeName(identity.sequenceName) }),
    increment: identity.increment,
    minValue: identity.minValue,
    maxValue: identity.maxValue,
    start: identity.start,
    cache: identity.cache,
    cycle: identity.cycle,
  };
}

/** A primary key or unique constraint: the shared `name?` then `columns` shape. */
function serializeKey(key: PrimaryKey | UniqueConstraint): object {
  return {
    ...(key.name === undefined ? {} : { name: key.name }),
    columns: [...key.columns],
    ...(key.deferrable === undefined ? {} : { deferrable: key.deferrable }),
    ...(key.initiallyDeferred === undefined ? {} : { initiallyDeferred: key.initiallyDeferred }),
    ...(key.comment === undefined ? {} : { comment: key.comment }),
  };
}

function serializeCheckConstraint(checkConstraint: CheckConstraint): object {
  return {
    ...(checkConstraint.name === undefined ? {} : { name: checkConstraint.name }),
    expression: checkConstraint.expression,
    ...(checkConstraint.enforcement === undefined
      ? {}
      : { enforcement: checkConstraint.enforcement }),
    ...(checkConstraint.comment === undefined ? {} : { comment: checkConstraint.comment }),
  };
}

function serializeForeignKey(foreignKey: ForeignKey): object {
  return {
    ...(foreignKey.name === undefined ? {} : { name: foreignKey.name }),
    columns: [...foreignKey.columns],
    referencedTable: serializeName(foreignKey.referencedTable),
    referencedColumns: [...foreignKey.referencedColumns],
    ...(foreignKey.onUpdate === undefined ? {} : { onUpdate: foreignKey.onUpdate }),
    ...(foreignKey.onDelete === undefined ? {} : { onDelete: foreignKey.onDelete }),
    ...(foreignKey.enforcement === undefined ? {} : { enforcement: foreignKey.enforcement }),
    ...(foreignKey.deferrable === undefined ? {} : { deferrable: foreignKey.deferrable }),
    ...(foreignKey.initiallyDeferred === undefined
      ? {}
      : { initiallyDeferred: foreignKey.initiallyDeferred }),
    ...(foreignKey.comment === undefined ? {} : { comment: foreignKey.comment }),
  };
}

function serializeIndex(index: Index): object {
  return {
    ...(index.name === undefined ? {} : { name: index.name }),
    unique: index.unique,
    columns: [...index.columns],
    ...(index.concurrently === undefined ? {} : { concurrently: index.concurrently }),
    ...(index.comment === undefined ? {} : { comment: index.comment }),
  };
}

function serializeSequence(sequence: Sequence): object {
  return {
    schema: sequence.schema,
    name: sequence.name,
    dataType: sequence.dataType,
    increment: sequence.increment,
    minValue: sequence.minValue,
    maxValue: sequence.maxValue,
    start: sequence.start,
    cache: sequence.cache,
    cycle: sequence.cycle,
    ...(sequence.ownedBy === undefined ? {} : { ownedBy: serializeOwner(sequence.ownedBy) }),
    ...(sequence.comment === undefined ? {} : { comment: sequence.comment }),
  };
}

function serializeOwner(owner: SequenceOwner): object {
  return { table: serializeName(owner.table), column: owner.column };
}

function serializeView(view: View): object {
  return {
    schema: view.schema,
    name: view.name,
    materialized: view.materialized,
    definition: view.definition,
    ...(view.checkOption === undefined ? {} : { checkOption: view.checkOption }),
    ...(view.comment === undefined ? {} : { comment: view.comment }),
  };
}

function serializeExtension(extension: Extension): object {
  return {
    schema: extension.schema,
    name: extension.name,
    ...(extension.comment === undefined ? {} : { comment: extension.comment }),
  };
}

/**
 * The reader's shape check result: the rebuilt value, or the first failing path-named
 * message.
 */
type Parsed<T> = { readonly ok: true; readonly value: T } | ParseFailure;

interface ParseFailure {
  readonly ok: false;
  readonly message: string;
}

function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function invalid(message: string): ParseFailure {
  return { ok: false, message };
}

const MODEL_KEYS = ['tables', 'sequences', 'views', 'extensions'] as const;
const TABLE_KEYS = [
  'schema',
  'name',
  'columns',
  'primaryKey',
  'foreignKeys',
  'uniqueConstraints',
  'checkConstraints',
  'indexes',
  'persistence',
  'comment',
] as const;
const COLUMN_KEYS = [
  'name',
  'type',
  'notNull',
  'notNullName',
  'default',
  'identity',
  'collation',
  'storage',
  'compression',
  'comment',
] as const;
const IDENTITY_KEYS = [
  'generated',
  'sequenceName',
  'increment',
  'minValue',
  'maxValue',
  'start',
  'cache',
  'cycle',
] as const;
const KEY_KEYS = ['name', 'columns', 'deferrable', 'initiallyDeferred', 'comment'] as const;
const CHECK_CONSTRAINT_KEYS = ['name', 'expression', 'enforcement', 'comment'] as const;
const FOREIGN_KEY_KEYS = [
  'name',
  'columns',
  'referencedTable',
  'referencedColumns',
  'onUpdate',
  'onDelete',
  'enforcement',
  'deferrable',
  'initiallyDeferred',
  'comment',
] as const;
const INDEX_KEYS = ['name', 'unique', 'columns', 'concurrently', 'comment'] as const;
const SEQUENCE_KEYS = [
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
] as const;
const OWNER_KEYS = ['table', 'column'] as const;
const VIEW_KEYS = [
  'schema',
  'name',
  'materialized',
  'definition',
  'checkOption',
  'comment',
] as const;
const EXTENSION_KEYS = ['schema', 'name', 'comment'] as const;
const NAME_KEYS = ['schema', 'name'] as const;

const REFERENTIAL_ACTIONS: readonly ReferentialAction[] = [
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
];
const CONSTRAINT_ENFORCEMENTS: readonly ConstraintEnforcement[] = ['not-valid', 'not-enforced'];
const SEQUENCE_DATA_TYPES: readonly SequenceDataType[] = ['smallint', 'integer', 'bigint'];
const IDENTITY_GENERATIONS: readonly IdentityGeneration[] = ['always', 'by default'];
const TABLE_PERSISTENCES: readonly TablePersistence[] = ['unlogged'];
const VIEW_CHECK_OPTIONS: readonly ViewCheckOption[] = ['local', 'cascaded'];
const COLUMN_STORAGES: readonly ColumnStorage[] = ['plain', 'external', 'extended', 'main'];
const COLUMN_COMPRESSIONS: readonly ColumnCompression[] = ['pglz', 'lz4'];

/** Canonical integer string form: optional minus, no leading zeros, `-0` excluded. */
const CANONICAL_INTEGER = /^(0|-?[1-9][0-9]*)$/;

/** Positive canonical integer string form, for `cache`. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * Validates a parsed payload against the canonical model, rebuilds it by picking known
 * fields, and fails closed on unknown keys at every level. The first failure wins, named by
 * its JSON path (e.g. `tables[2].columns[0].type`).
 */
function parseModel(value: unknown): Parsed<Model> {
  return parseObject(value, '', MODEL_KEYS, (object) => {
    const tables = parseArrayOf(object.tables, 'tables', parseTable);
    if (!tables.ok) return tables;
    const sequences = parseArrayOf(object.sequences, 'sequences', parseSequence);
    if (!sequences.ok) return sequences;
    // Older model files have no views section: an absent `views` is no views, while an explicit
    // `null` or non-array still fails closed.
    const views =
      object.views === undefined
        ? parsed<View[]>([])
        : parseArrayOf(object.views, 'views', parseView);
    if (!views.ok) return views;
    // Older model files have no extensions section either: absent means none, while an explicit
    // `null` or non-array still fails closed.
    const extensions =
      object.extensions === undefined
        ? parsed<Extension[]>([])
        : parseArrayOf(object.extensions, 'extensions', parseExtension);
    if (!extensions.ok) return extensions;
    return parsed({
      tables: tables.value,
      sequences: sequences.value,
      views: views.value,
      extensions: extensions.value,
    });
  });
}

/**
 * Checks `value` is an object, rejects unknown keys, and hands the object to `parse`. The
 * empty `path` is the model itself, named as `the model` when it is not an object.
 */
function parseObject<T>(
  value: unknown,
  path: string,
  keys: readonly string[],
  parse: (object: Record<string, unknown>, path: string) => Parsed<T>,
): Parsed<T> {
  if (!isRecord(value)) return invalid(`${subject(path)} is not an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) return invalid(`unknown field ${fieldPath(path, key)}`);
  }
  return parse(value, path);
}

function parseArrayOf<T>(
  value: unknown,
  path: string,
  parseElement: (value: unknown, path: string) => Parsed<T>,
): Parsed<T[]> {
  if (!Array.isArray(value)) return invalid(`${path} is not an array`);
  const elements: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const element = parseElement(value[index], `${path}[${index}]`);
    if (!element.ok) return element;
    elements.push(element.value);
  }
  return parsed(elements);
}

function parseString(value: unknown, path: string): Parsed<string> {
  if (typeof value !== 'string') return invalid(`${path} is not a string`);
  return parsed(value);
}

/** A non-empty string; an empty collation can never name a collation. */
function parseNonEmptyString(value: unknown, path: string): Parsed<string> {
  const string = parseString(value, path);
  if (!string.ok) return string;
  if (string.value === '') return invalid(`${path} is not a non-empty string`);
  return string;
}

/** An entity comment: non-empty, and never carrying a NUL PostgreSQL text cannot hold. */
function parseComment(value: unknown, path: string): Parsed<string> {
  const string = parseNonEmptyString(value, path);
  if (!string.ok) return string;
  if (string.value.includes('\u0000')) {
    return invalid(`${path} must not contain a NUL character`);
  }
  return string;
}

function parseBoolean(value: unknown, path: string): Parsed<boolean> {
  if (typeof value !== 'boolean') return invalid(`${path} is not a boolean`);
  return parsed(value);
}

function parseStringArray(value: unknown, path: string): Parsed<string[]> {
  return parseArrayOf(value, path, parseString);
}

/** An exact 64-bit integer in canonical decimal form. */
function parseInteger(value: unknown, path: string): Parsed<string> {
  const string = parseString(value, path);
  if (!string.ok) return string;
  if (!CANONICAL_INTEGER.test(string.value)) {
    return invalid(`${path} is not a canonical integer string`);
  }
  return string;
}

/** A positive exact integer in canonical decimal form, for `cache`. */
function parsePositiveInteger(value: unknown, path: string): Parsed<string> {
  const string = parseString(value, path);
  if (!string.ok) return string;
  if (!POSITIVE_INTEGER.test(string.value)) {
    return invalid(`${path} is not a positive canonical integer string`);
  }
  return string;
}

function parseEnum<T extends string>(
  value: unknown,
  path: string,
  members: readonly T[],
  label: string,
): Parsed<T> {
  const string = parseString(value, path);
  if (!string.ok) return string;
  for (const member of members) {
    if (member === string.value) return parsed(member);
  }
  return invalid(`${path} is not a valid ${label}`);
}

function parseOptional<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => Parsed<T>,
): Parsed<T | undefined> {
  if (value === undefined) return parsed(undefined);
  return parse(value, path);
}

function parseTable(value: unknown, path: string): Parsed<Table> {
  return parseObject(value, path, TABLE_KEYS, (object) => {
    const schema = parseString(object.schema, fieldPath(path, 'schema'));
    if (!schema.ok) return schema;
    const name = parseString(object.name, fieldPath(path, 'name'));
    if (!name.ok) return name;
    const columns = parseArrayOf(object.columns, fieldPath(path, 'columns'), parseColumn);
    if (!columns.ok) return columns;
    const primaryKey = parseOptional(object.primaryKey, fieldPath(path, 'primaryKey'), parseKey);
    if (!primaryKey.ok) return primaryKey;
    const foreignKeys = parseArrayOf(
      object.foreignKeys,
      fieldPath(path, 'foreignKeys'),
      parseForeignKey,
    );
    if (!foreignKeys.ok) return foreignKeys;
    const uniqueConstraints = parseArrayOf(
      object.uniqueConstraints,
      fieldPath(path, 'uniqueConstraints'),
      parseKey,
    );
    if (!uniqueConstraints.ok) return uniqueConstraints;
    const checkConstraints = parseArrayOf(
      object.checkConstraints,
      fieldPath(path, 'checkConstraints'),
      parseCheckConstraint,
    );
    if (!checkConstraints.ok) return checkConstraints;
    const indexes = parseArrayOf(object.indexes, fieldPath(path, 'indexes'), parseIndex);
    if (!indexes.ok) return indexes;
    const persistence = parseOptional(
      object.persistence,
      fieldPath(path, 'persistence'),
      parseTablePersistence,
    );
    if (!persistence.ok) return persistence;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      schema: schema.value,
      name: name.value,
      columns: columns.value,
      ...(primaryKey.value === undefined ? {} : { primaryKey: primaryKey.value }),
      foreignKeys: foreignKeys.value,
      uniqueConstraints: uniqueConstraints.value,
      checkConstraints: checkConstraints.value,
      indexes: indexes.value,
      ...(persistence.value === undefined ? {} : { persistence: persistence.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseColumn(value: unknown, path: string): Parsed<Column> {
  return parseObject(value, path, COLUMN_KEYS, (object) => {
    const name = parseString(object.name, fieldPath(path, 'name'));
    if (!name.ok) return name;
    const type = parseString(object.type, fieldPath(path, 'type'));
    if (!type.ok) return type;
    const notNull = parseBoolean(object.notNull, fieldPath(path, 'notNull'));
    if (!notNull.ok) return notNull;
    const notNullName = parseOptional(
      object.notNullName,
      fieldPath(path, 'notNullName'),
      parseString,
    );
    if (!notNullName.ok) return notNullName;
    if (notNullName.value !== undefined && notNull.value !== true) {
      return invalid(`${fieldPath(path, 'notNullName')} is only valid on a NOT NULL column`);
    }
    const defaultValue = parseOptional(object.default, fieldPath(path, 'default'), parseString);
    if (!defaultValue.ok) return defaultValue;
    const identity = parseOptional(object.identity, fieldPath(path, 'identity'), parseIdentity);
    if (!identity.ok) return identity;
    const collation = parseOptional(
      object.collation,
      fieldPath(path, 'collation'),
      parseNonEmptyString,
    );
    if (!collation.ok) return collation;
    const storage = parseOptional(object.storage, fieldPath(path, 'storage'), parseColumnStorage);
    if (!storage.ok) return storage;
    const compression = parseOptional(
      object.compression,
      fieldPath(path, 'compression'),
      parseColumnCompression,
    );
    if (!compression.ok) return compression;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      name: name.value,
      type: type.value,
      notNull: notNull.value,
      ...(notNullName.value === undefined ? {} : { notNullName: notNullName.value }),
      ...(defaultValue.value === undefined ? {} : { default: defaultValue.value }),
      ...(identity.value === undefined ? {} : { identity: identity.value }),
      ...(collation.value === undefined ? {} : { collation: collation.value }),
      ...(storage.value === undefined ? {} : { storage: storage.value }),
      ...(compression.value === undefined ? {} : { compression: compression.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

/** Fail-closed parsers for the attribute and persistence unions. */
function parseTablePersistence(value: unknown, path: string): Parsed<TablePersistence> {
  return parseEnum(value, path, TABLE_PERSISTENCES, 'table persistence');
}

function parseColumnStorage(value: unknown, path: string): Parsed<ColumnStorage> {
  return parseEnum(value, path, COLUMN_STORAGES, 'column storage');
}

function parseColumnCompression(value: unknown, path: string): Parsed<ColumnCompression> {
  return parseEnum(value, path, COLUMN_COMPRESSIONS, 'column compression');
}

function parseIdentity(value: unknown, path: string): Parsed<Identity> {
  return parseObject(value, path, IDENTITY_KEYS, (object) => {
    const generated = parseEnum(
      object.generated,
      fieldPath(path, 'generated'),
      IDENTITY_GENERATIONS,
      'identity generation',
    );
    if (!generated.ok) return generated;
    const sequenceName = parseOptional(
      object.sequenceName,
      fieldPath(path, 'sequenceName'),
      parseName,
    );
    if (!sequenceName.ok) return sequenceName;
    const increment = parseInteger(object.increment, fieldPath(path, 'increment'));
    if (!increment.ok) return increment;
    const minValue = parseInteger(object.minValue, fieldPath(path, 'minValue'));
    if (!minValue.ok) return minValue;
    const maxValue = parseInteger(object.maxValue, fieldPath(path, 'maxValue'));
    if (!maxValue.ok) return maxValue;
    const start = parseInteger(object.start, fieldPath(path, 'start'));
    if (!start.ok) return start;
    const cache = parsePositiveInteger(object.cache, fieldPath(path, 'cache'));
    if (!cache.ok) return cache;
    const cycle = parseBoolean(object.cycle, fieldPath(path, 'cycle'));
    if (!cycle.ok) return cycle;
    return parsed({
      generated: generated.value,
      ...(sequenceName.value === undefined ? {} : { sequenceName: sequenceName.value }),
      increment: increment.value,
      minValue: minValue.value,
      maxValue: maxValue.value,
      start: start.value,
      cache: cache.value,
      cycle: cycle.value,
    });
  });
}

/** A primary key or unique constraint; their shapes are identical. */
function parseKey(value: unknown, path: string): Parsed<PrimaryKey> {
  return parseObject(value, path, KEY_KEYS, (object) => {
    const name = parseOptional(object.name, fieldPath(path, 'name'), parseString);
    if (!name.ok) return name;
    const columns = parseStringArray(object.columns, fieldPath(path, 'columns'));
    if (!columns.ok) return columns;
    const deferrable = parseOptional(
      object.deferrable,
      fieldPath(path, 'deferrable'),
      parseBoolean,
    );
    if (!deferrable.ok) return deferrable;
    const initiallyDeferred = parseOptional(
      object.initiallyDeferred,
      fieldPath(path, 'initiallyDeferred'),
      parseBoolean,
    );
    if (!initiallyDeferred.ok) return initiallyDeferred;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      ...(name.value === undefined ? {} : { name: name.value }),
      columns: columns.value,
      ...(deferrable.value === undefined ? {} : { deferrable: deferrable.value }),
      ...(initiallyDeferred.value === undefined
        ? {}
        : { initiallyDeferred: initiallyDeferred.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseCheckConstraint(value: unknown, path: string): Parsed<CheckConstraint> {
  return parseObject(value, path, CHECK_CONSTRAINT_KEYS, (object) => {
    const name = parseOptional(object.name, fieldPath(path, 'name'), parseString);
    if (!name.ok) return name;
    const expression = parseString(object.expression, fieldPath(path, 'expression'));
    if (!expression.ok) return expression;
    const enforcement = parseOptional(
      object.enforcement,
      fieldPath(path, 'enforcement'),
      parseConstraintEnforcement,
    );
    if (!enforcement.ok) return enforcement;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      ...(name.value === undefined ? {} : { name: name.value }),
      expression: expression.value,
      ...(enforcement.value === undefined ? {} : { enforcement: enforcement.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseForeignKey(value: unknown, path: string): Parsed<ForeignKey> {
  return parseObject(value, path, FOREIGN_KEY_KEYS, (object) => {
    const name = parseOptional(object.name, fieldPath(path, 'name'), parseString);
    if (!name.ok) return name;
    const columns = parseStringArray(object.columns, fieldPath(path, 'columns'));
    if (!columns.ok) return columns;
    const referencedTable = parseName(object.referencedTable, fieldPath(path, 'referencedTable'));
    if (!referencedTable.ok) return referencedTable;
    const referencedColumns = parseStringArray(
      object.referencedColumns,
      fieldPath(path, 'referencedColumns'),
    );
    if (!referencedColumns.ok) return referencedColumns;
    const onUpdate = parseOptional(
      object.onUpdate,
      fieldPath(path, 'onUpdate'),
      parseReferentialAction,
    );
    if (!onUpdate.ok) return onUpdate;
    const onDelete = parseOptional(
      object.onDelete,
      fieldPath(path, 'onDelete'),
      parseReferentialAction,
    );
    if (!onDelete.ok) return onDelete;
    const enforcement = parseOptional(
      object.enforcement,
      fieldPath(path, 'enforcement'),
      parseConstraintEnforcement,
    );
    if (!enforcement.ok) return enforcement;
    const deferrable = parseOptional(
      object.deferrable,
      fieldPath(path, 'deferrable'),
      parseBoolean,
    );
    if (!deferrable.ok) return deferrable;
    const initiallyDeferred = parseOptional(
      object.initiallyDeferred,
      fieldPath(path, 'initiallyDeferred'),
      parseBoolean,
    );
    if (!initiallyDeferred.ok) return initiallyDeferred;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      ...(name.value === undefined ? {} : { name: name.value }),
      columns: columns.value,
      referencedTable: referencedTable.value,
      referencedColumns: referencedColumns.value,
      ...(onUpdate.value === undefined ? {} : { onUpdate: onUpdate.value }),
      ...(onDelete.value === undefined ? {} : { onDelete: onDelete.value }),
      ...(enforcement.value === undefined ? {} : { enforcement: enforcement.value }),
      ...(deferrable.value === undefined ? {} : { deferrable: deferrable.value }),
      ...(initiallyDeferred.value === undefined
        ? {}
        : { initiallyDeferred: initiallyDeferred.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseReferentialAction(value: unknown, path: string): Parsed<ReferentialAction> {
  return parseEnum(value, path, REFERENTIAL_ACTIONS, 'referential action');
}

function parseConstraintEnforcement(value: unknown, path: string): Parsed<ConstraintEnforcement> {
  return parseEnum(value, path, CONSTRAINT_ENFORCEMENTS, 'constraint enforcement');
}

function parseIndex(value: unknown, path: string): Parsed<Index> {
  return parseObject(value, path, INDEX_KEYS, (object) => {
    const name = parseOptional(object.name, fieldPath(path, 'name'), parseString);
    if (!name.ok) return name;
    const unique = parseBoolean(object.unique, fieldPath(path, 'unique'));
    if (!unique.ok) return unique;
    const columns = parseStringArray(object.columns, fieldPath(path, 'columns'));
    if (!columns.ok) return columns;
    const concurrently = parseOptional(
      object.concurrently,
      fieldPath(path, 'concurrently'),
      parseBoolean,
    );
    if (!concurrently.ok) return concurrently;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      ...(name.value === undefined ? {} : { name: name.value }),
      unique: unique.value,
      columns: columns.value,
      ...(concurrently.value === undefined ? {} : { concurrently: concurrently.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseSequence(value: unknown, path: string): Parsed<Sequence> {
  return parseObject(value, path, SEQUENCE_KEYS, (object) => {
    const schema = parseString(object.schema, fieldPath(path, 'schema'));
    if (!schema.ok) return schema;
    const name = parseString(object.name, fieldPath(path, 'name'));
    if (!name.ok) return name;
    const dataType = parseEnum(
      object.dataType,
      fieldPath(path, 'dataType'),
      SEQUENCE_DATA_TYPES,
      'sequence data type',
    );
    if (!dataType.ok) return dataType;
    const increment = parseInteger(object.increment, fieldPath(path, 'increment'));
    if (!increment.ok) return increment;
    const minValue = parseInteger(object.minValue, fieldPath(path, 'minValue'));
    if (!minValue.ok) return minValue;
    const maxValue = parseInteger(object.maxValue, fieldPath(path, 'maxValue'));
    if (!maxValue.ok) return maxValue;
    const start = parseInteger(object.start, fieldPath(path, 'start'));
    if (!start.ok) return start;
    const cache = parsePositiveInteger(object.cache, fieldPath(path, 'cache'));
    if (!cache.ok) return cache;
    const cycle = parseBoolean(object.cycle, fieldPath(path, 'cycle'));
    if (!cycle.ok) return cycle;
    const ownedBy = parseOptional(object.ownedBy, fieldPath(path, 'ownedBy'), parseOwner);
    if (!ownedBy.ok) return ownedBy;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      schema: schema.value,
      name: name.value,
      dataType: dataType.value,
      increment: increment.value,
      minValue: minValue.value,
      maxValue: maxValue.value,
      start: start.value,
      cache: cache.value,
      cycle: cycle.value,
      ...(ownedBy.value === undefined ? {} : { ownedBy: ownedBy.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseOwner(value: unknown, path: string): Parsed<SequenceOwner> {
  return parseObject(value, path, OWNER_KEYS, (object) => {
    const table = parseName(object.table, fieldPath(path, 'table'));
    if (!table.ok) return table;
    const column = parseString(object.column, fieldPath(path, 'column'));
    if (!column.ok) return column;
    return parsed({ table: table.value, column: column.value });
  });
}

/**
 * A view or materialized view: the identity, the `materialized` discriminator, the opaque
 * definition, and the optional check option. A materialized view cannot carry a check option,
 * so the pair fails closed rather than reaching a plan that would drop it silently.
 */
function parseView(value: unknown, path: string): Parsed<View> {
  return parseObject(value, path, VIEW_KEYS, (object) => {
    const schema = parseString(object.schema, fieldPath(path, 'schema'));
    if (!schema.ok) return schema;
    const name = parseString(object.name, fieldPath(path, 'name'));
    if (!name.ok) return name;
    const materialized = parseBoolean(object.materialized, fieldPath(path, 'materialized'));
    if (!materialized.ok) return materialized;
    const definition = parseString(object.definition, fieldPath(path, 'definition'));
    if (!definition.ok) return definition;
    const checkOption = parseOptional(
      object.checkOption,
      fieldPath(path, 'checkOption'),
      parseViewCheckOption,
    );
    if (!checkOption.ok) return checkOption;
    if (checkOption.value !== undefined && materialized.value) {
      return invalid(`${fieldPath(path, 'checkOption')} is not valid on a materialized view`);
    }
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      schema: schema.value,
      name: name.value,
      materialized: materialized.value,
      definition: definition.value,
      ...(checkOption.value === undefined ? {} : { checkOption: checkOption.value }),
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

function parseViewCheckOption(value: unknown, path: string): Parsed<ViewCheckOption> {
  return parseEnum(value, path, VIEW_CHECK_OPTIONS, 'view check option');
}

/**
 * An extension: a database-unique name, the schema it is installed in, and an optional comment.
 * The name stands alone — it is never schema-qualified — while the schema is a required
 * attribute, so both are non-empty and the comment follows the entity-comment contract.
 */
function parseExtension(value: unknown, path: string): Parsed<Extension> {
  return parseObject(value, path, EXTENSION_KEYS, (object) => {
    const schema = parseNonEmptyString(object.schema, fieldPath(path, 'schema'));
    if (!schema.ok) return schema;
    const name = parseNonEmptyString(object.name, fieldPath(path, 'name'));
    if (!name.ok) return name;
    const comment = parseOptional(object.comment, fieldPath(path, 'comment'), parseComment);
    if (!comment.ok) return comment;
    return parsed({
      schema: schema.value,
      name: name.value,
      ...(comment.value === undefined ? {} : { comment: comment.value }),
    });
  });
}

/**
 * A schema-qualified name. Table identities, sequence identities, and identity sequence
 * names are structurally identical, so one parser serves all three.
 */
function parseName(value: unknown, path: string): Parsed<TableIdentity> {
  return parseObject(value, path, NAME_KEYS, (object) => {
    const schema = parseString(object.schema, fieldPath(path, 'schema'));
    if (!schema.ok) return schema;
    const name = parseString(object.name, fieldPath(path, 'name'));
    if (!name.ok) return name;
    return parsed({ schema: schema.value, name: name.value });
  });
}

/** The JSON path of `key` under `path`; at the root, just `key`. */
function fieldPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** How to name `path` in a message; the root path stands for the model itself. */
function subject(path: string): string {
  return path === '' ? 'the model' : path;
}

/** Whether `value` is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
