import type { Index, TableIdentity } from '@schemamill/core';

/**
 * PostgreSQL's conventional names, shared by both directions of the round trip.
 *
 * `synthesizedIndexName` is the single prediction formula: `render.ts` uses it to name an
 * unnamed index in a `DROP INDEX`, and `import.ts` uses it to recognize a server-generated
 * name on a `CREATE INDEX` the model declared unnamed and canonicalize it back to unnamed.
 * The prediction is deliberately best-effort: PostgreSQL truncates identifiers at 63 bytes
 * and appends collision suffixes (`_idx1`, `_idx2`, …) through `makeObjectName`, and neither
 * is predictable offline, so such names stay named and still read as remove + add.
 */

/** PostgreSQL's conventional index name for an unnamed index. */
export function synthesizedIndexName(table: TableIdentity, index: Index): string {
  return `${table.name}${index.columns.map((column) => `_${column}`).join('')}_idx`;
}
