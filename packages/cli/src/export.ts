import { plan, resolveWorkspace, serializeModel } from '@schemamill/core';
import type { Model } from '@schemamill/core';
import { RenderRefusalError, renderSql } from '@schemamill/postgres';
import type { Command } from 'commander';

import { renderMarkdown } from './markdown.ts';
import { planOrReport } from './run.ts';
import { validateTargetVersion } from './target-version.ts';

/**
 * The `export` command: project the workspace's canonical model into one reviewable artifact,
 * migration-style DDL, a readable Markdown projection, or canonical JSON, on stdout.
 *
 * The input is the workspace resolved from `process.cwd()` — no positional path, no dump
 * import, no database — so export is the read-only projection out of the workspace, never a
 * migration and never a write. `--format ddl` (the default) renders
 * `renderSql(plan(EMPTY_MODEL, model), { targetVersion })` against a typed local empty
 * baseline: the script builds the whole model on an empty database, and its ordering is the
 * plan's contract — schemas by name, then extensions, then the existing plan order (see
 * `docs/plans/export.md`, D7). `--target-version <major>` (default 13) declares the PostgreSQL
 * major the DDL is generated for and is validated against the same 13–18 span as `plan` before
 * any filesystem access. Every export step is a create, and create paths never consult the
 * target, so the projection is byte-invariant across the accepted majors today; the flag is
 * parity plumbing until a version-sensitive create form exists. `--format json` prints
 * `serializeModel(model)` byte for byte: the canonical model, bare, with no wrapper and no
 * version. `--format markdown` prints `renderMarkdown(model)`: a deterministic, readable
 * projection that sorts every collection and keeps each value on one line, with no wrapper.
 *
 * Failures never leave partial output. An invalid `--format` or `--target-version` is a usage
 * error before any filesystem access; a workspace failure, a plan-time contract error (a target
 * sequence whose `ownedBy` does not resolve), or a render refusal writes one `schemamill: …`
 * line to stderr, sets the exit code to 1, and leaves stdout empty. The plan is built before
 * the `--format` branch, so canonical JSON and Markdown are projections of a model that already
 * passed the contract. Any other render failure is a bug and crashes. An empty model exports `''`
 * as DDL, the empty-model bytes as JSON, and `# Schema\n` as Markdown.
 */

/** The empty baseline the DDL projection renders the workspace model against. */
const EMPTY_MODEL: Model = { tables: [], sequences: [], views: [], extensions: [] };

interface ExportOptions {
  readonly format: string;
  readonly targetVersion: string;
}

/** Registers `schemamill export` on `program`. */
export function registerExport(program: Command): void {
  program
    .command('export')
    .description('Print the workspace model as DDL, Markdown, or canonical JSON.')
    .option('--format <format>', 'output format: ddl, json, markdown', 'ddl')
    .option('--target-version <major>', 'PostgreSQL major (13-18)', '13')
    .action(async (options: ExportOptions, command: Command) => {
      const format = options.format;
      if (format !== 'ddl' && format !== 'json' && format !== 'markdown') {
        command.error('error: --format must be "ddl", "json", or "markdown"');
      }
      validateTargetVersion(command, options.targetVersion);
      const resolution = await resolveWorkspace(process.cwd());
      if (!resolution.ok) {
        process.stderr.write(`schemamill: ${resolution.diagnostic.message}\n`);
        process.exitCode = 1;
        return;
      }
      const projectable = planOrReport(() => plan(EMPTY_MODEL, resolution.model));
      if (projectable === undefined) return;
      if (format === 'markdown') {
        process.stdout.write(renderMarkdown(resolution.model));
        return;
      }
      if (format === 'json') {
        process.stdout.write(serializeModel(resolution.model));
        return;
      }
      let sql: string;
      try {
        sql = renderSql(projectable, {
          targetVersion: Number(options.targetVersion),
          baseline: EMPTY_MODEL,
        });
      } catch (error) {
        if (!(error instanceof RenderRefusalError)) throw error;
        process.stderr.write(`schemamill: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(sql);
    });
}
