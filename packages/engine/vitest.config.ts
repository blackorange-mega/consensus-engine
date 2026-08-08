import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    server: {
      // `node:sqlite` postdates Vite's builtin list, so it tries to resolve it
      // from disk and fails. It is a real Node builtin -- leave it alone.
      deps: { external: [/^node:sqlite$/] },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
  resolve: {
    alias: {
      '@consensus/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
