import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/vault/mw4761.cases.ts'],
    silent: true,
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
