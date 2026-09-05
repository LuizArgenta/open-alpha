/**
 * Publishing has to reach the instances that are already running.
 *
 * The curriculum was read at cold start and never looked at again, so each
 * serverless instance served whatever happened to be published the moment it
 * booted. An admin could publish a concept, reload the page, see it listed —
 * and students on an older instance would go on not seeing it for hours, with
 * no error anywhere and no way to tell which students were affected.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import {
  curriculumStatus,
  importCurriculumFromFiles,
  publishedRevision,
  refreshCurriculum,
  subjects,
} from '../api/_lib/curriculum.js';
import { resetDatabase } from './helpers/database.js';

async function clearCurriculumTables() {
  await executeSql('DELETE FROM curriculum_concepts');
  await executeSql('DELETE FROM curriculum_subjects');
}

beforeEach(async () => {
  await resetDatabase();
  await clearCurriculumTables();
});

afterEach(async () => {
  delete process.env.CURRICULUM_REFRESH_SECONDS;
  await clearCurriculumTables();
  // Put the module-level graph back on the files, which is what every other
  // test file was written against.
  await refreshCurriculum({ force: true });
});

afterAll(clearCurriculumTables);

describe('published revision', () => {
  it('changes when a concept is published', async () => {
    const before = await publishedRevision();
    await importCurriculumFromFiles();

    expect(await publishedRevision()).not.toBe(before);
  });

  it('does not change when nothing was written', async () => {
    await importCurriculumFromFiles();
    const before = await publishedRevision();

    // A second import writes nothing, because nothing changed.
    await importCurriculumFromFiles();

    expect(await publishedRevision()).toBe(before);
  });

  it('changes when a subject is unpublished', async () => {
    await importCurriculumFromFiles();
    const before = await publishedRevision();

    await executeSql(`UPDATE curriculum_subjects SET status = 'draft' WHERE id = 'math'`);

    expect(await publishedRevision()).not.toBe(before);
  });
});

describe('refreshing a running instance', () => {
  it('picks up a curriculum published after this instance started', async () => {
    // The instance booted with no curriculum in the database, so it is on the
    // files — the exact situation the refresh has to be able to leave.
    expect(curriculumStatus.origin).toBe('files');

    await importCurriculumFromFiles();
    const changed = await refreshCurriculum({ force: true });

    expect(changed).toBe(true);
    expect(curriculumStatus.origin).toBe('database');
    expect(curriculumStatus.degraded).toBe(false);
  });

  it('updates the array the endpoints already hold, not a new one', async () => {
    // Endpoints import `subjects` directly; replacing the binding would leave
    // every one of them pointing at the old graph.
    const held = subjects;
    await importCurriculumFromFiles();
    await refreshCurriculum({ force: true });

    expect(held).toBe(subjects);
    expect(held.length).toBeGreaterThan(0);
  });

  it('does not rebuild when the revision has not moved', async () => {
    await importCurriculumFromFiles();
    await refreshCurriculum({ force: true });

    expect(await refreshCurriculum({ force: true })).toBe(false);
  });

  it('holds off on checking again inside the throttle window', async () => {
    await importCurriculumFromFiles();

    // The default window has not elapsed since the instance loaded.
    expect(await refreshCurriculum()).toBe(false);
    expect(curriculumStatus.origin).toBe('files');
  });

  it('checks on every read when the window is set to zero', async () => {
    process.env.CURRICULUM_REFRESH_SECONDS = '0';
    await importCurriculumFromFiles();

    expect(await refreshCurriculum()).toBe(true);
    expect(curriculumStatus.origin).toBe('database');
  });

  it('keeps serving the curriculum it has when a check fails', async () => {
    await importCurriculumFromFiles();
    await refreshCurriculum({ force: true });
    const conceptCount = curriculumStatus.concepts;

    await executeSql('DROP TABLE curriculum_concepts');
    try {
      await refreshCurriculum({ force: true });

      // Still serving what it had, and saying why it could not check.
      expect(curriculumStatus.concepts).toBe(conceptCount);
      expect(curriculumStatus.refreshError).toBeTruthy();
      expect(subjects.length).toBeGreaterThan(0);
    } finally {
      const { initializeSchema } = await import('../api/_lib/db.js');
      await initializeSchema();
    }
  });

  it('records when it last checked, so a stale instance can be identified', async () => {
    const before = curriculumStatus.checkedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    await refreshCurriculum({ force: true });

    expect(curriculumStatus.checkedAt >= before).toBe(true);
  });
});
