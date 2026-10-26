import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.JEV_LIVE ? [] : ['test/live/**'],
    testTimeout: 15_000,
  },
});
