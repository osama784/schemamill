import type { DefaultPrivilege, Grant } from './model.ts';

/**
 * Canonical ordering and equality for privilege payloads.
 *
 * Model determinism wins over source order: `Grant[]` sorts by grantee, privilege list, columns,
 * and grant option, and `DefaultPrivilege[]` sorts by roles, schemas, object type, and then
 * revoke before grant within one scope. `ALL` is a distinct marker, never an abbreviation of an
 * explicit list: a seven-privilege grant on PostgreSQL 18 carries `MAINTAIN` that `ALL` does not
 * mean on older majors, so the two spellings never compare equal. The comparator is the single
 * shared rule behind sorting, equality, and the importer's merge.
 */

/** Compares two strings with JavaScript's ordering, as everywhere else in the model. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Compares string lists element-wise, then by length; absent sorts before present. */
function compareStringArrays(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): number {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? -1 : 1;
  }
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = compareStrings(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/** `ALL` sorts before every explicit list; two lists compare element-wise and then by length. */
function comparePrivilegeList(
  left: readonly string[] | 'ALL',
  right: readonly string[] | 'ALL',
): number {
  if (left === 'ALL' || right === 'ALL') {
    return left === right ? 0 : left === 'ALL' ? -1 : 1;
  }
  return compareStringArrays(left, right);
}

/** The shared grant comparator: grantee, privilege list, columns, then grant option. */
export function compareGrants(left: Grant, right: Grant): number {
  return (
    compareStrings(left.grantee, right.grantee) ||
    comparePrivilegeList(left.privileges, right.privileges) ||
    compareStringArrays(left.columns, right.columns) ||
    Number(left.grantOption === true) - Number(right.grantOption === true)
  );
}

/** Revoke precedes grant inside one default-privilege scope, so a REVOKE cannot erase its GRANT. */
function kindRank(kind: 'grant' | 'revoke'): number {
  return kind === 'revoke' ? 0 : 1;
}

/** The shared default-privilege comparator, ending with the grants for a total order. */
export function compareDefaultPrivileges(left: DefaultPrivilege, right: DefaultPrivilege): number {
  return (
    compareStringArrays(left.roles, right.roles) ||
    compareStringArrays(left.schemas, right.schemas) ||
    compareStrings(left.objectType, right.objectType) ||
    kindRank(left.kind) - kindRank(right.kind) ||
    compareGrantArrays(left.grants, right.grants)
  );
}

function compareGrantArrays(left: readonly Grant[], right: readonly Grant[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = compareGrants(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

/** An independent copy of a grant: no array in the result aliases the input. */
function copyGrant(grant: Grant): Grant {
  return {
    grantee: grant.grantee,
    privileges: grant.privileges === 'ALL' ? 'ALL' : [...grant.privileges],
    ...(grant.columns === undefined ? {} : { columns: [...grant.columns] }),
    ...(grant.grantOption === undefined ? {} : { grantOption: grant.grantOption }),
  };
}

/** An independent, canonically ordered copy of a grant list. */
export function canonicalGrants(grants: readonly Grant[]): readonly Grant[] {
  return grants.map(copyGrant).sort(compareGrants);
}

/** An independent copy of a default privilege, with its grants canonically ordered. */
function copyDefaultPrivilege(privilege: DefaultPrivilege): DefaultPrivilege {
  return {
    ...(privilege.roles === undefined ? {} : { roles: [...privilege.roles] }),
    ...(privilege.schemas === undefined ? {} : { schemas: [...privilege.schemas] }),
    objectType: privilege.objectType,
    kind: privilege.kind,
    grants: canonicalGrants(privilege.grants),
  };
}

/** An independent, canonically ordered copy of a default-privilege list. */
export function canonicalDefaultPrivileges(
  privileges: readonly DefaultPrivilege[],
): readonly DefaultPrivilege[] {
  return privileges.map(copyDefaultPrivilege).sort(compareDefaultPrivileges);
}

/** Whether two grant lists carry the same grants, whatever order they arrived in. */
export function sameGrants(left: readonly Grant[], right: readonly Grant[]): boolean {
  const first = canonicalGrants(left);
  const second = canonicalGrants(right);
  return (
    first.length === second.length &&
    first.every((grant, index) => compareGrants(grant, second[index]!) === 0)
  );
}

/** Whether two default-privilege lists carry the same scopes and grants, in any source order. */
export function sameDefaultPrivileges(
  left: readonly DefaultPrivilege[],
  right: readonly DefaultPrivilege[],
): boolean {
  const first = canonicalDefaultPrivileges(left);
  const second = canonicalDefaultPrivileges(right);
  return (
    first.length === second.length &&
    first.every((privilege, index) => compareDefaultPrivileges(privilege, second[index]!) === 0)
  );
}

/** Whether two default privileges name the same scope and action, so their grants merge. */
function sameScope(left: DefaultPrivilege, right: DefaultPrivilege): boolean {
  return (
    compareStringArrays(left.roles, right.roles) === 0 &&
    compareStringArrays(left.schemas, right.schemas) === 0 &&
    left.objectType === right.objectType &&
    left.kind === right.kind
  );
}

/**
 * Appends `incoming` to the matching scope in `privileges`, or adds it, returning a canonically
 * ordered copy. Repeated statements in one scope (roles, schemas, object type, kind) merge by
 * appending grants; a per-schema scope never cancels a global one, because PostgreSQL keeps them
 * separate.
 */
export function mergeDefaultPrivilege(
  privileges: readonly DefaultPrivilege[],
  incoming: DefaultPrivilege,
): readonly DefaultPrivilege[] {
  const merged = privileges.map(copyDefaultPrivilege);
  const index = merged.findIndex((privilege) => sameScope(privilege, incoming));
  if (index === -1) {
    merged.push(copyDefaultPrivilege(incoming));
  } else {
    const found = merged[index]!;
    merged[index] = {
      ...found,
      grants: canonicalGrants([...found.grants, ...incoming.grants]),
    };
  }
  return merged.sort(compareDefaultPrivileges);
}
