import { defineConfig } from 'vitest/config';

/**
 * Deliberately not UTC, and set here rather than in `test.env`.
 *
 * Every timestamp this schema stores comes from SQLite's datetime('now'), which
 * writes UTC in a form carrying no timezone marker — and JavaScript reads that
 * shape as local time. In UTC the two agree, so the entire class of bug is
 * invisible exactly where CI runs: a review coming due three hours early on the
 * deployment server passed every check for months.
 *
 * It has to be set before Node initialises its timezone, which happens before a
 * worker reads `test.env` — setting it there leaves process.env.TZ correct and
 * the actual offset stubbornly zero, which looks like it worked. This file is
 * evaluated in the main process, so workers inherit it at spawn.
 *
 * UTC-3 is where this is deployed, and the offset is big enough to push a date
 * across midnight, which is what makes day-counting errors visible.
 */
process.env.TZ = 'America/Recife';

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
