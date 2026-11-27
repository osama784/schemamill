# 0042 - Object privileges travel the model

**Status:** Accepted.

**Context:** [The import long-tail plan](../plans/import-long-tail.md):26-27, :54 named object
ownership, grants, and default privileges as slice F of the [#92](https://github.com/osama784/schemamill/issues/92)
long tail. The live #59 fact report captured four dump forms that the importer skipped:
`ALTER TABLE app.t OWNER TO postgres;`, `GRANT SELECT ON TABLE app.t TO app_user;`,
`GRANT UPDATE(email) ON TABLE app.t TO app_user;`, and
`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT SELECT ON TABLES TO app_user;`.
`--no-owner`/`--no-acl` remove exactly those statements, so a corpus dumped with the harness's
default flags could not exercise them. Roles are cluster-wide and `pg_dump` does not dump them;
modeling role objects or membership would be a much larger slice. [ADR 0027](./0027-plan-refuses-dangling-target-ownership.md):14
settled that `plan()` validates references inside the model and nothing else, which is the posture
this decision extends to role names.

**Decision:** `Table` and `Sequence` gain optional `owner?: string` and `privileges?: readonly
Grant[]`; `Model` gains optional `defaultPrivileges?: readonly DefaultPrivilege[]`. A `Grant` is
`{ grantee, privileges, columns?, grantOption? }`, where `privileges` is either the literal marker
`ALL` or an explicit opaque list, and `PUBLIC` is the literal grantee string. There is **no grantor
field**. A `DefaultPrivilege` is a scope — optional `roles`, optional `schemas`, `objectType` of
`table` or `sequence`, `kind` of `grant` or `revoke`, and `grants` — and repeated statements in one
scope merge by appending grants and re-sorting. Only `TABLES` and `SEQUENCES` are modeled; other
default object types and `ALL TABLES IN SCHEMA` stay named skips, as does `GrantRoleStmt`.

`ALL` is a marker and never a summary. It is emitted only when `GrantStmt.privileges` is absent;
the importer has no server-version input, and what `ALL` means varies by major, object type, and
column level (PG18 tables include `MAINTAIN`). An explicit seven-privilege grant is therefore
stored and compared as a list and never collapsed to `ALL`, and a list never compares equal to the
marker. One shared comparator sorts `Grant[]` by (grantee, privilege list, columns, grant option)
and `DefaultPrivilege[]` by (roles, schemas, object type, revoke before grant, then grants). The
importer normalizes, the workspace canonicalizes on read and write, and diff/plan compare and
render the sorted order. Rendering a scope's REVOKE before its GRANT is load-bearing: pg_dump emits
the REVOKE before the GRANT for the same grantee, so the reverse order would erase the grant.

Role names are opaque text: `quoteIdentifier` quotes them by need, `PUBLIC` stays bare, and no
cluster lookup or role existence check is added. **A plan emits absent-role statements as declared
and Apply fails** with PostgreSQL's `role "x" does not exist`; this is consistent with, not a
narrowing of, ADR 0027's "plan validates nothing else" posture because roles are not in the model
and the guard validates only references inside it. A plan-time `RoleExistenceError` was rejected:
it would require cluster knowledge the tool does not hold.

The diff adds `owner-changed` and `privileges-changed` table members, `owner`/`privileges` sequence
fields, and one outer `default-privileges-changed` carrying both sides' canonical scopes as
`before`/`after`, so a removed scope can be revoked rather than silently left behind. A baseline
REVOKE scope the target drops — or grants it no longer revokes — is refused by name
(`DefaultPrivilegeRevokeError`), because undoing a REVOKE would need server-default knowledge the
model does not carry. The plan adds four transactional step kinds at exact phases: **table phase 3b** `revoke`, immediately after
the phase-3a exclusion drops and before phase 4; **table phase 18b** `grant` then `alter-owner`,
after phase 18's foreign-key adds; **global phase 8a** `alter-default-privileges`, one step per changed grant after phase 8's
ownership attaches and before phase 9's sequence option alters, revoking baseline-only grants
before granting target additions. Revokes for removed objects are
suppressed because removal emits a drop, not a table change; dependent grant-option chains are not
reconstructed. Importer state tracks `SET SESSION AUTHORIZATION`; a GRANT/REVOKE with a stated
non-owner grantor is skipped with the pinned diagnostic `skipped GRANT statement (non-owner
grantor)` (and its REVOKE counterpart) rather than silently dropped. This is the no-grantor
boundary: a wrapper would be superuser-only and grant chains are deferred. No new version floor
is introduced — these forms exist across the declared PostgreSQL 13–18 span — and an explicit
`MAINTAIN` renders as declared per [ADR 0024](./0024-synthesized-forms-consult-the-target-version.md).

Workspace files stay bare model JSON with no version field. Every new field is optional and omitted
when absent: an older file reads byte-identically under the new parser, and a newer file carrying
these keys fails closed under an older reader's allow-list. The live `object-privileges` scene dumps
with `['--schema-only']` instead of the corpus default `--no-owner --no-privileges`, creates one
mixed-case role idempotently in `setupSql`, and asserts the imported shapes through `importChecks`
and `crossImportChecks`.

**Consequences:** A database built from a model with owners, grants, and default privileges now
round-trips through dump import with an empty diff. Downstream consumers must handle four new step
kinds, two new table change members, two new sequence fields, one new outer change, and the new
model keys in every exhaustive switch and DTO map. The renderer emits no grantor wrapper, so a
statement from a non-owner grantor remains a named skip instead of being silently reattributed.

**Introspection divergence:** the catalog read is unchanged and does not carry privileges, so a
dump-imported model may hold owner/grant/default shapes that an introspected one does not. The new
live scene deliberately has no `introspection` field; privilege evidence comes only from its import
checks. Closing that gap belongs to [#71](https://github.com/osama784/schemamill/issues/71) and
its #76–#80 children, not to this slice.

**Supersedes:** [the import long-tail plan](../plans/import-long-tail.md):26-27, :54, and :92-94
for the table/sequence ownership, grant, REVOKE, and `ALTER DEFAULT PRIVILEGES` families only.
Accepted ADRs are unchanged; in particular ADR 0027 remains accepted and this ADR is the record
for applying its posture to opaque role names. The other deferrals in the plan stand as written.

**Deferred:** role objects and membership (`GRANT app TO reader`); grantor-side `SET SESSION
AUTHORIZATION` wrappers and dependent grant-option chains; embedded double quotes in role names;
ACLs on views, materialized views, extensions, schemas, functions, and row-level security;
introspection parity (#71/#76–#80); `ALL TABLES IN SCHEMA` and `ON LARGE OBJECTS`; `MAINTAIN`
gating below PG17; the public-schema baseline on PG15+; and per-schema-versus-global default
interaction (a per-schema REVOKE cannot cancel a global grant under PostgreSQL's rules, a semantic
limit this slice records rather than validates).
