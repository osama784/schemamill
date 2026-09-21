import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Bootstrapping a Nest module is I/O heavy; slow filesystems need more than the 5s default.
    testTimeout: 30_000,
  },
});
