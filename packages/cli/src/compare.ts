import { diff, plan } from '@schemamill/core';
import { hazardAnalyzer } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatChanges, formatHazards } from './format.ts';
import { importPair } from './run.ts';

/**
 * The `compare` command: read two DDL dumps and print the diff from baseline to target, then
 * the same `Hazards:` block `plan` prints for the pair.
 *
 * Wiring only — the diff and plan come from `@schemamill/core`, the hazards from
 * `@schemamill/postgres`, and the human wording from `format.ts`. The hazard step numbers are
 * indices into the migration plan's step order; `compare` prints no step list, so a line's
 * `step <n>` refers to the step `schemamill plan` would number `<n>`. Each hazard line also
 * names the entity it belongs to, so compare lines are self-attributing. An `error` diagnostic
 * makes the exit code 1, but the diff is still printed.
 */

interface CompareOptions {
  readonly verbose?: boolean;
}

/** Registers `schemamill compare` on `program`. */
export function registerCompare(program: Command): void {
  program
    .command('compare')
    .description('Print the diff and any hazards between two DDL dumps.')
    .argument('<baseline>', 'path to the baseline DDL dump')
    .argument('<target>', 'path to the target DDL dump')
    .option('--verbose', 'list every import diagnostic')
    .action(async (baseline: string, target: string, options: CompareOptions) => {
      const imported = await importPair(baseline, target, options.verbose === true);
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
    });
}
