# Design sketches

Fat-marker wireframes: deliberately rough, on purpose. They propose screen structure and vocabulary-level choices — what a screen holds, what a thing is called, where the loop turns — pending the owner's read; they are not pixels, spacing, or color. Strokes are drawn by hand (gone over twice where the weight matters), nothing is measured, and the labels carry more meaning than the lines. They sketch the **studio**: the local application where the model is seen and shaped, next to the CLI that works on the same model. Vocabulary follows the glossary in [`CONTEXT.md`](../../CONTEXT.md) — a *diff* is semantic, a *migration plan* is its own artifact, and *apply* stays the user's job.

## The loop they sketch

**design or import → compare → plan → review → ship** — the safe-change loop made visible: shape the model on the canvas or bring one in, compare a baseline to a target to see what actually changed, render that diff as a migration plan, review it with the hazards attached, and carry the migration SQL across the boundary yourself.

## The example they share

One workspace, one model, one moment: workspace and model `shop`, with the baseline snapshot `shop@launch` compared against the target — the live model. All four sketches tell that one story: the canvas shows the live model as it stands (six tables, `shipments` among them, `legacy_audit` already gone), the read brings that model in, the diff names what moved between baseline and target, and the plan renders those changes as ordered migration SQL. A relationship drawn on the canvas is the same relationship the diff reports as added and the plan creates.

## Files

- [`canvas.svg`](./canvas.svg) — the model canvas: window chrome and views, a table list that navigates the model, tables drawn as boxes of columns with a per-table header bar (the *table navbar*), relationships drawn between tables, one relationship being drawn, and one table reading as selected.
- [`import.svg`](./import.svg) — the two ways in (a DDL dump pasted or chosen as a file, and introspection of a live database, read-only), the progress of the read, and the read summary that names what came in and what was skipped or flagged.
- [`diff-review.svg`](./diff-review.svg) — comparing a baseline snapshot to the target live model: the diff grouped by object, counts by object kind, the object-identity question left for a decision, hazards collected beside the changes, and the way on to the plan.
- [`migration-export.svg`](./migration-export.svg) — the migration plan rendered as deterministic migration SQL, step by step, with a hazard gutter and transaction grouping, then export and copy — and the stance in plain sight: you apply it, schemamill never writes to your database.

## Conventions behind the strokes

- **Monochrome ink on paper.** No color coding anywhere; risk and emphasis are carried by shape, weight, and hatch, never by hue.
- **Hatch = attention.** A hatched triangle is a *hazard*; a hatched bar, row, or swatch is *selected*, *in progress*, or the stage in view.
- **Heavier or doubled frame = the active thing** — the current view, the selected table, the primary action.
- **Dashed = not settled, or a seam** — a relationship mid-draw, an off-canvas table, the boundary before an unsettled identity, and the dashed rules that divide one block of a screen from the next.
- **One vocabulary, no synonyms.** If a label here disagrees with `CONTEXT.md`, the glossary wins and the sketch is wrong.

These are index sketches, not specifications: nothing here fixes layout, and the detail belongs in the domain docs and the ADRs.
