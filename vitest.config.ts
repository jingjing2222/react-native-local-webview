import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/LocalWebView.native.tsx'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 70,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    environment: 'node',
    testTimeout: 30_000,
  },
});
