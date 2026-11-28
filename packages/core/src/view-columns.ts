import type { ViewOutputColumn } from './model.ts';

/**
 * The plan-time preflight for `CREATE OR REPLACE VIEW`. PostgreSQL requires the same names and
 * types for the existing output columns, in the same order; only trailing columns may be added.
 *
 * A side is **verifiable** only when it is present, non-empty, and every entry carries both a
 * name and a canonical non-empty type. A catalog list is verifiable; a dump-derived list with
 * `type: ''` is not. Either side absent or unverifiable yields `compatible`: a rename or retype
 * visible only from a dump cannot be preflighted, and PostgreSQL still validates the replace
 * atomically at apply time. A destructive drop+create needs positive evidence from two
 * verifiable sides.
 */
export type ViewColumnIncompatibility =
  | { readonly kind: 'compatible' }
  | {
      readonly kind: 'renamed' | 'dropped' | 'reordered' | 'retyped';
      /** The existing column the diagnostic names. */
      readonly column: string;
      /** A short human phrase completing `incompatible: <column> <reason>`. */
      readonly reason: string;
    };

/** Canonical type text: trimmed, whitespace-collapsed, and lowercased. */
export function canonicalViewType(type: string): string {
  return type.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Whether every entry carries a name and a canonical non-empty type. */
export function viewColumnsVerifiable(columns: readonly ViewOutputColumn[] | undefined): boolean {
  if (columns === undefined || columns.length === 0) return false;
  return columns.every(
    (column) => column.name.trim() !== '' && canonicalViewType(column.type) !== '',
  );
}

/** Whether two lists state the same names, in the same order, with the same canonical types. */
export function sameViewColumns(
  before: readonly ViewOutputColumn[] | undefined,
  after: readonly ViewOutputColumn[] | undefined,
): boolean {
  const left = before === undefined || before.length === 0 ? undefined : before;
  const right = after === undefined || after.length === 0 ? undefined : after;
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.name !== b.name || canonicalViewType(a.type) !== canonicalViewType(b.type)) return false;
  }
  return true;
}

/** The first `before` name that no `after` entry carries, if any. */
const missingName = (
  before: readonly ViewOutputColumn[],
  after: readonly ViewOutputColumn[],
): string | undefined => {
  const names = new Set(after.map((column) => column.name));
  return before.find((column) => !names.has(column.name))?.name;
};

/** Where `name` sits in `columns`, or `-1`. */
const positionOf = (columns: readonly ViewOutputColumn[], name: string): number =>
  columns.findIndex((column) => column.name === name);

/**
 * The single compatibility rule. `compatible` keeps `CREATE OR REPLACE`; any other kind is
 * positive evidence to drop and recreate. Appending trailing columns is compatible.
 */
export function viewColumnIncompatibility(
  before: readonly ViewOutputColumn[] | undefined,
  after: readonly ViewOutputColumn[] | undefined,
): ViewColumnIncompatibility {
  if (!viewColumnsVerifiable(before) || !viewColumnsVerifiable(after))
    return { kind: 'compatible' };
  const existing = before!;
  const target = after!;

  // A shorter target whose names are all already present states a pure drop, even when the
  // surviving columns shift left. A rename instead introduces a name the baseline lacks.
  if (target.length < existing.length && missingName(target, existing) === undefined) {
    const dropped = missingName(existing, target);
    if (dropped !== undefined) return { kind: 'dropped', column: dropped, reason: 'dropped' };
  }

  const prefix = Math.min(existing.length, target.length);
  for (let index = 0; index < prefix; index += 1) {
    const oldColumn = existing[index]!;
    const newColumn = target[index]!;
    if (oldColumn.name !== newColumn.name) {
      const movedForward = positionOf(existing, newColumn.name);
      if (movedForward > index) {
        return {
          kind: 'reordered',
          column: newColumn.name,
          reason: `reordered from position ${movedForward + 1} to ${index + 1}`,
        };
      }
      const movedBack = positionOf(target, oldColumn.name);
      if (movedBack > index) {
        return {
          kind: 'reordered',
          column: oldColumn.name,
          reason: `reordered from position ${index + 1} to ${movedBack + 1}`,
        };
      }
      return {
        kind: 'renamed',
        column: oldColumn.name,
        reason: `renamed to ${newColumn.name}`,
      };
    }
    if (canonicalViewType(oldColumn.type) !== canonicalViewType(newColumn.type)) {
      return {
        kind: 'retyped',
        column: oldColumn.name,
        reason: `retyped from ${oldColumn.type} to ${newColumn.type}`,
      };
    }
  }

  if (existing.length > target.length) {
    const dropped = missingName(existing, target);
    if (dropped !== undefined) return { kind: 'dropped', column: dropped, reason: 'dropped' };
  }
  return { kind: 'compatible' };
}
