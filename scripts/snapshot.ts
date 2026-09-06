/**
 * Taking a copy of the database, and proving the copy is usable.
 *
 * The execution plan asks for "backup and restore tested — including a
 * recovery test, not only a generation one", which is the distinction that
 * matters: a backup nobody has ever opened is a hope. Every snapshot taken
 * here is opened and inspected before the command reports success, and
 * restoring re-checks the file before it is allowed to replace anything.
 *
 * `VACUUM INTO` is what SQLite offers for this: it writes a consistent,
 * compacted copy while other connections keep reading, so a snapshot never
 * catches the database halfway through a transaction. Copying the file with
 * `cp` does not have that property, which is why this is not a shell script.
 */

import { createClient } from '@libsql/client';
import { rename, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { mkdir } from 'fs/promises';

export interface SnapshotReport {
  path: string;
  bytes: number;
  /** Migration ids the snapshot carries, so a restore cannot silently move the schema backwards. */
  migrations: string[];
  users: number;
  attempts: number;
}

/**
 * The filesystem path behind a database URL, or undefined for a remote one.
 *
 * A remote Turso database is not ours to snapshot: the copy would be taken
 * over the network without the consistency guarantee, and Turso keeps its own
 * backups. Claiming to have backed it up would be worse than saying we did
 * not.
 */
export function localPathFor(databaseUrl: string): string | undefined {
  if (!databaseUrl.startsWith('file:')) return undefined;
  return resolve(databaseUrl.slice('file:'.length));
}

function clientFor(path: string) {
  return createClient({ url: `file:${path}` });
}

/** Opens a database file and reports what it holds. Throws if it cannot. */
export async function inspect(path: string): Promise<SnapshotReport> {
  if (!existsSync(path)) throw new Error(`No such database file: ${path}`);

  const client = clientFor(path);
  try {
    const migrations = await client.execute(
      'SELECT id FROM _schema_migrations ORDER BY id'
    );
    const users = await client.execute('SELECT COUNT(*) AS total FROM users');
    const attempts = await client.execute('SELECT COUNT(*) AS total FROM assessment_attempts');

    return {
      path,
      bytes: (await stat(path)).size,
      migrations: migrations.rows.map(row => String(row.id)),
      users: Number(users.rows[0]?.total ?? 0),
      attempts: Number(attempts.rows[0]?.total ?? 0),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${path} is not a usable open-alpha database: ${reason}. ` +
      'A snapshot that cannot be opened is not a backup.'
    );
  } finally {
    client.close();
  }
}

/**
 * Writes a consistent copy to `destination` and opens it to confirm.
 *
 * Refuses to overwrite: a backup command that silently replaces yesterday's
 * good snapshot with today's broken one removes the only thing that would
 * have saved you.
 */
export async function createSnapshot(
  databaseUrl: string,
  destination: string
): Promise<SnapshotReport> {
  const source = localPathFor(databaseUrl);
  if (!source) {
    throw new Error(
      `${databaseUrl} is a remote database, which this cannot snapshot consistently. ` +
      'Turso keeps its own backups; use those, and keep this for file: deployments.'
    );
  }
  if (!existsSync(source)) throw new Error(`No such database file: ${source}`);
  if (existsSync(destination)) {
    throw new Error(`${destination} already exists; refusing to overwrite a snapshot.`);
  }

  await mkdir(dirname(resolve(destination)), { recursive: true });

  const client = clientFor(source);
  try {
    // Bound rather than interpolated: a path is not trusted syntax.
    await client.execute({ sql: 'VACUUM INTO ?', args: [resolve(destination)] });
  } finally {
    client.close();
  }

  // Opened before the command is allowed to claim success.
  return inspect(resolve(destination));
}

/**
 * Puts a snapshot back, after checking it and setting the current database
 * aside rather than deleting it.
 *
 * Restoring is the moment you are least able to afford a second mistake, so
 * the file being replaced is kept: if the snapshot turns out to be older than
 * expected, what was there is still on disk.
 */
export async function restoreSnapshot(
  snapshotPath: string,
  databaseUrl: string
): Promise<{ restored: SnapshotReport; replacedKeptAt?: string }> {
  const target = localPathFor(databaseUrl);
  if (!target) {
    throw new Error(`${databaseUrl} is a remote database; restore it through Turso, not here.`);
  }

  // Checked first: a restore that installs an unopenable file has turned a
  // recoverable outage into an unrecoverable one.
  const snapshot = await inspect(resolve(snapshotPath));

  let replacedKeptAt: string | undefined;
  if (existsSync(target)) {
    replacedKeptAt = `${target}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(target, replacedKeptAt);
  }

  const client = clientFor(resolve(snapshotPath));
  try {
    await client.execute({ sql: 'VACUUM INTO ?', args: [target] });
  } finally {
    client.close();
  }

  return { restored: await inspect(target), replacedKeptAt };
}

/** `open-alpha-2026-09-06T04-12-33-000Z.db` — sorts chronologically. */
export function snapshotName(at = new Date()): string {
  return `open-alpha-${at.toISOString().replace(/[:.]/g, '-')}.db`;
}
