/**
 * npm run backup [-- <directory>]
 *
 * Writes a verified snapshot of the database this deployment is configured to
 * use. Defaults to ./backups, which a container should mount somewhere that
 * outlives it — a snapshot on the same disposable filesystem as the database
 * is not a backup, it is a second copy of the same risk.
 */

import { join } from 'path';
import { createSnapshot, snapshotName } from './snapshot.js';

const databaseUrl = process.env.TURSO_DATABASE_URL ?? 'file:local.db';
const directory = process.argv[2] ?? process.env.BACKUP_DIR ?? 'backups';

createSnapshot(databaseUrl, join(directory, snapshotName()))
  .then(report => {
    console.log(`Snapshot written and verified: ${report.path}`);
    console.log(`  ${(report.bytes / 1024).toFixed(1)} KiB`);
    console.log(`  ${report.migrations.length} migrations, ${report.users} users, ${report.attempts} attempts`);
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
