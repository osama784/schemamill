#!/usr/bin/env node
/**
 * The `schemamill` command-line entry point.
 *
 * Assembles the program and hands it to Commander: each command's wiring lives in its own
 * module (`compare.ts`, `init.ts`, `plan.ts`), shared read/import/diagnostic plumbing in
 * `run.ts`, and the pure human formatting in `format.ts`. Exit codes are set through
 * `process.exitCode`, so buffered output always flushes before the process ends.
 */
import { version } from '@schemamill/core';
import { Command } from 'commander';

import { registerCompare } from './compare.ts';
import { registerInit } from './init.ts';
import { registerPlan } from './plan.ts';

const program = new Command();

program
  .name('schemamill')
  .description('A local-first studio for database schemas.')
  .version(version);

registerCompare(program);
registerInit(program);
registerPlan(program);

await program.parseAsync(process.argv);
