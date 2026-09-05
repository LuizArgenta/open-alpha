/**
 * The fallback to the JSON files is legitimate. Doing it in silence is not.
 *
 * A database failure in production used to serve the seed files with no
 * outward sign: every page renders, every quiz works, and the trees an admin
 * authored at runtime are simply gone. A crash gets noticed in minutes; this
 * ran indefinitely.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import {
  CurriculumUnavailableError,
  importCurriculumFromFiles,
  resolveCurriculum,
} from '../api/_lib/curriculum.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';
import { GET as curriculumHealth } from '../api/health/curriculum.js';

async function clearCurriculumTables() {
  await executeSql('DELETE FROM curriculum_concepts');
  await executeSql('DELETE FROM curriculum_subjects');
}

/** The database is there and answers, but not with a curriculum. */
async function breakCurriculumTables() {
  await executeSql('DROP TABLE curriculum_concepts');
  await executeSql('DROP TABLE curriculum_subjects');
}

beforeEach(async () => {
  await resetDatabase();
  await clearCurriculumTables();
});

afterEach(async () => {
  delete process.env.CURRICULUM_REQUIRE_DATABASE;
  await initializeSchema();
});

// Same reason as curriculum-source.test.ts: every other file loads the
// curriculum at import, so this one must not leave rows behind.
afterAll(clearCurriculumTables);

describe('curriculum load status', () => {
  it('reports the database as the source when it has a published curriculum', async () => {
    await importCurriculumFromFiles();

    const { status, loaded } = await resolveCurriculum();

    expect(status.origin).toBe('database');
    expect(status.degraded).toBe(false);
    expect(status.reason).toBeUndefined();
    expect(status.subjects).toBe(loaded.length);
    expect(status.concepts).toBeGreaterThan(0);
  });

  it('marks an empty database as degraded rather than treating files as normal', async () => {
    const { status, loaded } = await resolveCurriculum();

    expect(status.origin).toBe('files');
    expect(status.degraded).toBe(true);
    expect(status.reason).toBe('database_empty');
    // Still serves something: a fresh install has to be able to boot.
    expect(loaded.length).toBeGreaterThan(0);
  });

  it('reports an unreadable database as an error, not as an empty one', async () => {
    await breakCurriculumTables();

    const { status } = await resolveCurriculum();

    expect(status.origin).toBe('files');
    expect(status.degraded).toBe(true);
    expect(status.reason).toBe('database_error');
    expect(status.error).toBeTruthy();
  });

  it('refuses to serve the files at all when the database is declared required', async () => {
    process.env.CURRICULUM_REQUIRE_DATABASE = 'true';
    await breakCurriculumTables();

    await expect(resolveCurriculum()).rejects.toBeInstanceOf(CurriculumUnavailableError);
  });

  it('treats a not-yet-imported database as unavailable under the same setting', async () => {
    process.env.CURRICULUM_REQUIRE_DATABASE = 'true';

    await expect(resolveCurriculum()).rejects.toBeInstanceOf(CurriculumUnavailableError);
  });

  it('serves normally under that setting once the curriculum is imported', async () => {
    process.env.CURRICULUM_REQUIRE_DATABASE = 'true';
    await importCurriculumFromFiles();

    const { status } = await resolveCurriculum();

    expect(status.degraded).toBe(false);
  });
});

describe('curriculum health endpoint', () => {
  function get(token?: string) {
    return curriculumHealth(
      new Request('https://test.local/api/health/curriculum', {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    );
  }

  it('does not answer to an anonymous caller', async () => {
    expect((await get()).status).toBe(401);
  });

  it('answers 503 while the instance is serving the files', async () => {
    // The suite runs with no curriculum in the database, so the module-level
    // load that this endpoint reports on is itself degraded.
    const studentId = await createUser('student');
    const response = await get(signToken({ userId: studentId, role: 'student' }));

    expect(response.status).toBe(503);
    const body = await response.json() as any;
    expect(body.ok).toBe(false);
    expect(body.origin).toBe('files');
    expect(body.reason).toBe('database_empty');
  });

  it('keeps the underlying failure away from students', async () => {
    const studentId = await createUser('student');
    const body = await (await get(signToken({ userId: studentId, role: 'student' }))).json() as any;

    expect(body.error).toBeUndefined();
  });
});
