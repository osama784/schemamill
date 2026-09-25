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
 * The canary cannot distinguish the lowmem build from the standard build (identical wrapper and
 * grammar, same reported grammar version); the exact catalog pin in `pnpm-workspace.yaml` is what
 * guards the build choice.
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

  const columnConstraints = (columnName: string) => {
    const column = tableElts.find(
      (element) => 'ColumnDef' in element && element.ColumnDef.colname === columnName,
    );
    assert.ok(column && 'ColumnDef' in column, `expected the ${columnName} column`);
    return column.ColumnDef.constraints ?? [];
  };
  const columnConstraintTypes = (columnName: string) =>
    columnConstraints(columnName).flatMap((constraint) =>
      'Constraint' in constraint ? [constraint.Constraint.contype] : [],
    );

  // The inline REFERENCES clause lands as a Constraint node on its column.
  assert.ok(
    columnConstraintTypes('organization_id').includes('CONSTR_FOREIGN'),
    'expected the foreign key constraint',
  );

  // NOT NULL and DEFAULT clauses must survive as constraints on their columns; a DEFAULT lands as
  // a Constraint with CONSTR_DEFAULT that carries its expression. A parser regression that
  // accepted the DDL but silently dropped either clause would otherwise go unnoticed.
  for (const columnName of ['organization_id', 'user_id', 'role']) {
    assert.ok(
      columnConstraintTypes(columnName).includes('CONSTR_NOTNULL'),
      `expected a NOT NULL constraint on ${columnName}`,
    );
  }
  const roleDefault = columnConstraints('role').find(
    (constraint) =>
      'Constraint' in constraint && constraint.Constraint.contype === 'CONSTR_DEFAULT',
  );
  assert.ok(
    roleDefault && 'Constraint' in roleDefault && roleDefault.Constraint.raw_expr !== undefined,
    'expected the DEFAULT clause on role to carry its expression',
  );
});
