/**
 * The execution plan asks for backup and restore "tested — including a
 * recovery test, not only a generation one". That distinction is the whole
 * point: a snapshot that was written is not evidence of anything, and the
 * first time anyone finds out whether it restores should not be the day they
 * need it to.
 *
 * These work on their own database files rather than the shared test one,
 * because replacing a file under an open connection is exactly what the
 * restore command tells you not to do.
 */

import { createClient } from '@libsql/client';
import { existsSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSnapshot,
  inspect,
  localPathFor,
  restoreSnapshot,
  snapshotName,
} from '../scripts/snapshot.js';

let workspace: string;
let livePath: string;
let liveUrl: string;

/** A database with the shape the snapshot tooling expects, and some data. */
async function seed(path: string, users: string[]): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  await client.execute(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS assessment_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL)`);
  await client.execute("INSERT OR IGNORE INTO _schema_migrations (id) VALUES ('001-legacy-columns-and-tables')");
  for (const email of users) {
    await client.execute({ sql: 'INSERT OR IGNORE INTO users (email) VALUES (?)', args: [email] });
  }
  client.close();
}

async function emailsIn(path: string): Promise<string[]> {
  const client = createClient({ url: `file:${path}` });
  const rows = await client.execute('SELECT email FROM users ORDER BY email');
  client.close();
  return rows.rows.map(row => String(row.email));
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'open-alpha-backup-'));
  livePath = join(workspace, 'live.db');
  liveUrl = `file:${livePath}`;
  await seed(livePath, ['first@example.test', 'second@example.test']);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('taking a snapshot', () => {
  it('writes a file and reports what it contains', async () => {
    const report = await createSnapshot(liveUrl, join(workspace, snapshotName()));

    expect(existsSync(report.path)).toBe(true);
    expect(report.users).toBe(2);
    expect(report.migrations).toContain('001-legacy-columns-and-tables');
    expect(report.bytes).toBeGreaterThan(0);
  });

  it('opens the snapshot before claiming success', async () => {
    // The report comes from reading the written file, not from the source, so
    // a snapshot that could not be opened could not have been reported on.
    const report = await createSnapshot(liveUrl, join(workspace, 'verified.db'));
    expect(await emailsIn(report.path)).toEqual(['first@example.test', 'second@example.test']);
  });

  it('refuses to overwrite an existing snapshot', async () => {
    const destination = join(workspace, 'once.db');
    await createSnapshot(liveUrl, destination);

    // Otherwise a broken snapshot silently replaces the good one from
    // yesterday — removing the thing that would have saved you.
    await expect(createSnapshot(liveUrl, destination)).rejects.toThrow(/refusing to overwrite/);
  });

  it('refuses a remote database rather than pretending', async () => {
    await expect(
      createSnapshot('libsql://example.turso.io', join(workspace, 'remote.db'))
    ).rejects.toThrow(/remote database/);
  });

  it('reports a missing source instead of writing an empty file', async () => {
    await expect(
      createSnapshot(`file:${join(workspace, 'absent.db')}`, join(workspace, 'out.db'))
    ).rejects.toThrow(/No such database file/);
  });

  it('names snapshots so they sort chronologically', () => {
    const earlier = snapshotName(new Date('2026-01-02T03:04:05Z'));
    const later = snapshotName(new Date('2026-11-02T03:04:05Z'));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe('restoring it — the half that is usually untested', () => {
  it('brings back data that was lost after the snapshot', async () => {
    const snapshot = await createSnapshot(liveUrl, join(workspace, 'before-loss.db'));

    // The disaster: the live database loses a row and gains a wrong one.
    const client = createClient({ url: liveUrl });
    await client.execute("DELETE FROM users WHERE email = 'first@example.test'");
    await client.execute("INSERT INTO users (email) VALUES ('accident@example.test')");
    client.close();
    expect(await emailsIn(livePath)).toEqual(['accident@example.test', 'second@example.test']);

    const { restored } = await restoreSnapshot(snapshot.path, liveUrl);

    expect(await emailsIn(livePath)).toEqual(['first@example.test', 'second@example.test']);
    expect(restored.users).toBe(2);
  });

  it('restores onto a database that is gone entirely', async () => {
    const snapshot = await createSnapshot(liveUrl, join(workspace, 'before-deletion.db'));
    await rm(livePath);

    await restoreSnapshot(snapshot.path, liveUrl);

    expect(await emailsIn(livePath)).toEqual(['first@example.test', 'second@example.test']);
  });

  it('keeps the database it replaced instead of deleting it', async () => {
    const snapshot = await createSnapshot(liveUrl, join(workspace, 'snap.db'));
    const client = createClient({ url: liveUrl });
    await client.execute("INSERT INTO users (email) VALUES ('written-after@example.test')");
    client.close();

    const { replacedKeptAt } = await restoreSnapshot(snapshot.path, liveUrl);

    // Restoring the wrong snapshot must not be the end of the story.
    expect(replacedKeptAt).toBeTruthy();
    expect(await emailsIn(replacedKeptAt!)).toContain('written-after@example.test');
  });

  it('refuses a file that is not a database, before touching anything', async () => {
    const junk = join(workspace, 'not-a-database.db');
    await writeFile(junk, 'this is not sqlite');

    await expect(restoreSnapshot(junk, liveUrl)).rejects.toThrow(/not a usable open-alpha database/);
    // The live database is untouched: it was never renamed out of the way.
    expect(await emailsIn(livePath)).toEqual(['first@example.test', 'second@example.test']);
  });

  it('refuses a database missing the schema record, before touching anything', async () => {
    const strange = join(workspace, 'strange.db');
    const client = createClient({ url: `file:${strange}` });
    await client.execute('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
    client.close();

    await expect(restoreSnapshot(strange, liveUrl)).rejects.toThrow(/not a usable open-alpha database/);
    expect(await emailsIn(livePath)).toEqual(['first@example.test', 'second@example.test']);
  });

  it('survives a full round trip with the schema intact', async () => {
    const snapshot = await createSnapshot(liveUrl, join(workspace, 'round-trip.db'));
    await restoreSnapshot(snapshot.path, liveUrl);

    const after = await inspect(livePath);
    expect(after.migrations).toEqual(snapshot.migrations);
    expect(after.users).toBe(snapshot.users);
  });
});

describe('which databases can be snapshotted', () => {
  it('resolves a file url to a path', () => {
    expect(localPathFor('file:/data/open-alpha.db')).toBe('/data/open-alpha.db');
  });

  it('has no path for a remote url', () => {
    expect(localPathFor('libsql://example.turso.io')).toBeUndefined();
  });
});
