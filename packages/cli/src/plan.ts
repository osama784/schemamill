import { plan } from '@schemamill/core';
import { hazardAnalyzer, RenderRefusalError, renderSql } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatHazards, formatPlan } from './format.ts';
import { importPair, mapSides } from './run.ts';

/**
 * The `plan` command: read two schema sides — DDL dumps, with the workspace model filling the
 * side a lone path leaves open — and print the migration plan, the hazards beside it, and its
 * SQL.
 *
 * Wiring only — the side mapping and the read/import plumbing come from `run.ts`, the plan from
 * `@schemamill/core`, and the hazards and migration SQL from `@schemamill/postgres`, with the
 * human wording from `format.ts`. Usage errors are emitted through commander's error machinery
 * before any filesystem access. An `error` diagnostic makes the exit code 1, but the plan is
 * still printed. A plan the renderer refuses still prints its display, then one `schemamill:
 * refusing to render: …` line on stderr and exit code 1; any other render failure is a bug and
 * crashes.
 */

interface PlanOptions {
  readonly verbose?: boolean;
  readonly baselineWorkspace?: boolean;
  readonly targetWorkspace?: boolean;
}

/** Registers `schemamill plan` on `program`. */
export function registerPlan(program: Command): void {
  program
    .command('plan')
    .description('Print the migration plan and its SQL between a baseline and a target.')
    .argument('[baseline]', 'path to the baseline DDL dump')
    .argument('[target]', 'path to the target DDL dump')
    .option('--baseline-workspace', 'resolve the baseline from the workspace')
    .option('--target-workspace', 'resolve the target from the workspace')
    .option('--verbose', 'list every import diagnostic')
    .addHelpText('after', '\nA single path is the target; the workspace fills the baseline.')
    .action(
      async (
        baseline: string | undefined,
        target: string | undefined,
        options: PlanOptions,
        command: Command,
      ) => {
        const sides = mapSides({
          baseline,
          target,
          baselineWorkspace: options.baselineWorkspace,
          targetWorkspace: options.targetWorkspace,
        });
        if (!sides.ok) {
          command.error(sides.message);
        }
        const imported = await importPair(sides.baseline, sides.target, options.verbose === true);
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
      },
    );
}
