import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Tests resolve workspace packages to their TypeScript source, not to `dist`.
 * Production still runs the built output; this only removes the build step from
 * the edit-test loop, so a failing test is never just a stale artefact.
 */
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rexell/domain': src('./packages/domain/src/index.ts'),
      '@rexell/db': src('./packages/db/src/index.ts'),
      '@rexell/biometrics': src('./packages/biometrics/src/index.ts'),
    },
  },
  test: { include: ['**/test/**/*.test.ts'], environment: 'node' },
});
