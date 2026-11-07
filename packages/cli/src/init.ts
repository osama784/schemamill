import { resolve } from 'node:path';

import { initWorkspace } from '@schemamill/core';
import type { Model } from '@schemamill/core';
import type { Command } from 'commander';

import { formatDiagnostics, hasErrors } from './diagnostics.ts';
import { importSide, readDump, readStdin } from './run.ts';

/**
 * The `init` command: create a workspace in a directory, optionally from a DDL dump.
 *
 * `--from <dump>` populates the new workspace with the dump's imported model (`-` reads the
 * dump from stdin); without it the workspace holds the empty model. The order is read →
 * import → diagnose → refuse → create: a read or import failure prints its one
 * `schemamill: …` line and exits 1 before the target is touched; import diagnostics print on
 * stderr under the `source` label (errors always, skips and flags under `--verbose`); any
 * `error` diagnostic exits 1 without creating a workspace; only a clean or skip/flag-only
 * import reaches `initWorkspace`, whose refusals keep their `schemamill: <message>` line.
 *
 * Wiring only — the layout, refusals, and empty model come from `@schemamill/core`'s
 * `initWorkspace`; the read/import plumbing and diagnostics come from `run.ts` and
 * `diagnostics.ts`. Success prints one `Initialized workspace at <absolute path>` line on
 * stdout and exits 0, matching the other commands' stream and exit conventions.
 */

interface InitOptions {
  readonly from?: string;
  readonly verbose?: boolean;
}

/** Registers `schemamill init` on `program`. */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Create a workspace in a directory.')
    .argument('[path]', 'directory for the workspace (default: the current directory)', '.')
    .option('--from <dump>', 'import a DDL dump into the new workspace (- for stdin)')
    .option('--verbose', 'list every import diagnostic')
    .action(async (path: string, options: InitOptions) => {
      const target = resolve(path);
      let model: Model | undefined;
      if (options.from !== undefined) {
        const ddl = options.from === '-' ? await readStdin() : await readDump(options.from);
        if (ddl === null) {
          process.exitCode = 1;
          return;
        }
        const imported = await importSide(ddl);
        if (imported === null) {
          process.exitCode = 1;
          return;
        }
        if (imported.diagnostics.length > 0) {
          process.stderr.write(
            formatDiagnostics('source', imported.diagnostics, options.verbose ?? false),
          );
        }
        if (hasErrors(imported.diagnostics)) {
          process.exitCode = 1;
          return;
        }
        model = imported.model;
      }

      const result =
        model === undefined ? await initWorkspace(target) : await initWorkspace(target, model);
      if (!result.ok) {
        process.stderr.write(`schemamill: ${result.diagnostic.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`Initialized workspace at ${result.root}\n`);
    });
}
