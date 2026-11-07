# Mutation testing

**Status:** drafted 2026-10-07 · living document

The repo rule "a surviving mutation is an untested rule" was a manual promise: design briefs seeded mutations by hand (m1–m5) and reviewers repeated the exercise per slice. The mutation harness makes it repeatable. StrykerJS mutates `@schemamill/core`'s sources against the package's existing `node:test` suite; the report classifies every mutant, and the triage protocol below says what each classification requires.

The harness is scoped to `@schemamill/core` for now; rolling it out to `@schemamill/postgres`, `@schemamill/cli`, and `@schemamill/server` is deferred until core's signal and runtime are known. It is deliberately **not** part of the required five-gate suite and never lengthens the `verify` matrix.

## Tool evaluation record

**Adopted: StrykerJS 10.0.0** with the plugins `@stryker-mutator/tap-runner@10.0.0` and `@stryker-mutator/typescript-checker@10.0.0` — all three pinned exactly as `@schemamill/core` devDependencies (Apache-2.0, ESM, `engines.node >=22`; StrykerJS 10.0.0 was released 2026-08-14). Plugin versions are pinned because upstream warns against mixing versions across the core and its plugins. CI runs the harness on Node 24 only: upstream tests Node 22 and 24, and Node 26 is untested there.

**Why the tap runner is the `node:test` path.** StrykerJS has no built-in runner for Node's test runner yet (upstream PR #6020 is pending), and its documented path for the task is `@stryker-mutator/tap-runner`: it invokes `node --test` with the TAP reporter, one process per test file, and records coverage per test file. That keeps the package's own suite as the oracle — no second test framework, no test-source changes.

**Alternatives ruled out.** StrykerJS's command runner is a blunt exit-code oracle: it cannot report which test file covered or failed a mutant, so every mutant reruns the whole suite with no coverage analysis — strictly inferior for this repo. `mutode` has been unmaintained since 2018. No other maintained TypeScript mutation-testing tool surfaced during evaluation.

## Commands

From the repo root:

- `pnpm mutation:core` — the full run: every source in `packages/core` is mutated against the package suite. It is `pnpm --filter @schemamill/core mutation`, i.e. `stryker run` in the package against `packages/core/stryker.config.mjs`. CI invokes exactly this command.
- `pnpm mutation:check` — the scoped sanity check: `node scripts/mutation-sanity.mjs` in `packages/core`. It asserts the committed config, runs a real Stryker run over one small anchor function, and asserts the report proves the wiring (see the anchor contract below). CI runs it before the full run.

Both scripts also exist directly on `packages/core` as `mutation` and `mutation:check`. Reports land in `packages/core/reports/mutation/` (`mutation.json` for machines, `mutation.html` for a browser); the incremental cache is `packages/core/reports/stryker-incremental.json`; both are gitignored, and CI always runs cold. The scoped check writes its own report to `packages/core/reports/mutation/check.json`.

**Memory-constrained machines.** Stryker's default concurrency is `cpuCount - 1` above four cores and `cpuCount` at four or fewer; on a small VM that is more Node processes than the machine can hold, and a full run can exhaust memory before it writes a report. The documented `pnpm mutation:core` invocation stays the CI contract, but local runs on constrained machines should cap the workers — from `packages/core`, `node_modules/.bin/stryker run --concurrency 2` — which also approximates CI wall-clock: GitHub's four-vCPU runner runs a concurrency of 4, split by the typescript checker into two checker and two test-runner processes. Observed 2026-10-07 on the 8 GiB / 20-vCPU WSL2 dev VM: two default-concurrency runs collapsed the host under memory pressure before a report was written; the same run at `--concurrency 2` finished in about 15 minutes.

## Scoping a run

A full run mutates every production source in the package. To work on one file or one function, scope the run rather than editing the config.

- **One file:** `--mutate 'src/diff.ts'` — a bare path is an ordinary glob.
- **Part of a file:** postfix the path with a mutation range, `:START-END`, 1-based and inclusive: `src/diff.ts:445-449`. A single line is `:N-N` — the hyphen is required; the column form `:startLine:startColumn-endLine:endColumn` exists but is rarely needed.
- **`--mutate` replaces the configured list**, so the config's `!src/**/*.test.ts` exclusion does not apply to that run: point it at production sources only.

