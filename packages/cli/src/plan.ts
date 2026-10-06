import { plan } from '@schemamill/core';
import { hazardAnalyzer, RenderRefusalError, renderSql } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatHazards, formatPlan } from './format.ts';
import { importPair } from './run.ts';

/**
 * The `plan` command: read two DDL dumps and print the migration plan, the hazards beside it,
 * and its SQL.
 *
 * Wiring only — the plan comes from `@schemamill/core`, and the hazards and migration SQL from
 * `@schemamill/postgres`, with the human wording from `format.ts`. An `error` diagnostic makes
 * the exit code 1, but the plan is still printed. A plan the renderer refuses still prints its
 * display, then one `schemamill: refusing to render: …` line on stderr and exit code 1; any
 * other render failure is a bug and crashes.
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
      const hazards = hazardAnalyzer.analyze(imported.baseline, imported.target, planned);
      const hazardsBlock = hazards.length > 0 ? `${formatHazards(hazards)}\n` : '';
      if (planned.steps.length === 0) {
        process.stdout.write(formatPlan(planned));
      } else {
        process.stdout.write(`${formatPlan(planned)}\n${hazardsBlock}`);
        try {
          process.stdout.write(renderSql(planned));
        } catch (error) {
          if (!(error instanceof RenderRefusalError)) throw error;
          process.stderr.write(`schemamill: ${error.message}\n`);
          process.exitCode = 1;
          return;
        }
      }
      process.exitCode = imported.exitCode;
    });
}
