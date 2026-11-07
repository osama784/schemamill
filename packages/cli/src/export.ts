import { plan, resolveWorkspace, serializeModel } from '@schemamill/core';
import type { Model } from '@schemamill/core';
import { RenderRefusalError, renderSql } from '@schemamill/postgres';
import type { Command } from 'commander';

/**
 * The `export` command: project the workspace's canonical model into one reviewable artifact,
 * migration-style DDL or canonical JSON, on stdout.
 *
 * The input is the workspace resolved from `process.cwd()` — no positional path, no dump
 * import, no database — so export is the read-only projection out of the workspace, never a
 * migration and never a write. `--format ddl` (the default) renders
 * `renderSql(plan(EMPTY_MODEL, model))` against a typed local empty baseline: the script
 * builds the whole model on an empty database, and its ordering is the plan's contract —
 * schemas by name, then extensions, then the existing plan order (see `docs/plans/export.md`,
 * D7). `--format json` prints `serializeModel(model)` byte for byte: the canonical model, bare,
 * with no wrapper and no version.
 *
 * Failures never leave partial output. An invalid `--format` is a usage error before any
 * filesystem access; a workspace failure or a render refusal writes one `schemamill: …` line
 * to stderr, sets the exit code to 1, and leaves stdout empty. Any other render failure is a
 * bug and crashes. An empty model exports `''` as DDL and the empty-model bytes as JSON.
 */

/** The empty baseline the DDL projection renders the workspace model against. */
const EMPTY_MODEL: Model = { tables: [], sequences: [], views: [], extensions: [] };

interface ExportOptions {
  readonly format: string;
}

/** Registers `schemamill export` on `program`. */
export function registerExport(program: Command): void {
  program
    .command('export')
    .description('Print the workspace model as DDL or canonical JSON.')
    .option('--format <format>', 'output format: ddl or json', 'ddl')
    .action(async (options: ExportOptions, command: Command) => {
      const format = options.format;
      if (format !== 'ddl' && format !== 'json') {
        command.error('error: --format must be "ddl" or "json"');
      }
      const resolution = await resolveWorkspace(process.cwd());
      if (!resolution.ok) {
        process.stderr.write(`schemamill: ${resolution.diagnostic.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (format === 'json') {
        process.stdout.write(serializeModel(resolution.model));
        return;
      }
      let sql: string;
      try {
        sql = renderSql(plan(EMPTY_MODEL, resolution.model));
      } catch (error) {
        if (!(error instanceof RenderRefusalError)) throw error;
        process.stderr.write(`schemamill: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(sql);
    });
}
