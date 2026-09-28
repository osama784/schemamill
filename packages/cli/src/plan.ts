import { plan } from '@schemamill/core';
import { renderSql } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatPlan } from './format.ts';
import { importPair } from './run.ts';

/**
 * The `plan` command: read two DDL dumps and print the migration plan and its SQL.
 *
 * Wiring only — the plan comes from `@schemamill/core` and the migration SQL from
 * `@schemamill/postgres`, with the human wording from `format.ts`. An `error` diagnostic
 * makes the exit code 1, but the plan is still printed.
 */

interface PlanOptions {
  readonly verbose?: boolean;
}

/** Registers `schemamill plan` on `program`. */
export function registerPlan(program: Command): void {
  program
    .command('plan')
    .description('Print the migration plan and its SQL between two DDL dumps.')
    .argument('<baseline>', 'path to the baseline DDL dump')
    .argument('<target>', 'path to the target DDL dump')
    .option('--verbose', 'list every import diagnostic')
    .action(async (baseline: string, target: string, options: PlanOptions) => {
      const imported = await importPair(baseline, target, options.verbose === true);
      if (imported === null) {
        process.exitCode = 1;
        return;
      }
      const planned = plan(imported.baseline, imported.target);
      process.stdout.write(
        planned.steps.length === 0
          ? formatPlan(planned)
          : `${formatPlan(planned)}\n${renderSql(planned)}`,
      );
      process.exitCode = imported.exitCode;
    });
}
