import { canonicalIntType, sequenceTypeBounds } from '@schemamill/core';
import type {
  Column,
  Hazard,
  HazardAnalyzer,
  Identity,
  Model,
  Plan,
  Sequence,
  SequenceDataType,
  SequenceIdentity,
  Step,
  Table,
  TableIdentity,
} from '@schemamill/core';

/**
 * PostgreSQL hazard analysis: the state edge of a migration plan.
 *
 * `analyzeHazards` reads the baseline and target models together with the plan and reports what
 * PostgreSQL would reject when the plan is applied. It never changes the plan: a hazard is a
 * fact beside it, and every hazard carries the index of the step it belongs to. Entities are
 * sequences — matched by schema and name — and identity columns — matched by table and column
 * name. Each side's options are read as stored, already effective from import. A baseline-only
 * entity is a drop with nothing to apply, and an entity the plan carries no step for reports
 * nothing; the plan is the only source of step indices.
 *
 * Definite hazards are self-inconsistent targets, rejected at apply regardless of stored state.
 * Each entity is checked in PostgreSQL's order and every violation is reported: `increment-zero`
 * first, then `bound-out-of-type-range` for a `MAXVALUE` and a `MINVALUE` that fall outside the
 * type's range — each bound checked against both ends, below the type's minimum and above its
 * maximum; a sequence reads its own `dataType`, an identity column its canonical integer type
 * (`canonicalIntType`; a column outside that family skips this pair and no other check) — then
 * `bounds-inverted` (`minValue >= maxValue`), `start-out-of-bounds` (`start` outside
 * `[minValue, maxValue]`, both edges inclusive), and `cache-nonpositive`. Every comparison is
 * `bigint` over the stored decimal strings, never JavaScript `number`.
 *
 * The one conditional kind is `bound-tightened`: an entity present on both sides whose target
 * `MINVALUE` rose above the baseline's, or whose target `MAXVALUE` fell below it. PostgreSQL
 * cross-checks the sequence's stored value against the new bound at apply, and that value is
 * not modeled, so the migration may fail; the hazard carries the actual baseline and target
 * values, `min` before `max` when both tightened. An entity with any definite hazard reports
 * none of its conditional ones: the definite failure happens first.
 *
 * A target-only sequence attaches to its `create-sequence` step; a matched one to the first
 * `alter-sequence` step carrying an option (any field but `ownedBy`), because that is the step
 * whose bounds are applied, or to its first `alter-sequence` step when it has only ownership
 * steps. A target-only identity attaches to its `add-identity` step. A matched identity attaches
 * to its `alter-identity` step, or, when the plan carries no identity step and the column's
 * type converts within the integer family, to the `alter-column` step carrying the `type`
 * change — the statement PostgreSQL converts and validates with. A definite hazard on a
 * recreated identity — the plan drops the old identity and adds a new one — falls back to that
 * `add-identity` step, the statement that would fail, and a recreated identity reports no
 * conditional hazard because its old sequence is dropped rather than cross-checked. A tightening
 * the type conversion moves with no `alter-identity` step attaches to the same `alter-column`
 * step carrying the change. Hazards come
 * back in plan order — step index ascending, then the entity's fixed check order. Entities are
 * iterated in sorted identity order, so neither model's array order can affect the result.
 * Returned hazards are fresh objects: the models and the plan are never mutated.
 *
 * `hazardAnalyzer` binds `analyzeHazards` to core's `HazardAnalyzer` seam.
 */

/** The analysis: every hazard the plan's state edge carries, in plan order. */
export function analyzeHazards(baseline: Model, target: Model, plan: Plan): readonly Hazard[] {
  const steps = plan.steps;
  const hazards: Hazard[] = [];
  for (const entry of sequenceEntries(baseline, target)) {
    hazards.push(...sequenceHazards(entry, steps));
  }
  for (const entry of identityEntries(baseline, target)) {
    hazards.push(...identityHazards(entry, steps));
  }
  return inPlanOrder(hazards);
}

/** Binds `analyzeHazards` to the `HazardAnalyzer` seam. */
export const hazardAnalyzer: HazardAnalyzer<Model, Plan, Hazard> = { analyze: analyzeHazards };

/** A sequence on one or both sides, keyed by its schema-qualified identity. */
interface SequenceEntry {
  readonly identity: SequenceIdentity;
  baseline?: Sequence;
  target?: Sequence;
}

/** An identity-bearing column on one or both sides, keyed by its table and column name. */
interface IdentityEntry {
  readonly table: TableIdentity;
  readonly name: string;
  baseline?: Identity;
  targetColumn?: Column;
}

/** The effective option values the definite and conditional checks read. */
interface Options {
  readonly minValue: string;
  readonly maxValue: string;
  readonly start: string;
  readonly increment: string;
  readonly cache: string;
}

