# 0041 - Exclusion constraints and expression, partial, and covering indexes travel the model

**Status:** Accepted.

**Context:** [ADR 0014](./0014-catalog-index-canonicalization.md):9 and
[ADR 0016](./0016-catalog-constraint-canonicalization.md):23 deferred modeling exclusion
constraints and their backing indexes; [ADR 0030](./0030-constraint-backed-index-comments-are-flagged.md):21
deferred the constraint's own comment, narrowed for the backing index by
[ADR 0035](./0035-exclusion-backing-index-comments-are-flagged.md):17;
[ADR 0038](./0038-not-null-constraint-comments-travel-the-model.md):19 deferred it again for
comments; and [ADR 0014](./0014-catalog-index-canonicalization.md):17 deferred expression,
partial, and covering (`INCLUDE`) index modeling. [The import long-tail plan](../plans/import-long-tail.md):31-32
sliced both out. [#90](https://github.com/osama784/schemamill/issues/90) closes them with one
canonical shape per surface and no new version floor (the PostgreSQL 13 floor still holds).

**Decision:** `Table.exclusionConstraints` is optional and carries one `ExclusionConstraint` per
declared exclusion: `elements` is opaque, whitespace-normalized canonical text; `accessMethod`
is explicit-only (`gist` when absent); `where`, `deferrable`, `initiallyDeferred`, and `comment`
are explicit-only; `name` travels but is never identity. Identity is the canonical element text,
with `name` an attribute, matching the [constraint doctrine](../../CONTEXT.md). Both inbound paths
produce identical text with the importer's `normalizeSourceText`: the dump path slices from the
`EXCLUDE USING <method> (` keyword through the matching `)` and `WHERE` clause with a dedicated
reader; the catalog path wraps `pg_get_constraintdef` in a synthesized `ALTER TABLE … ADD
CONSTRAINT … EXCLUDE …`, confirms with libpg-query that it is an exclusion constraint, and runs the
same reader. No deparser is used; `libpg-query`'s `normalize` replaces constants and is not an
identity source. A generated server name is stripped back to unnamed with the `_excl` mirror that
reuses the index element-name heuristic; collision suffixes stay unpredictable offline, so those
constraints keep their names. An uncuttable or inconsistent definition fails closed with
`kind: 'skip'`, `code: 'unsupported-statement'`. The backing index is still consumed and never
appears as an `Index` row; its comment keeps ADR 0030's `dropped comment from <schema>.<index>`
flag, while the constraint's own comment travels as a `CommentTarget` and terminal `comment` step.

Indexes gain ordered `IndexElement` keys — a plain column or an opaque `{ expression }` — plus
optional `include` and `where`. One shared element serializer drives every identity, equality,
pairing, structure-key, and display join. The catalog widens `classifyIndexEnvelope` to accept
expression, partial, and `INCLUDE` forms for table owners under an explicit `ownerKind` gate;
view owners keep the named skip. A constraint cannot consume an index it cannot back: a
`USING INDEX` reference to an expression, partial, or `INCLUDE` index fails closed with a new
skip. Render emits the authored form without a version floor for these declarations, and unnamed
server names are predicted only as canonicalization and drop guards, never written into an add.

The workspace accepts the new optional keys and rejects unknown ones: an older binary refuses a
newer file, and a newer reader accepts an older file byte-identically. `diff` and `plan` carry the
new members, including the two distinct exclusion drop/add phases after the check phases, and the
core, postgres, and CLI exhaustive maps are updated before any behavior ships.

**Consequences:** A database built from a model's own plans now round-trips through both dump and
catalog with empty diffs for exclusion constraints and for expression, partial, and covering
indexes, including a non-default operator class and each constraint's own comment. Mutating agents
and downstream consumers must map the new union variants. No `Index` row leaks from a
constraint-backed index, and no authored spelling is invented by identity.

**Supersedes:** [ADR 0014](./0014-catalog-index-canonicalization.md):9, :17;
[ADR 0016](./0016-catalog-constraint-canonicalization.md):17, :23;
[ADR 0030](./0030-constraint-backed-index-comments-are-flagged.md):21;
[ADR 0035](./0035-exclusion-backing-index-comments-are-flagged.md):17;
[ADR 0038](./0038-not-null-constraint-comments-travel-the-model.md):19;
and [the import long-tail plan](../plans/import-long-tail.md):31-32, for the modeled families only.
The other deferrals in those documents stand unchanged.

**Deferred:** #74/#75 constraint attributes and refusal hardening; a modeled operator class,
collation, storage, or tablespace on an index; collision-suffix recovery; exotic expression-name
heuristics; matview expression/partial/`INCLUDE` catalog parity (#71); unnamed `IF NOT EXISTS`
parsing; and live-catalog `CONCURRENTLY`.
