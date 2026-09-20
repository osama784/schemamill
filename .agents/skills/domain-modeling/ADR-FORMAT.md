# ADR Format

ADRs live in `docs/adr/`, numbered sequentially as `NNNN-short-title.md` (for example, `0001-generate-never-apply.md`). The normative format lives in [`docs/adr/README.md`](../../../docs/adr/README.md); this page is the quick reference.

## Template

```md
# NNNN — Title

**Date/Status:** YYYY-MM-DD · proposed

**Context:** The forces at play, constraints, and why a decision is needed.

**Decision:** What we chose, stated in the active voice.

**Consequences:** What becomes easier or harder; follow-ups and risks.
```

Keep it to about one screen: state the decision and its rationale, not the debate.

Statuses: `proposed` → `accepted` (or `rejected`) → possibly `superseded by ADR-NNNN`. Accepted ADRs are immutable; changes happen through a new ADR that supersedes the old one.

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When to write an ADR

All three of these must be true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful.
2. **Surprising without context**: a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons.

If a decision is easy to reverse, skip it: you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."
