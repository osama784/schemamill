import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { version as coreVersion } from '@schemamill/core';
import { dialect, version as postgresVersion } from '@schemamill/postgres';
import { expect, test } from 'vitest';

import { AppModule } from '../src/app.module.ts';

test('AppModule compiles', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  expect(moduleRef).toBeDefined();

  await moduleRef.close();
});

test('resolves @schemamill/core and @schemamill/postgres through the workspace', () => {
  expect(coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(dialect).toBe('postgres');
  expect(postgresVersion).toMatch(/^\d+\.\d+\.\d+$/);
});
