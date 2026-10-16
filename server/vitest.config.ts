import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Each file gets its own process and data folder; files run one at a time because,
    // on PostgreSQL/MySQL in CI, they share one database.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
