// Scoped mutation-testing sanity check for @schemamill/core (see docs/mutation-testing.md).
//
// Guards the mutation-testing wiring: it first asserts the committed Stryker config, then
// derives a line range for one small, stable anchor function in `src/diff.ts` from the
// function's name at runtime — never a hard-coded line number — and runs a real, scoped
// Stryker run against it. Finally it asserts the JSON report proves the wiring is
// load-bearing: the anchor is covered, at least one mutant is killed, and the pinned mutator
// is among the killed. Invoked as `pnpm mutation:check`; CI runs it before the full
// `pnpm mutation:core` run.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The anchor's function name in src/diff.ts. If the function is renamed or moved, re-aim this
// constant — the maintenance contract lives in docs/mutation-testing.md.
const ANCHOR = 'sameOwner';
const SOURCE_FILE = 'src/diff.ts';
// A mutator observed Killed on this anchor across consecutive runs. If Stryker's mutator
// inventory changes, re-run, re-pin to another killed mutator, and update the guide.
const PINNED_MUTATOR = 'EqualityOperator';

const REPORT_RELATIVE_PATH = path.posix.join('reports', 'mutation', 'check.json');
const DERIVED_CONFIG_RELATIVE_PATH = path.posix.join('reports', 'mutation-check.config.mjs');

const packageRoot = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(packageRoot, SOURCE_FILE);
const configPath = path.join(packageRoot, 'stryker.config.mjs');
const derivedConfigPath = path.join(packageRoot, DERIVED_CONFIG_RELATIVE_PATH);
const reportPath = path.join(packageRoot, REPORT_RELATIVE_PATH);

const anchorLabel = `${SOURCE_FILE}:${ANCHOR}`;

/** Fail with the anchor and its maintenance contract, then exit non-zero. */
function fail(context, message) {
  console.error(`mutation-sanity: FAIL — ${context}: ${message}`);
  console.error(`mutation-sanity: anchor: ${anchorLabel}`);
  console.error(
    'mutation-sanity: if the anchor function is renamed or moved, re-aim the ANCHOR constant ' +
      'in this script (contract documented in docs/mutation-testing.md).',
  );
  process.exit(1);
}

// Derive the anchor's line range from its name: brace-match from the signature line to
// the function's closing brace, so a moved function still resolves.
function functionLineRange(source, name) {
  const lines = source.split('\n');
  const signature = new RegExp(`^function ${name}\\(`);
  const startIndex = lines.findIndex((line) => signature.test(line));
  if (startIndex === -1) {
    fail('anchor', `no top-level function named ${name} found in ${SOURCE_FILE}`);
  }
  let depth = 0;
  let opened = false;
  for (let line = startIndex; line < lines.length; line += 1) {
    for (const character of lines[line]) {
      if (character === '{') {
        depth += 1;
        opened = true;
      } else if (character === '}') {
        depth -= 1;
        if (opened && depth === 0) return { start: startIndex + 1, end: line + 1 };
      }
    }
  }
  fail('anchor', `unterminated body for ${name} in ${SOURCE_FILE}`);
}

/**
 * Build the self-contained derived config for the scoped run: the committed config spread with
 * the scoped overrides. `concurrency` is pinned at 2 so the targeted audit cannot exhaust a
 * memory-constrained VM (see docs/mutation-testing.md); `pnpm mutation:core` is unchanged.
 *
 * @param {object} config the committed Stryker config
 * @param {{ mutateScope: string, reportRelativePath: string }} options
 * @returns {object} the derived config
 */
export function buildDerivedConfig(config, { mutateScope, reportRelativePath }) {
  return {
    ...config,
    reporters: ['json'],
    jsonReporter: { fileName: reportRelativePath },
    mutate: [mutateScope],
    incremental: false,
    concurrency: 2,
  };
}

async function main() {
  // (a) The committed config declares the wiring this check depends on.
  const configModule = await import(pathToFileURL(configPath).href);
  const config = configModule.default;
  if (config.testRunner !== 'tap') {
    fail(
      'config',
      `stryker.config.mjs must declare testRunner: "tap", found ${JSON.stringify(config.testRunner)}`,
    );
  }
  for (const plugin of ['@stryker-mutator/tap-runner', '@stryker-mutator/typescript-checker']) {
    const plugins = Array.isArray(config.plugins) ? config.plugins : [];
    if (!plugins.includes(plugin)) {
      fail('config', `stryker.config.mjs plugins must include ${plugin}`);
    }
  }
  if (config.packageManager !== 'pnpm') {
    fail(
      'config',
      `stryker.config.mjs must declare packageManager: "pnpm", found ${JSON.stringify(config.packageManager)}`,
    );
  }

  const source = readFileSync(sourcePath, 'utf8');
  const anchorRange = functionLineRange(source, ANCHOR);
  const mutateScope = `${SOURCE_FILE}:${anchorRange.start}-${anchorRange.end}`;

  // (c) Write the derived config and run the scoped mutation run. The derived config is a
  // self-contained ESM module: the committed config spread with the scoped overrides.
  const derivedConfig = buildDerivedConfig(config, {
    mutateScope,
    reportRelativePath: REPORT_RELATIVE_PATH,
  });
  mkdirSync(path.dirname(derivedConfigPath), { recursive: true });
  writeFileSync(
    derivedConfigPath,
    `// Generated by scripts/mutation-sanity.mjs — do not edit.\nexport default ${JSON.stringify(derivedConfig, null, 2)};\n`,
  );
  rmSync(reportPath, { force: true });

  console.error(`mutation-sanity: anchor ${anchorLabel} at ${mutateScope}`);
  console.error('mutation-sanity: running the scoped Stryker mutation run (json reporter)…');
  const run = spawnSync('pnpm', ['exec', 'stryker', 'run', derivedConfigPath, '--force'], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
  if (run.error !== undefined || run.status !== 0) {
    const reason = run.error !== undefined ? run.error.message : `exit status ${run.status}`;
    fail('stryker run', `the scoped Stryker run failed (${reason})`);
  }

  // (d) Assert the report: the anchor is covered and at least one mutant — including the pinned
  // mutator — was killed.
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    fail('report', `could not read ${REPORT_RELATIVE_PATH}: ${error.message}`);
  }
  const mutants = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? []);
  if (mutants.length === 0) {
    fail('report', `no mutants reported in scope ${mutateScope}`);
  }
  const uncovered = mutants.filter((mutant) => mutant.status === 'NoCoverage');
  if (uncovered.length > 0) {
    fail(
      'report',
      `${uncovered.length} of ${mutants.length} mutants in ${mutateScope} have no coverage; ` +
        'the tests are not reaching the anchor',
    );
  }
  const killed = mutants.filter((mutant) => mutant.status === 'Killed');
  if (killed.length === 0) {
    fail('report', `no mutant in ${mutateScope} was killed (${mutants.length} mutants, 0 killed)`);
  }
  if (!killed.some((mutant) => mutant.mutatorName === PINNED_MUTATOR)) {
    const killedNames = [...new Set(killed.map((mutant) => mutant.mutatorName))].sort().join(', ');
    fail(
      'report',
      `pinned mutator ${PINNED_MUTATOR} is not among the killed mutants (killed: ${killedNames})`,
    );
  }

  console.error(
    `mutation-sanity: OK — ${mutants.length} mutants in ${mutateScope}, ` +
      `${killed.length} killed, pinned mutator ${PINNED_MUTATOR} among them.`,
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
