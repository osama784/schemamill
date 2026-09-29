import type { Sequence, SequenceDataType, SequenceIdentity, SequenceOwner } from './model.ts';

/**
 * Sequence option normalization: raw options, as an import or a hand-built model may carry
 * them, to the effective values PostgreSQL would use.
 *
 * A sequence option is "effective" when every default is resolved: the data type defaults to
 * `bigint`; `INCREMENT BY` to `1`; `CACHE` to `1`; `CYCLE` to off. The remaining defaults
 * depend on the increment's sign. Ascending (`increment > 0`): `MINVALUE` defaults to `1`,
 * `MAXVALUE` to the type's maximum. Descending: `MINVALUE` defaults to the type's minimum,
 * `MAXVALUE` to `-1`. `START WITH` defaults to `MINVALUE` when ascending and to `MAXVALUE`
 * when descending. Omitting an option, `NO MINVALUE`, and `NO MAXVALUE` all mean the engine
 * default, so an omitted option and one stated explicitly normalize to the same sequence.
 *
 * Every value is an exact 64-bit integer in canonical decimal form (see `Sequence`): the
 * helpers here compare and canonicalize with `bigint`, never JavaScript `number`, because the
 * type bounds exceed `Number.MAX_SAFE_INTEGER`. `sequenceTypeChange` holds the engine's `AS`
 * bound reset — a bound equal to the old type's bound becomes the new type's — shared by
 * import and diff.
 *
 * This module holds the normalization rules in one place: import calls `effectiveSequence` to
 * build a `Sequence`, and `diff` calls it to compare on effective values. Normalizing an
 * already-effective sequence is the identity (apart from copies).
 */

/** The inclusive bounds of a sequence's data type, as canonical decimal strings. */
export interface SequenceTypeBounds {
  /** The smallest value the type can hold. */
  readonly minValue: string;
  /** The largest value the type can hold. */
  readonly maxValue: string;
}

const TYPE_BOUNDS: Readonly<Record<SequenceDataType, SequenceTypeBounds>> = {
  smallint: { minValue: '-32768', maxValue: '32767' },
  integer: { minValue: '-2147483648', maxValue: '2147483647' },
  bigint: { minValue: '-9223372036854775808', maxValue: '9223372036854775807' },
};

/** The smallest and largest values `dataType` can hold. */
export function sequenceTypeBounds(dataType: SequenceDataType): SequenceTypeBounds {
  return TYPE_BOUNDS[dataType];
}

/** The effective `MINVALUE` an omitted or `NO MINVALUE` option resolves to. */
export function defaultSequenceMin(dataType: SequenceDataType, increment: string): string {
  return isAscending(increment) ? '1' : sequenceTypeBounds(dataType).minValue;
}

/** The effective `MAXVALUE` an omitted or `NO MAXVALUE` option resolves to. */
export function defaultSequenceMax(dataType: SequenceDataType, increment: string): string {
  return isAscending(increment) ? sequenceTypeBounds(dataType).maxValue : '-1';
}

/** What the engine's `AS` data type change does to a sequence's `MINVALUE` and `MAXVALUE`. */
export interface SequenceTypeChange {
  /** The `MINVALUE` after the change: the old type's minimum becomes the new type's. */
  readonly minValue: string;
  /** The `MAXVALUE` after the change: the old type's maximum becomes the new type's. */
  readonly maxValue: string;
  /** Whether `minValue` was exactly the old type's minimum and so was rewritten. */
  readonly resetMin: boolean;
  /** Whether `maxValue` was exactly the old type's maximum and so was rewritten. */
  readonly resetMax: boolean;
}

/**
 * The bounds an `AS` change from `dataType` to `newDataType` leaves: the engine rewrites a
 * bound exactly equal to the old type's bound to the new type's, and keeps every other bound.
 * The flags report the rewrites, which the engine remembers, so a `NO MINVALUE`/`NO MAXVALUE`
 * later in the same change takes the new type's bound rather than the direction-dependent
 * default.
 */
export function sequenceTypeChange(
  dataType: SequenceDataType,
  minValue: string,
  maxValue: string,
  newDataType: SequenceDataType,
): SequenceTypeChange {
  const oldBounds = sequenceTypeBounds(dataType);
  const newBounds = sequenceTypeBounds(newDataType);
  const resetMin = minValue === oldBounds.minValue;
  const resetMax = maxValue === oldBounds.maxValue;
  return {
    minValue: resetMin ? newBounds.minValue : minValue,
    maxValue: resetMax ? newBounds.maxValue : maxValue,
    resetMin,
    resetMax,
  };
}

/**
 * Sequence options as a source or a caller may state them, before normalization. Every field
 * is optional: an omitted field means the engine default, exactly like an explicit
 * `NO MINVALUE` or `NO MAXVALUE`. Values are canonical decimal strings.
 */
export interface SequenceOptions {
  /** The `AS` type; `bigint` when omitted. */
  readonly dataType?: SequenceDataType;
  /** The `INCREMENT BY` step; `1` when omitted. */
  readonly increment?: string;
  /** The `MINVALUE`; direction-dependent when omitted. */
  readonly minValue?: string;
  /** The `MAXVALUE`; direction-dependent when omitted. */
  readonly maxValue?: string;
  /** The `START WITH` value; `MINVALUE`/`MAXVALUE` by direction when omitted. */
  readonly start?: string;
  /** The `CACHE` size; `1` when omitted. */
  readonly cache?: string;
  /** Whether the sequence wraps with `CYCLE`; off when omitted. */
  readonly cycle?: boolean;
  /** The owning table and column, when the source states one. */
  readonly ownedBy?: SequenceOwner;
}

/** A sequence identity plus as-stated options: what `effectiveSequence` accepts. */
export type SequenceInput = SequenceIdentity & SequenceOptions;

/**
 * Resolves `input`'s options to effective values. Numeric strings are canonicalized with
 * `bigint` (`'+1'`, `'01'`, and `'1'` all normalize to `'1'`); an absent option takes its
 * engine default; a present option wins, so normalization is idempotent. The returned
 * sequence is an independent copy: mutating it never affects `input`, and `input` is never
 * mutated.
 */
export function effectiveSequence(input: SequenceInput): Sequence {
  const dataType = input.dataType ?? 'bigint';
  const increment = canonical(input.increment ?? '1');
  const minValue = canonical(input.minValue ?? defaultSequenceMin(dataType, increment));
  const maxValue = canonical(input.maxValue ?? defaultSequenceMax(dataType, increment));
  const start = canonical(input.start ?? (isAscending(increment) ? minValue : maxValue));
  const cache = canonical(input.cache ?? '1');
  const cycle = input.cycle ?? false;

  return {
    schema: input.schema,
    name: input.name,
    dataType,
    increment,
    minValue,
    maxValue,
    start,
    cache,
    cycle,
    ...(input.ownedBy === undefined ? {} : { ownedBy: copyOwner(input.ownedBy) }),
  };
}

/** Whether the exact `increment` advances toward increasing values. */
function isAscending(increment: string): boolean {
  return BigInt(increment) > 0n;
}

/** `value` in canonical decimal form: an optional minus followed by digits, no leading zeros. */
function canonical(value: string): string {
  return BigInt(value).toString();
}

/** A copy of `owner`, independent of the caller's payload. */
function copyOwner(owner: SequenceOwner): SequenceOwner {
  return { table: { schema: owner.table.schema, name: owner.table.name }, column: owner.column };
}
