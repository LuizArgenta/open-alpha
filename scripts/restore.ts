/**
 * npm run restore -- <snapshot.db>
 *
 * Checks the snapshot, sets the current database aside, and puts the snapshot
 * in its place. The database being replaced is renamed rather than deleted:
 * restoring is when you can least afford a second mistake.
 *
 * Stop the application first. Replacing the file under a running server leaves
 * it holding a handle to a database that is no longer there.
 */

import { restoreSnapshot } from './snapshot.js';

const snapshotPath = process.argv[2];
const databaseUrl = process.env.TURSO_DATABASE_URL ?? 'file:local.db';

if (!snapshotPath) {
  console.error('Usage: npm run restore -- <snapshot.db>');
  process.exit(1);
}

restoreSnapshot(snapshotPath, databaseUrl)
  .then(({ restored, replacedKeptAt }) => {
    console.log(`Restored ${restored.path}`);
    console.log(`  ${restored.migrations.length} migrations, ${restored.users} users, ${restored.attempts} attempts`);
    if (replacedKeptAt) console.log(`  the database it replaced is at ${replacedKeptAt}`);
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
