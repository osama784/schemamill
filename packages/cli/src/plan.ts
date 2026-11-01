import { plan } from '@schemamill/core';
import {
  hazardAnalyzer,
  MAX_TARGET_VERSION,
  MIN_TARGET_VERSION,
  RenderRefusalError,
  renderSql,
} from '@schemamill/postgres';
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
 * human wording from `format.ts`. `--target-version` declares the PostgreSQL major the SQL is
 * generated for; it is validated against the package's 13–18 span before any filesystem access,
 * and passed to the renderer. Usage errors are emitted through commander's error machinery
 * before any filesystem access. An `error` diagnostic makes the exit code 1, but the plan is
 * still printed. A plan the renderer refuses still prints its display, then one `schemamill:
 * refusing to render …` line on stderr and exit code 1; any other render failure is a bug and
 * crashes.
 */

/** The accepted `--target-version` values: every declared major, as the flag's raw string. */
const TARGET_VERSIONS: ReadonlySet<string> = new Set(
  Array.from({ length: MAX_TARGET_VERSION - MIN_TARGET_VERSION + 1 }, (_, index) =>
    String(MIN_TARGET_VERSION + index),
  ),
);

interface PlanOptions {
  readonly verbose?: boolean;
  readonly baselineWorkspace?: boolean;
  readonly targetWorkspace?: boolean;
  readonly targetVersion: string;
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
    .option('--target-version <major>', 'PostgreSQL major to generate for, 13 to 18', '13')
    .addHelpText('after', '\nA single path is the target; the workspace fills the baseline.')
    .action(
      async (
        baseline: string | undefined,
        target: string | undefined,
        options: PlanOptions,
        command: Command,
      ) => {
        if (!TARGET_VERSIONS.has(options.targetVersion)) {
          command.error(
            `error: --target-version must be a PostgreSQL major from ${MIN_TARGET_VERSION} to ${MAX_TARGET_VERSION}`,
          );
        }
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
            process.stdout.write(
              renderSql(planned, { targetVersion: Number(options.targetVersion) }),
            );
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
