import { plan } from '@schemamill/core';
import { hazardAnalyzer, RenderRefusalError, renderSql } from '@schemamill/postgres';
import type { Command } from 'commander';

import { formatHazards, formatPlan } from './format.ts';
import { buildJsonDocument, stringifyJsonDocument } from './json.ts';
import { importPair, mapSides, planOrReport } from './run.ts';
import { validateTargetVersion } from './target-version.ts';

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
 * still printed. A plan-time contract error — a target sequence whose `ownedBy` does not
 * resolve — prints one `schemamill: …` line on stderr, no display, and exit code 1. The imported
 * target model is passed to the render gate, so a declaration it carries but the declared major
 * cannot express refuses even on a table the plan does not touch; validation runs on zero-step
 * plans too. A refused plan still prints its display, then one `schemamill: refusing to render …`
 * line on stderr and exit code 1; any other render failure is a bug and crashes.
 */

interface PlanOptions {
  readonly verbose?: boolean;
  readonly baselineWorkspace?: boolean;
  readonly targetWorkspace?: boolean;
  readonly targetVersion: string;
  readonly json?: boolean;
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
    .option('--target-version <major>', 'PostgreSQL major (13-18)', '13')
    .option('--json', 'emit a structured JSON document')
    .addHelpText('after', '\nA single path is the target; the workspace fills the baseline.')
    .action(
      async (
        baseline: string | undefined,
        target: string | undefined,
        options: PlanOptions,
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
          // One document, written only after both sides import, core's plan accepts the pair, and
          // the renderer has validated the SQL the document deliberately does not embed. A read
          // failure or a contract error has already written its one stderr line and leaves stdout
          // empty; a refusal keeps its stderr wording but emits the document too. The human path
          // below stays byte-for-byte unchanged.
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
          let refusal: string | undefined;
          // Validation runs even for a zero-step plan: a no-diff workspace can still carry an
          // unsupported declaration, and DDL export already refuses one. The document below is
          // written in full either way; only the stderr line and exit code change on refusal.
          try {
            renderSql(planned, {
              targetVersion: Number(options.targetVersion),
              baseline: imported.baseline,
              targetModel: imported.target,
            });
          } catch (error) {
            if (!(error instanceof RenderRefusalError)) throw error;
            refusal = error.message;
          }
          const document = buildJsonDocument({
            command: 'plan',
            baseline: { ...imported.sides.baseline, model: imported.baseline },
            target: { ...imported.sides.target, model: imported.target },
            targetVersion: Number(options.targetVersion),
            steps: planned.steps,
            groups: planned.groups,
            hazards,
          });
          process.stdout.write(stringifyJsonDocument(document));
          if (refusal !== undefined) {
            process.stderr.write(`schemamill: ${refusal}\n`);
            process.exitCode = 1;
            return;
          }
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
        const hazardsBlock = hazards.length > 0 ? `${formatHazards(hazards)}\n` : '';
        process.stdout.write(
          planned.steps.length === 0
            ? formatPlan(planned)
            : `${formatPlan(planned)}\n${hazardsBlock}`,
        );
        // The target model reaches the gate so a declaration on an untouched table refuses too;
        // a zero-step plan has no SQL to write but is still validated, matching DDL export.
        try {
          const sql = renderSql(planned, {
            targetVersion: Number(options.targetVersion),
            baseline: imported.baseline,
            targetModel: imported.target,
          });
          if (planned.steps.length > 0) process.stdout.write(sql);
        } catch (error) {
          if (!(error instanceof RenderRefusalError)) throw error;
          process.stderr.write(`schemamill: ${error.message}\n`);
          process.exitCode = 1;
          return;
        }
        process.exitCode = imported.exitCode;
      },
    );
}