From `packages/core`:

```sh
node_modules/.bin/stryker run --mutate 'src/diff.ts:445-449' --concurrency 2
```

`--concurrency 2` follows the memory guidance above; CI runs its own default.

**A 0-mutant run is a failure signal, not a pass.** A bare `src/diff.ts:445` — a line number without a range — is not a range: Stryker treats the whole string as a glob, warns `Glob pattern "src/diff.ts:445" did not result in any files`, instruments 0 mutants, and still exits 0. The line to read is `Instrumented N source file(s) with M mutant(s)` (or the report's mutant count); `N = 0` means nothing was tested. During #99 a bare `file:N` scope produced exactly this false green.

Probe a new scope with `--dryRunOnly` first: it instruments the range and runs the initial test suite without executing mutants, and writes no report.

A real scoped run uses the shared configuration, so it rewrites `reports/mutation/mutation.json` and `mutation.html`, and — because `incremental: true` — the incremental cache ends up holding only the scoped run's mutants, which makes the next full `pnpm mutation:core` run cold. When the numbers will be cited, use the derived-config pattern the sanity check uses: spread `stryker.config.mjs`, override `mutate`, set `incremental: false` and its own JSON report path.

The ranges above are snapshots: `src/diff.ts:445-449` is today's `sameOwner` body. After a refactor, re-check the lines (`sed -n '445,449p' src/diff.ts`) or let the sanity check derive the range for you — see `## The sanity-check anchor`.

## Configuration

`packages/core/stryker.config.mjs` is the single config both commands share:

- `testRunner: "tap"` with explicit `plugins` and `packageManager: "pnpm"` — pnpm needs both declared explicitly, and the explicit plugin list keeps the pinned versions in charge.
- `mutate: ["src/**/*.ts", "!src/**/*.test.ts"]` — production sources only.
- `checkers: ["typescript"]` — a mutant that does not compile is reported as `CompileError`, not silently run.
- `coverageAnalysis: "perTest"`, `incremental: true`, `ignorePatterns: ["dist", "reports", ".stryker-tmp"]`.
- `thresholds: { high: 80, low: 60, break: null }` — **no score gate this slice**. A low score does not fail the run; survivors are triaged by the protocol below.
- Modest `timeoutMS`/`timeoutFactor` so a hung mutant cannot stall the job for long.

**`ignoreStatic` is inert here.** With the tap runner, coverage is recorded per test file, and no mutant is ever classified as static (`totalCoverage.static` is always empty), so `ignoreStatic: true` currently does nothing and the static share is structurally zero. The real fallback trigger is different: if per-file coverage fan-out ever blows the runtime budget, drop `coverageAnalysis` to `"all"` — that makes a mutant run the whole suite, trading time for simplicity, and is the documented escape hatch.

## Reading a report

The JSON report lists every mutant with an `id`, `mutatorName`, source `location`, and `status`:

- **Killed** — a covering test failed on the mutant.
- **Survived** — tests ran but noticed nothing. Triage below.
- **NoCoverage** — no test reaches the mutant. In the scoped sanity check this fails the run; in a full run it is a coverage gap to fix first, because it makes the score meaningless for that spot.
- **CompileError** — the typescript checker rejected the mutant as non-compiling; it never runs. Not a survivor, and not a test kill either.
- **Timeout / RuntimeError** — the mutant made the suite hang or crash; each needs a look, but neither is silently ignored.
- **Ignored** — excluded by configuration.

## Attribution

The tap runner records one test per **file**: the report's `testFiles` array maps each id to a test file, and every entry holds exactly one test. A mutant's `killedBy` is therefore a list of test-file ids — a survivor tells you which file to look in, not which assertion missed it.

To attribute a kill to a specific test, replay the mutant in place:

1. Record the file's hash: `sha256sum src/diff.ts` — the restore proof.
2. Apply the exact replacement the report records: same location, same text.
3. Run only the covering test file — `node --test src/diff.test.ts` — and read the failing case name.
4. Restore the file (`git checkout -- src/diff.ts`), then verify the hash and `git status` are clean.
5. Never commit the probe: the probe is evidence; the fix, if any, is its own test commit.

A copy outside the repo does not work for this: the test imports its sibling module, so a scratch copy is never loaded and the probe passes vacuously. #99 ran this replay for twelve survivors and attributed each to its own test row.

## CI shape

`.github/workflows/mutation.yml` is a separate, budget-conscious workflow — never a required check:

- **Triggers:** pull requests into `dev` or `main` touching `packages/core/**`, the root manifests, the lockfile, or the workflow itself; `workflow_dispatch`; and a weekly `schedule` (Mondays 06:00 UTC). The schedule and dispatch triggers arm only once the file is on the default branch (`main`); a PR runs its own copy of the workflow before that.
- **Job:** `mutation (core)` on `ubuntu-24.04`, Node 24, `timeout-minutes: 60`. It runs `pnpm install --frozen-lockfile`, then `pnpm mutation:check`, then `pnpm mutation:core`, and uploads `packages/core/reports/` as the `mutation-report` artifact (`if-no-files-found: error`, retained 14 days).
- **Tighten later:** the 60-minute timeout is a stated budget, not a measurement; the first full run's wall-clock is recorded on the slice's tracker issue, and the timeout tightens from that evidence.

## Survivor triage

Every survivor gets exactly one disposition:

1. **Real gap → kill it with a test.** If a test *should* assert the mutated behavior, add that test. Keep the addition bounded (guidance: ≤ ~10 tests); a survivor that needs more than that is a follow-up, not a drive-by.
2. **Provably equivalent or deliberately out of scope → record it with the reason.** A mutant is equivalent when the change cannot alter observable behavior; it is out of scope when it belongs to a deferred slice or to code this harness is not chartered to guard. Neither is a failure, but silence is.
3. **NoCoverage → treat as a gap.** Add the test that reaches the code, or name the untested surface as a follow-up.

**Where the record lives:** dispositions are a comment on the GitHub issue or PR that owns the run, linking the run's artifact or report — GitHub is the durable record. For this first slice that is issue #52. For a future scheduled run that finds survivors, the run parses its artifact and opens a follow-up issue with the disposition list. A real gap's fix lands as its own change; the record is what makes an equivalence reviewable later.

**No score gate this slice.** The mutation score is a signal, not a required check. Adding per-package thresholds and ratchets is deferred until a baseline is trustworthy.

## The sanity-check anchor

`pnpm mutation:check` anchors on `src/diff.ts:sameOwner` — a small, stable, fully covered helper whose mutants are cheap and deterministic. The script's `ANCHOR` constant holds the function name; the line range is derived from the source at runtime, so moving the function within `src/diff.ts` is harmless (moving it to another file also requires re-aiming `SOURCE_FILE`), but **renaming or removing it requires re-aiming `ANCHOR`**. Every failure message from the script repeats that contract, and the script pins `EqualityOperator` as a mutator observed killed across consecutive runs; if Stryker's mutator inventory changes, re-run, re-pin another killed mutator, and update the script.

The check fails when: the committed config stops declaring the tap runner, the pinned plugins, or the pnpm package manager; the anchor cannot be found; the scoped run fails; the report has no mutants, any `NoCoverage`, no kill, or lacks the pinned mutator.

## Deferred

Named for the slices that own them, never silent:

- **Repo-wide rollout** — `@schemamill/postgres`, `@schemamill/cli`, and `@schemamill/server` each get their own scoping pass once core's signal and runtime are known.
- **Per-package gates** — mutation scores as required gates, with thresholds and ratchets, once a baseline is trustworthy.
- **Performance tuning** — incremental mode, sharding, per-mutant timeouts, and anything to shorten the run beyond the first budget.
- **Native `node:test` runner** — adopt StrykerJS's first-party runner when upstream PR #6020 lands.
- **PR-scoped changed-files runs** — mutate only what a PR touched, once report consumption justifies it.
- **Schedule activation pre-release** — the weekly schedule does not arm until this workflow is on the default branch.
