import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Tests resolve `@pipeline/runtime` from its source rather than its build output.
 *
 * `pnpm test` runs before `pnpm build` in CI, so the package's `main` would not exist yet. The
 * engine itself only imports types from it, which are erased, so this affects tests alone.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@pipeline/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
    },
  },
});
