#!/usr/bin/env node
import { version } from '@schemamill/core';
import { Command } from 'commander';

const program = new Command();

program
  .name('schemamill')
  .description('A local-first studio for database schemas.')
  .version(version);

await program.parseAsync(process.argv);