/** Every sequence either model holds, merged by identity, in identity order. */
function sequenceEntries(baseline: Model, target: Model): readonly SequenceEntry[] {
  const entries = new Map<string, SequenceEntry>();
  for (const sequence of baseline.sequences) {
    entries.set(sequenceKey(sequence), {
      identity: sequenceIdentityOf(sequence),
      baseline: sequence,
    });
  }
  for (const sequence of target.sequences) {
    const key = sequenceKey(sequence);
    const entry = entries.get(key);
    if (entry === undefined) {
      entries.set(key, { identity: sequenceIdentityOf(sequence), target: sequence });
    } else {
      entry.target = sequence;
    }
  }
  return [...entries.values()].sort((left, right) =>
    compareSequenceIdentities(left.identity, right.identity),
  );
}

/** Every identity-bearing column either model holds, merged, in table and column order. */
function identityEntries(baseline: Model, target: Model): readonly IdentityEntry[] {
  const entries = new Map<string, IdentityEntry>();
  collectIdentities(entries, baseline.tables, 'baseline');
  collectIdentities(entries, target.tables, 'target');
  return [...entries.values()].sort(
    (left, right) =>
      compareStrings(left.table.schema, right.table.schema) ||
      compareStrings(left.table.name, right.table.name) ||
      compareStrings(left.name, right.name),
  );
}

/** Records every identity-bearing column of `tables`. */
function collectIdentities(
  entries: Map<string, IdentityEntry>,
  tables: readonly Table[],
  side: 'baseline' | 'target',
): void {
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.identity === undefined) continue;
      const key = identityKey(table, column.name);
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = { table: { schema: table.schema, name: table.name }, name: column.name };
        entries.set(key, entry);
      }
      if (side === 'baseline') entry.baseline = column.identity;
      else entry.targetColumn = column;
    }
  }
}

/** The hazards a sequence carries: definite on either side, plus tightening when matched. */
function sequenceHazards(entry: SequenceEntry, steps: readonly Step[]): readonly Hazard[] {
  const target = entry.target;
  if (target === undefined) return [];
  const step =
    entry.baseline === undefined
      ? findStepIndex(
          steps,
          (candidate) =>
            candidate.kind === 'create-sequence' &&
            sameIdentity(candidate.sequence, entry.identity),
        )
      : findSequenceAlterStep(steps, entry.identity);
  if (step === undefined) return [];
  const definite = definiteHazards(target.dataType, target, step);
  if (definite.length > 0 || entry.baseline === undefined) return definite;
  return tightenedHazards(entry.baseline, target, step);
}

/**
 * The first `alter-sequence` step for `identity` that carries a non-ownership option, because
 * that is the step whose bounds PostgreSQL applies; a sequence whose plan carries only
 * ownership alters falls back to the first of those.
 */
function findSequenceAlterStep(
  steps: readonly Step[],
  identity: SequenceIdentity,
): number | undefined {
  let ownershipOnly: number | undefined;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (step.kind !== 'alter-sequence' || !sameIdentity(step.sequence, identity)) continue;
    if (step.fields.some((field) => field.field !== 'ownedBy')) return index;
    ownershipOnly ??= index;
  }
  return ownershipOnly;
}

/** The hazards an identity column carries: definite on either side, plus tightening when matched. */
function identityHazards(entry: IdentityEntry, steps: readonly Step[]): readonly Hazard[] {
  const column = entry.targetColumn;
  if (column === undefined || column.identity === undefined) return [];
  const target = column.identity;
  const dataType = canonicalIntType(column.type);
  if (entry.baseline === undefined) {
    const step = findIdentityStep(steps, entry, 'add-identity');
    if (step === undefined) return [];
    return definiteHazards(dataType, target, step);
  }
  const alterIdentity = findIdentityStep(steps, entry, 'alter-identity');
  const addIdentity = findIdentityStep(steps, entry, 'add-identity');
  // A recreation has no alter step: the add step carries the whole target descriptor. An
  // identity whose options survive the column's int-family type conversion has no identity step
  // either: that alter-column step is the statement whose conversion PostgreSQL validates.
  const typeStep = dataType === undefined ? undefined : findIdentityTypeStep(steps, entry);
  const definiteStep = alterIdentity ?? addIdentity ?? typeStep;
  const definite =
    definiteStep === undefined ? [] : definiteHazards(dataType, target, definiteStep);
  if (definite.length > 0) return definite;
  // A recreation drops the old sequence with its stored value; only a surviving identity's
  // value is cross-checked at apply.
  if (alterIdentity === undefined && addIdentity !== undefined) return [];
  // A conversion that moves a default bound is carried by the column's type step instead.
  const conditionalStep = alterIdentity ?? findIdentityStep(steps, entry, 'alter-column');
  if (conditionalStep === undefined) return [];
  return tightenedHazards(entry.baseline, target, conditionalStep);
}

/** The index of the first step of `kind` whose table and column name match `entry`. */
function findIdentityStep(
  steps: readonly Step[],
  entry: IdentityEntry,
  kind: 'add-identity' | 'alter-identity' | 'alter-column',
): number | undefined {
  return findStepIndex(steps, (candidate) => {
    switch (candidate.kind) {
      case 'add-identity':
      case 'alter-identity':
      case 'alter-column':
        return (
          candidate.kind === kind &&
          sameIdentity(candidate.table, entry.table) &&
          candidate.name === entry.name
        );
      default:
        return false;
    }
  });
}

