import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse } from 'libpg-query';

/**
 * Parser canary for the first slice: proves the pinned libpg-query build loads under Node's
 * ESM loader and parses a realistic DDL fragment.
 *
 * The pinned build is `18.1.5-lowmem-32.0` (PostgreSQL 18 grammar). It was chosen over the
 * standard build because the JS wrapper and grammar are identical while the WASM linear memory
 * starts at 32 MiB instead of 128 MiB (both may grow up to a 1 GiB maximum).
 *
 * Re-run from `packages/postgres` with its `node --test` script, or from the repository root with
 * `pnpm --filter @schemamill/postgres test`.
 */

const DDL = `
CREATE TABLE organizations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  organization_id bigint NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id bigint NOT NULL,
  role text NOT NULL DEFAULT 'member',
  PRIMARY KEY (organization_id, user_id)
);
`;

test('libpg-query parses a multi-statement DDL fragment', async () => {
  const { version, stmts } = await parse(DDL);

  // The grammar version is encoded as major * 10000 + minor * 100 + patch, so this assertion
  // stays true across grammar patch bumps within PostgreSQL 18.
  assert.ok(version !== undefined, 'parse result carries a grammar version');
  assert.equal(Math.floor(version / 10000), 18);

  assert.equal(stmts?.length, 2, 'two statements parsed');

  const organizations = stmts?.[0];
  assert.ok(organizations?.stmt, 'first statement parsed');
  assert.ok('CreateStmt' in organizations.stmt, 'first statement is a CREATE TABLE');
  assert.equal(organizations.stmt.CreateStmt.relation?.relname, 'organizations');

  const memberships = stmts?.[1];
  assert.ok(memberships?.stmt, 'second statement parsed');
  assert.ok('CreateStmt' in memberships.stmt, 'second statement is a CREATE TABLE');
  assert.equal(memberships.stmt.CreateStmt.relation?.relname, 'memberships');

  const tableElts = memberships.stmt.CreateStmt.tableElts ?? [];

  // The inline PRIMARY KEY lands as a table-level Constraint node.
  const tableConstraintTypes = tableElts.flatMap((element) =>
    'Constraint' in element ? [element.Constraint.contype] : [],
  );
  assert.ok(
    tableConstraintTypes.includes('CONSTR_PRIMARY'),
    'expected the primary key table constraint',
  );

  // The inline REFERENCES clause lands as a Constraint node on its column.
  const organizationId = tableElts.find(
    (element) => 'ColumnDef' in element && element.ColumnDef.colname === 'organization_id',
  );
  assert.ok(organizationId && 'ColumnDef' in organizationId, 'expected the organization_id column');
  const columnConstraintTypes = (organizationId.ColumnDef.constraints ?? []).flatMap(
    (constraint) => ('Constraint' in constraint ? [constraint.Constraint.contype] : []),
  );
  assert.ok(
    columnConstraintTypes.includes('CONSTR_FOREIGN'),
    'expected the foreign key constraint',
  );
});
