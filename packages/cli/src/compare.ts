import { diff, plan } from '@schemamill/core';
import { hazardAnalyzer } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatChanges, formatHazards } from './format.ts';
import { buildJsonDocument, stringifyJsonDocument } from './json.ts';
import { importPair, mapSides, planOrReport } from './run.ts';
import { validateTargetVersion } from './target-version.ts';

/**
 * The `compare` command: read two schema sides — DDL dumps, with the workspace model filling
 * the side a lone path leaves open — and print the diff from baseline to target, then the same
 * `Hazards:` block `plan` prints for the pair.
 *
 * Wiring only — the side mapping and the read/import plumbing come from `run.ts`, the diff and
 * plan from `@schemamill/core`, the hazards from `@schemamill/postgres`, and the human wording
 * from `format.ts`. `--target-version` declares the PostgreSQL major the version-aware hazard
 * analysis reads; it shares `plan`'s 13–18 validation before any filesystem access, and the human
 * block now includes step-backed declaration refusals from the same collector the render gate
 * uses, while the JSON path still emits no hazards. Usage errors are emitted through commander's error machinery
 * before any filesystem access. The hazard step numbers are indices into the migration plan's step order;
 * `compare` prints no step list, so a line's `step <n>` refers to the step `schemamill plan`
 * would number `<n>`. Each hazard line also names the entity it belongs to, so compare lines
 * are self-attributing. An `error` diagnostic makes the exit code 1, but the diff is still
 * printed. A plan-time contract error — a target sequence whose `ownedBy` does not resolve —
 * prints one `schemamill: …` line on stderr, no diff, and exit code 1.
 */

interface CompareOptions {
  readonly verbose?: boolean;
  readonly baselineWorkspace?: boolean;
  readonly targetWorkspace?: boolean;
  readonly targetVersion: string;
  readonly json?: boolean;
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
    .option('--target-version <major>', 'PostgreSQL major (13-18)', '13')
    .option('--json', 'emit a structured JSON document')
    .addHelpText('after', '\nA single path is the target; the workspace fills the baseline.')
    .action(
      async (
        baseline: string | undefined,
        target: string | undefined,
        options: CompareOptions,
        command: Command,
      ) => {
        validateTargetVersion(command, options.targetVersion);
        const sides = mapSides({
          baseline,
          target,
          baselineWorkspace: options.baselineWorkspace,
          targetWorkspace: options.targetWorkspace,
        });
        if (!sides.ok) {
          command.error(sides.message);
        }
        if (options.json === true) {
          // One document, written only after both sides import and core's plan accepts the pair.
          // A read/workspace failure or a contract error has already written its one stderr line;
          // both leave stdout empty. The human path below stays byte-for-byte unchanged.
          const imported = await importPair(sides.baseline, sides.target, options.verbose === true);
          if (imported === null) {
            process.exitCode = 1;
            return;
          }
          if (planOrReport(() => plan(imported.baseline, imported.target)) === undefined) return;
          const document = buildJsonDocument({
            command: 'compare',
            baseline: { ...imported.sides.baseline, model: imported.baseline },
            target: { ...imported.sides.target, model: imported.target },
            changes: diff(imported.baseline, imported.target),
          });
          process.stdout.write(stringifyJsonDocument(document));
          process.exitCode = imported.exitCode;
          return;
        }
        const imported = await importPair(sides.baseline, sides.target, options.verbose === true);
        if (imported === null) {
          process.exitCode = 1;
          return;
        }
        const planned = planOrReport(() => plan(imported.baseline, imported.target));
        if (planned === undefined) return;
        const hazards = hazardAnalyzer.analyze(imported.baseline, imported.target, planned, {
          targetVersion: Number(options.targetVersion),
        });
        const hazardsBlock = hazards.length > 0 ? `\n${formatHazards(hazards)}` : '';
        process.stdout.write(
          `${formatChanges(diff(imported.baseline, imported.target))}${hazardsBlock}`,
        );
        process.exitCode = imported.exitCode;
      },
    );
}
