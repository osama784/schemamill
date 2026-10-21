import type {
  SequenceDataType,
  SequenceIdentity,
  TableIdentity,
  TablePersistence,
} from './model.ts';

/**
 * Plan hazards — what could hurt when a migration plan is applied.
 *
 * A hazard is a fact about the plan, not an instruction: analysis never changes steps. Three
 * families exist. The definite kinds are self-inconsistent targets — values PostgreSQL rejects
 * at apply regardless of any stored state. The state-dependent kind is a bound the plan
 * tightens: PostgreSQL cross-checks the sequence's stored value against the new bound at apply,
 * that state is not modeled, and the migration may fail. The certain-cost kind is a persistence
 * flip: `SET LOGGED` / `SET UNLOGGED` rewrites the table and takes an ACCESS EXCLUSIVE lock at
 * apply — neither a rejection nor a may-fail.
 *
 * Every hazard carries `step`: the index into `Plan.steps` of the step that carries it, and
 * `entity`: the sequence, identity column, or table the hazard belongs to.
 */
export type Hazard =
  /** The target's `INCREMENT BY 0` — PostgreSQL rejects it at apply (`INCREMENT must not be zero`). */
  | {
      readonly kind: 'increment-zero';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly increment: string;
    }
  /** The target's `CACHE` is zero or negative — PostgreSQL rejects it at apply. */
  | {
      readonly kind: 'cache-nonpositive';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly cache: string;
    }
  /** The target's `MINVALUE >= MAXVALUE` — PostgreSQL rejects it at apply. */
  | {
      readonly kind: 'bounds-inverted';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly minValue: string;
      readonly maxValue: string;
    }
  /** The target's `START` falls outside `[MINVALUE, MAXVALUE]` — PostgreSQL rejects it at apply. */
  | {
      readonly kind: 'start-out-of-bounds';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly start: string;
      readonly minValue: string;
      readonly maxValue: string;
    }
  /** A target bound falls outside the sequence's data type range — PostgreSQL rejects it at apply. */
  | {
      readonly kind: 'bound-out-of-type-range';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly dataType: SequenceDataType;
      readonly field: 'min' | 'max';
      readonly value: string;
    }
  /**
   * The target tightens a bound below the baseline's — the stored value is cross-checked at
   * apply and is not modeled, so the migration may fail.
   */
  | {
      readonly kind: 'bound-tightened';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly field: 'min' | 'max';
      readonly before: string;
      readonly after: string;
    }
  /**
   * The target's persistence flip: `SET LOGGED` / `SET UNLOGGED` rewrites the table and takes
   * an ACCESS EXCLUSIVE lock at apply. A certain cost — neither a rejection nor state-dependent.
   */
  | {
      readonly kind: 'table-rewrite';
      readonly step: number;
      readonly entity: HazardEntity;
      readonly persistence?: TablePersistence;
    };

/**
 * The model entity a hazard belongs to: a sequence, identified by schema and name; an identity
 * column, identified by its table and column name; or a table, identified by schema and name.
 * Structured rather than a display label so identities carrying dots or other punctuation stay
 * unambiguous.
 */
export type HazardEntity =
  | { readonly kind: 'sequence'; readonly sequence: SequenceIdentity }
  | { readonly kind: 'identity-column'; readonly table: TableIdentity; readonly column: string }
  | { readonly kind: 'table'; readonly table: TableIdentity };
