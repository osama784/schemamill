import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalDefaultPrivileges,
  canonicalGrants,
  sameDefaultPrivileges,
  sameGrants,
} from './index.ts';
import type { DefaultPrivilege, Grant } from './index.ts';

/**
 * Tests for canonical privilege ordering and equality. The canonical model carries grants and
 * default privileges in source-independent order, so two models of the same schema compare and
 * serialize identically; `ALL` is a distinct marker, never an abbreviation of an explicit list.
 */

const grant = (grantee: string, privileges: readonly string[] | 'ALL'): Grant => ({
  grantee,
  privileges,
});
const defaults = (
  fields: Partial<DefaultPrivilege> & Pick<DefaultPrivilege, 'objectType' | 'kind' | 'grants'>,
): DefaultPrivilege => fields;

test('grants sort by grantee, privilege list, columns, then grant option', () => {
  const input: readonly Grant[] = [
    { grantee: 'zoe', privileges: ['SELECT'], grantOption: true },
    { grantee: 'amy', privileges: ['UPDATE', 'SELECT'], columns: ['email'] },
    { grantee: 'amy', privileges: ['SELECT'], columns: ['id'] },
    { grantee: 'amy', privileges: ['SELECT'], columns: ['id'], grantOption: true },
    { grantee: 'amy', privileges: ['SELECT'] },
    { grantee: 'amy', privileges: ['DELETE'] },
  ];
  assert.deepStrictEqual(canonicalGrants(input), [
    { grantee: 'amy', privileges: ['DELETE'] },
    { grantee: 'amy', privileges: ['SELECT'] },
    { grantee: 'amy', privileges: ['SELECT'], columns: ['id'] },
    { grantee: 'amy', privileges: ['SELECT'], columns: ['id'], grantOption: true },
    { grantee: 'amy', privileges: ['UPDATE', 'SELECT'], columns: ['email'] },
    { grantee: 'zoe', privileges: ['SELECT'], grantOption: true },
  ]);
});

test('ALL is a distinct marker that sorts before an explicit list and is never expanded', () => {
  const input: readonly Grant[] = [
    { grantee: 'app', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    { grantee: 'app', privileges: 'ALL' },
  ];
  const sorted = canonicalGrants(input);
  assert.deepStrictEqual(sorted, [
    { grantee: 'app', privileges: 'ALL' },
    { grantee: 'app', privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  ]);
  assert.equal(sorted[0]!.privileges, 'ALL');
  assert.equal(sameGrants([grant('app', 'ALL')], [grant('app', ['SELECT'])]), false);
  assert.equal(sameGrants([grant('app', 'ALL')], [grant('app', 'ALL')]), true);
});

test('canonical grant copies never alias the input arrays', () => {
  const columns = ['email'];
  const privileges = ['UPDATE'];
  const input: readonly Grant[] = [{ grantee: 'app', privileges, columns }];
  const sorted = canonicalGrants(input);
  assert.deepStrictEqual(sorted, input);
  assert.notStrictEqual(sorted[0], input[0]);
  assert.notStrictEqual(sorted[0]!.privileges, privileges);
  assert.notStrictEqual((sorted[0] as { columns?: readonly string[] }).columns, columns);
});

test('default privileges sort by roles, schemas, object type, then revoke before grant', () => {
  const input: readonly DefaultPrivilege[] = [
    defaults({ objectType: 'table', kind: 'grant', grants: [grant('app', ['SELECT'])] }),
    defaults({ objectType: 'table', kind: 'revoke', grants: [grant('app', 'ALL')] }),
    defaults({ objectType: 'sequence', kind: 'grant', grants: [grant('app', ['USAGE'])] }),
    defaults({ roles: ['owner'], objectType: 'table', kind: 'grant', grants: [] }),
    defaults({ schemas: ['app'], objectType: 'table', kind: 'grant', grants: [] }),
    defaults({
      roles: ['owner'],
      schemas: ['app'],
      objectType: 'table',
      kind: 'grant',
      grants: [],
    }),
  ];
  assert.deepStrictEqual(canonicalDefaultPrivileges(input), [
    defaults({ objectType: 'sequence', kind: 'grant', grants: [grant('app', ['USAGE'])] }),
    defaults({ objectType: 'table', kind: 'revoke', grants: [grant('app', 'ALL')] }),
    defaults({ objectType: 'table', kind: 'grant', grants: [grant('app', ['SELECT'])] }),
    defaults({ schemas: ['app'], objectType: 'table', kind: 'grant', grants: [] }),
    defaults({ roles: ['owner'], objectType: 'table', kind: 'grant', grants: [] }),
    defaults({
      roles: ['owner'],
      schemas: ['app'],
      objectType: 'table',
      kind: 'grant',
      grants: [],
    }),
  ]);
});

test('default privilege equality is source-order independent and scope-sensitive', () => {
  const first: readonly DefaultPrivilege[] = [
    defaults({
      roles: ['owner'],
      schemas: ['app'],
      objectType: 'table',
      kind: 'grant',
      grants: [grant('b', ['SELECT']), grant('a', ['USAGE'])],
    }),
    defaults({ objectType: 'sequence', kind: 'grant', grants: [grant('app', ['USAGE'])] }),
  ];
  const shuffled: readonly DefaultPrivilege[] = [
    defaults({
      grants: [grant('a', ['USAGE']), grant('b', ['SELECT'])],
      kind: 'grant',
      objectType: 'table',
      schemas: ['app'],
      roles: ['owner'],
    }),
    defaults({ objectType: 'sequence', kind: 'grant', grants: [grant('app', ['USAGE'])] }),
  ];
  assert.equal(sameDefaultPrivileges(first, shuffled), true);
  assert.equal(
    sameDefaultPrivileges(first, [
      ...first,
      defaults({ objectType: 'table', kind: 'revoke', grants: [grant('app', 'ALL')] }),
    ]),
    false,
  );
});

test('canonical default privilege copies never alias the input arrays', () => {
  const roles = ['owner'];
  const input: readonly DefaultPrivilege[] = [
    defaults({ roles, objectType: 'table', kind: 'grant', grants: [grant('app', ['SELECT'])] }),
  ];
  const sorted = canonicalDefaultPrivileges(input);
  assert.deepStrictEqual(sorted, input);
  assert.notStrictEqual(sorted[0], input[0]);
  assert.notStrictEqual(sorted[0]!.roles, roles);
  assert.notStrictEqual(sorted[0]!.grants[0], input[0]!.grants[0]);
});
