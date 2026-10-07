import { resolve } from 'node:path';

import { initWorkspace } from '@schemamill/core';
import type { Command } from 'commander';

/**
 * The `init` command: create a workspace in a directory.
 *
 * Wiring only — the layout, refusals, and empty model come from `@schemamill/core`'s
 * `initWorkspace`. Success prints one `Initialized workspace at <absolute path>` line on
 * stdout and exits 0; a diagnostic prints one `schemamill: <message>` line on stderr and
 * sets the exit code to 1, matching the other commands' stream and exit conventions.
 */

/** Registers `schemamill init` on `program`. */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Create a workspace in a directory.')
    .argument('[path]', 'directory for the workspace (default: the current directory)', '.')
    .action(async (path: string) => {
      const result = await initWorkspace(resolve(path));
      if (!result.ok) {
        process.stderr.write(`schemamill: ${result.diagnostic.message}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`Initialized workspace at ${result.root}\n`);
    });
}
