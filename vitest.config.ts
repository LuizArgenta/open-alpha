import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The database-backed tests share one scratch file; running test files
    // serially keeps them from clearing tables under each other.
    fileParallelism: false,
    env: {
      // api/_lib/auth.ts refuses to load without a secret, by design.
      JWT_SECRET: 'test-secret-not-used-anywhere-real',
      // Keep the scratch database out of the repo root, where the default
      // 'file:local.db' would land.
      TURSO_DATABASE_URL: 'file:tests/.tmp-test.db',
    },
  },
});
