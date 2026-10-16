import { diff, plan } from '@schemamill/core';
import { hazardAnalyzer } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatChanges, formatHazards } from './format.ts';
import { importPair, mapSides } from './run.ts';

/**
 * The `compare` command: read two schema sides — DDL dumps, with the workspace model filling
 * the side a lone path leaves open — and print the diff from baseline to target, then the same
 * `Hazards:` block `plan` prints for the pair.
 *
 * Wiring only — the side mapping and the read/import plumbing come from `run.ts`, the diff and
 * plan from `@schemamill/core`, the hazards from `@schemamill/postgres`, and the human wording
 * from `format.ts`. Usage errors are emitted through commander's error machinery before any
 * filesystem access. The hazard step numbers are indices into the migration plan's step order;
 * `compare` prints no step list, so a line's `step <n>` refers to the step `schemamill plan`
 * would number `<n>`. Each hazard line also names the entity it belongs to, so compare lines
 * are self-attributing. An `error` diagnostic makes the exit code 1, but the diff is still
 * printed.
 */

interface CompareOptions {
  readonly verbose?: boolean;
  readonly baselineWorkspace?: boolean;
  readonly targetWorkspace?: boolean;
}

/** Registers `schemamill compare` on `program`. */
export function registerCompare(program: Command): void {
  program
    .command('compare')
    .description('Print the diff and any hazards between a baseline and a target.')
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
        options: CompareOptions,
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
        const hazardsBlock = hazards.length > 0 ? `\n${formatHazards(hazards)}` : '';
        process.stdout.write(
          `${formatChanges(diff(imported.baseline, imported.target))}${hazardsBlock}`,
        );
        process.exitCode = imported.exitCode;
      },
    );
}
