/**
 * Schema changes used to run inside a `catch {}` that discarded every
 * exception as "the column is already there" — including permission,
 * connection, corruption and constraint errors. A database that could not be
 * migrated came up looking healthy and started serving students against a
 * schema missing pieces, and nothing anywhere could be asked about it.
 *
 * They are now a recorded, append-only registry: each runs at most once, a
 * failure stops the run rather than letting later migrations build on a step
 * that did not happen, and `/api/health/schema` answers 503 while that is
 * true.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema, schemaStatus } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { GET as schemaHealth } from '../api/health/schema.js';
import { createUser, forgetMigration, resetDatabase } from './helpers/database.js';

function get(token?: string): Request {
  return new Request('https://test.local/api/health/schema', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function recordedMigrations(): Promise<string[]> {
  const rows = await executeSql<{ id: string }>(
    'SELECT id FROM _schema_migrations ORDER BY id'
  );
  return rows.rows.map(row => row.id);
}

beforeEach(async () => {
  await resetDatabase();
});

describe('the migration registry', () => {
  it('records every migration it applies', async () => {
    const recorded = await recordedMigrations();
    expect(recorded).toContain('001-legacy-columns-and-tables');
    expect(recorded).toContain('002-assessment-item-bank');
    expect(recorded).toContain('005-xp-awards-attempt-id');
  });

  it('does not run a migration twice', async () => {
    schemaStatus.applied.length = 0;
    await initializeSchema();
    // Nothing new to apply on a database already at the current version.
    expect(schemaStatus.applied).toEqual([]);
    expect(schemaStatus.ready).toBe(true);
  });

  it('reapplies a migration whose record is gone, and records it again', async () => {
    await forgetMigration('005-xp-awards-attempt-id');
    expect(await recordedMigrations()).not.toContain('005-xp-awards-attempt-id');

    schemaStatus.applied.length = 0;
    await initializeSchema();

    expect(schemaStatus.applied).toEqual(['005-xp-awards-attempt-id']);
    expect(await recordedMigrations()).toContain('005-xp-awards-attempt-id');
  });

  it('leaves an interrupted migration unrecorded, so the next start retries it', async () => {
    // A record is written only after the migration resolves. Nothing here can
    // interrupt one mid-flight, so this asserts the ordering that guarantees
    // it: no id is recorded that its migration did not finish for.
    await forgetMigration('004-assessment-responses-unique');
    expect(await recordedMigrations()).not.toContain('004-assessment-responses-unique');

    await initializeSchema();
    expect(await recordedMigrations()).toContain('004-assessment-responses-unique');
  });
});

describe('errors are no longer swallowed', () => {
  it('tolerates only "duplicate column name" among additive statements', async () => {
    // The legacy batch is all ADD COLUMN and CREATE TABLE IF NOT EXISTS, so on
    // a database that already has them it must succeed by tolerating exactly
    // that one error — and nothing else.
    await forgetMigration('001-legacy-columns-and-tables');
    await expect(initializeSchema()).resolves.not.toThrow();
    expect(schemaStatus.ready).toBe(true);
  });

  it('fails loudly, naming the migration, when one cannot be applied', async () => {
    await forgetMigration('005-xp-awards-attempt-id');
    // A table the migration needs, replaced by something it cannot alter.
    await executeSql('DROP TABLE xp_awards');
    await executeSql('CREATE VIEW xp_awards AS SELECT 1 AS id');

    await expect(initializeSchema()).rejects.toThrow(/005-xp-awards-attempt-id/);
    expect(schemaStatus.ready).toBe(false);
    expect(schemaStatus.failed).toBe('005-xp-awards-attempt-id');
    expect(schemaStatus.error).toBeTruthy();

    // Not recorded, so a corrected deployment retries it instead of skipping.
    expect(await recordedMigrations()).not.toContain('005-xp-awards-attempt-id');

    await executeSql('DROP VIEW xp_awards');
  });
});

describe('GET /api/health/schema', () => {
  it('answers 200 once the schema is migrated', async () => {
    await initializeSchema();
    const studentId = await createUser('student');
    const response = await schemaHealth(get(signToken({ userId: studentId, role: 'student' })));

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; checkedAt: string };
    expect(body.ok).toBe(true);
    expect(body.checkedAt).toBeTruthy();
  });

  it('answers 503 while a migration is unfinished', async () => {
    const studentId = await createUser('student');
    const token = signToken({ userId: studentId, role: 'student' });

    await forgetMigration('005-xp-awards-attempt-id');
    await executeSql('DROP TABLE xp_awards');
    await executeSql('CREATE VIEW xp_awards AS SELECT 1 AS id');
    await expect(initializeSchema()).rejects.toThrow();

    const response = await schemaHealth(get(token));
    expect(response.status).toBe(503);
    const body = await response.json() as { ok: boolean; failedMigration: string };
    expect(body.ok).toBe(false);
    expect(body.failedMigration).toBe('005-xp-awards-attempt-id');

    await executeSql('DROP VIEW xp_awards');
  });

  /**
   * This used to assert 401, which was wrong and quietly disabled the
   * container's healthcheck: that probe carries no credentials and reads the
   * status code, so it saw 401, decided "not 503, therefore up", and passed on
   * every instance — including one whose migration had failed, the single case
   * it exists to catch. The verdict is public now; what is withheld from an
   * anonymous caller is the diagnosis, asserted just below and in
   * tests/health-endpoint.test.ts.
   */
  it('gives an unauthenticated caller the verdict without the diagnosis', async () => {
    const response = await schemaHealth(get());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('keeps the underlying error for staff only', async () => {
    const studentId = await createUser('student');
    const staffId = await createUser('parent');
    await executeSql(
      "INSERT INTO staff_roles (user_id, role) VALUES ($1, 'admin')",
      [staffId]
    );

    await forgetMigration('005-xp-awards-attempt-id');
    await executeSql('DROP TABLE xp_awards');
    await executeSql('CREATE VIEW xp_awards AS SELECT 1 AS id');
    await expect(initializeSchema()).rejects.toThrow();

    const asStudent = await schemaHealth(get(signToken({ userId: studentId, role: 'student' })));
    const asStaff = await schemaHealth(get(signToken({ userId: staffId, role: 'parent' })));

    expect((await asStudent.json() as { error?: string }).error).toBeUndefined();
    expect((await asStaff.json() as { error?: string }).error).toBeTruthy();

    await executeSql('DROP VIEW xp_awards');
  });
});