/** The index of the first `alter-column` step for `entry` carrying a `type` change. */
function findIdentityTypeStep(steps: readonly Step[], entry: IdentityEntry): number | undefined {
  return findStepIndex(
    steps,
    (candidate) =>
      candidate.kind === 'alter-column' &&
      sameIdentity(candidate.table, entry.table) &&
      candidate.name === entry.name &&
      candidate.fields.some((field) => field.field === 'type'),
  );
}

/** The index of the first step satisfying `predicate`, or `undefined` when none does. */
function findStepIndex(
  steps: readonly Step[],
  predicate: (step: Step) => boolean,
): number | undefined {
  for (let index = 0; index < steps.length; index += 1) {
    if (predicate(steps[index]!)) return index;
  }
  return undefined;
}

/**
 * Every definite violation of `options` against `dataType`, in PostgreSQL's check order:
 * `INCREMENT BY 0`, then each bound against both ends of the type's range (`MAXVALUE` before
 * `MINVALUE`), then the inverted bounds, the start, and the cache. An undefined `dataType` — an
 * identity column outside the canonical integer types — skips the type-range pair and no other
 * check.
 */
function definiteHazards(
  dataType: SequenceDataType | undefined,
  options: Options,
  step: number,
): Hazard[] {
  const hazards: Hazard[] = [];
  if (options.increment === '0') {
    hazards.push({ kind: 'increment-zero', step, increment: options.increment });
  }
  if (dataType !== undefined) {
    const bounds = sequenceTypeBounds(dataType);
    if (
      BigInt(options.maxValue) < BigInt(bounds.minValue) ||
      BigInt(options.maxValue) > BigInt(bounds.maxValue)
    ) {
      hazards.push({
        kind: 'bound-out-of-type-range',
        step,
        dataType,
        field: 'max',
        value: options.maxValue,
      });
    }
    if (
      BigInt(options.minValue) < BigInt(bounds.minValue) ||
      BigInt(options.minValue) > BigInt(bounds.maxValue)
    ) {
      hazards.push({
        kind: 'bound-out-of-type-range',
        step,
        dataType,
        field: 'min',
        value: options.minValue,
      });
    }
  }
  if (BigInt(options.minValue) >= BigInt(options.maxValue)) {
    hazards.push({
      kind: 'bounds-inverted',
      step,
      minValue: options.minValue,
      maxValue: options.maxValue,
    });
  }
  if (
    BigInt(options.start) < BigInt(options.minValue) ||
    BigInt(options.start) > BigInt(options.maxValue)
  ) {
    hazards.push({
      kind: 'start-out-of-bounds',
      step,
      start: options.start,
      minValue: options.minValue,
      maxValue: options.maxValue,
    });
  }
  if (BigInt(options.cache) <= 0n) {
    hazards.push({ kind: 'cache-nonpositive', step, cache: options.cache });
  }
  return hazards;
}

/** The bounds `after` tightens below `before`, `min` before `max`, with both actual values. */
function tightenedHazards(before: Options, after: Options, step: number): Hazard[] {
  const hazards: Hazard[] = [];
  if (BigInt(after.minValue) > BigInt(before.minValue)) {
    hazards.push({
      kind: 'bound-tightened',
      step,
      field: 'min',
      before: before.minValue,
      after: after.minValue,
    });
  }
  if (BigInt(after.maxValue) < BigInt(before.maxValue)) {
    hazards.push({
      kind: 'bound-tightened',
      step,
      field: 'max',
      before: before.maxValue,
      after: after.maxValue,
    });
  }
  return hazards;
}

/** `hazards` ordered by step index ascending, ties keeping their collection order. */
function inPlanOrder(hazards: readonly Hazard[]): readonly Hazard[] {
  return hazards
    .map((hazard, order) => ({ hazard, order }))
    .sort((left, right) => left.hazard.step - right.hazard.step || left.order - right.order)
    .map((entry) => entry.hazard);
}

/** A sequence's identity without its options. */
function sequenceIdentityOf(sequence: Sequence): SequenceIdentity {
  return { schema: sequence.schema, name: sequence.name };
}

/** The map key of a sequence identity; JSON keeps any characters unambiguous. */
function sequenceKey(identity: SequenceIdentity): string {
  return JSON.stringify([identity.schema, identity.name]);
}

/** The map key of a table and column pair; JSON keeps any characters unambiguous. */
function identityKey(table: TableIdentity, column: string): string {
  return JSON.stringify([table.schema, table.name, column]);
}

/** Whether both identities name the same table. */
function sameIdentity(left: TableIdentity, right: TableIdentity): boolean {
  return left.schema === right.schema && left.name === right.name;
}

function compareSequenceIdentities(left: SequenceIdentity, right: SequenceIdentity): number {
  return compareStrings(left.schema, right.schema) || compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
