# Mutation-testing harness — scoped to core, CI-gated

**Status:** planned · **Last updated:** 2026-10-05

Issue #37's triage found that the repo has no mutation-testing harness: design briefs hand-roll mutation seeds (m1–m5), record survival checks in issue comments, and rely on reviewers to repeat the exercise per slice. That does not scale — later slices never re-check earlier rules — and it leaves repo discipline's "a surviving mutation is an untested rule" a manual promise instead of a gate. This slice evaluates and wires a mutation-testing tool for TypeScript — StrykerJS is the presumed candidate, evaluated rather than assumed — scoped to `packages/core` first, with a budget-conscious CI job and a written triage process for survivors.

## Goal

One documented command mutates `packages/core` against its existing `node:test` suite, produces a report, and runs in CI on a bounded schedule without lengthening the required per-PR gate matrix; surviving mutations have a written triage rule.

## Scope

**In:**

- Evaluation of at least one ready candidate (StrykerJS with a TypeScript runner against the repo's `node --test` suite) against: compatibility with `node --test` and the existing TS sources, incremental or changed-files support, report formats, and measured runtime on `packages/core`.
- Configuration scoped to `packages/core` sources with the package's own test suite as the runner — core is the semantic heart and the cheapest first target.
- A budget-conscious CI integration: a scheduled workflow and/or a path-filtered job, never an unconditional per-PR gate; the report is published as an artifact, the run has a stated timeout, and the required `verify` matrix is untouched.
- Documented triage: how to read a report; when a survivor is a real gap (kill it with a test) versus provably equivalent or deliberately out of scope (record it, with the reason, where the record lives).
- A seeded-mutation sanity check: an intentionally introduced mutation of a known-tested core rule is caught by the harness, mirroring the m1–m5 pattern the briefs use by hand — the wiring is load-bearing.

**Out, named — never silent:** mutating or gating the other packages; adding a mutation gate to the default five-gate suite; exotic mutator operators and runtime optimization beyond the first budget.

## Acceptance

- The chosen tool runs against `packages/core` through a documented repo command and produces a report; that command is exactly what CI invokes.
- The seeded mutation is caught, and disabling the harness wiring fails that check.
- The triage protocol is written down in the repo, including where survivors and their dispositions are recorded.
- CI cost is bounded: the job is scheduled and/or path-filtered and does not lengthen the required `verify` matrix; `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm format:check` stay green.

## Done means

- A first full run's report and wall-clock runtime are recorded on the slice's tracker issue, with triage dispositions for the survivors that run found.
- The harness command and the CI job are committed; the five gates pass from the repo root.

## Deferred

Named for the slices that own them, never silent:

- **Repo-wide rollout** — `@schemamill/postgres`, `@schemamill/cli`, and `@schemamill/server` each get their own scoping pass once core's signal and runtime are known.
- **Per-package gates** — mutation scores as required per-package gates, with thresholds and ratchets, once a baseline is trustworthy.
- **Performance tuning** — incremental mode, sharding, per-mutant timeouts, and any effort to shorten the run beyond the first budget.
