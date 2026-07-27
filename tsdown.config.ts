import { defineConfig } from 'tsdown';

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: true,
  },
  dts: {
    resolver: 'tsc',
    sourcemap: true,
  },
  entry: { index: 'src/index.tsx' },
  exports: {
    enabled: true,
    inlinedDependencies: false,
  },
  format: 'esm',
  outDir: 'dist',
  platform: 'browser',
  publint: {
    level: 'error',
  },
  sourcemap: true,
  target: 'es2020',
});
