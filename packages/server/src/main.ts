import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

const DEFAULT_PORT = 3000;
const MAX_PORT = 65_535;

function resolvePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (value.trim() === '' || !Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new Error(`PORT must be an integer between 0 and ${MAX_PORT}, received "${value}"`);
  }

  return port;
}

async function bootstrap(): Promise<void> {
  const port = resolvePort(process.env.PORT);
  const app = await NestFactory.create(AppModule);

  await app.listen(port, '127.0.0.1');
}

await bootstrap();
