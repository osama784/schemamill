import { diff } from '@schemamill/core';
import type { Command } from 'commander';

import { formatChanges } from './format.ts';
import { importPair } from './run.ts';

/**
 * The `compare` command: read two DDL dumps and print the diff from baseline to target.
 *
 * Wiring only — the diff comes from `@schemamill/core`, the diagnostic lines from
 * `diagnostics.ts`, and the human wording from `format.ts`. An `error` diagnostic makes the
 * exit code 1, but the diff is still printed.
 */

interface CompareOptions {
  readonly verbose?: boolean;
}

/** Registers `schemamill compare` on `program`. */
export function registerCompare(program: Command): void {
  program
    .command('compare')
    .description('Print the diff between two DDL dumps.')
    .argument('<baseline>', 'path to the baseline DDL dump')
    .argument('<target>', 'path to the target DDL dump')
    .option('--verbose', 'list every import diagnostic')
    .action(async (baseline: string, target: string, options: CompareOptions) => {
      const imported = await importPair(baseline, target, options.verbose === true);
      if (imported === null) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write(formatChanges(diff(imported.baseline, imported.target)));
      process.exitCode = imported.exitCode;
    });
}
