/**
 * The curriculum moved from files to the database so it can be authored at
 * runtime. The only thing that must not change is what the engine reads, so
 * these tests compare the two sources directly.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import {
  type Subject,
  importCurriculumFromFiles,
  loadSubjectsFromDatabase,
  loadSubjectsFromFiles,
} from '../api/_lib/curriculum.js';
import { resetDatabase } from './helpers/database.js';

function sortSubjects(subjects: Subject[]): Subject[] {
  return [...subjects]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(subject => ({
      ...subject,
      concepts: [...subject.concepts].sort((a, b) => a.id.localeCompare(b.id)),
    }));
}

async function clearCurriculumTables() {
  await executeSql('DELETE FROM curriculum_concepts');
  await executeSql('DELETE FROM curriculum_subjects');
}

beforeEach(async () => {
  await resetDatabase();
  await clearCurriculumTables();
});

/**
 * Every other test file loads the curriculum when it imports curriculum.js —
 * before any beforeEach of its own runs — so whatever this file leaves in the
 * database is what they will read. Leaving it empty keeps them on the files,
 * which is the state they were written against.
 */
afterAll(clearCurriculumTables);

describe('curriculum source parity', () => {
  it('reads back from the database exactly what the files define', async () => {
    // The whole safety argument for the refactor: same graph, same content,
    // different storage.
    await importCurriculumFromFiles();

    const fromFiles = sortSubjects(loadSubjectsFromFiles());
    const fromDatabase = sortSubjects(await loadSubjectsFromDatabase());

    expect(fromDatabase).toEqual(fromFiles);
  });

  it('preserves the enriched bundle, not just the graph', async () => {
    await importCurriculumFromFiles();

    const fromDatabase = await loadSubjectsFromDatabase();
    const fractions = fromDatabase
      .find(subject => subject.id === 'math')
      ?.concepts.find(concept => concept.id === 'math-fractions-intro');

    expect(fractions?.explanation?.text).toBeTruthy();
    expect(fractions?.workedExamples?.length).toBeGreaterThan(0);
    expect(fractions?.masteryCheck?.questions).toHaveLength(5);
    expect(fractions?.remediationPath?.action).toBe('simpler_explanation');
  });

  it('is empty before anything is imported, which is what triggers the fallback', async () => {
    expect(await loadSubjectsFromDatabase()).toEqual([]);
  });

  it('can be re-run without duplicating anything', async () => {
    const first = await importCurriculumFromFiles();
    const second = await importCurriculumFromFiles();

    // The second run recognises every concept as already published.
    expect(first.created).toBe(first.concepts);
    expect(second.concepts).toBe(0);
    expect(second.unchanged).toBe(first.created);

    const count = await executeSql<{ total: number }>(
      'SELECT COUNT(*) as total FROM curriculum_concepts'
    );
    expect(Number(count.rows[0].total)).toBe(first.concepts);
  });

  it('leaves the version alone when the import changes nothing', async () => {
    // Version answers "what did the students see last term?". Bumping it on
    // every import made it count imports instead of changes.
    await importCurriculumFromFiles();
    await importCurriculumFromFiles();

    const row = await executeSql<{ version: number; updated_at: string }>(
      'SELECT version, updated_at FROM curriculum_concepts WHERE concept_id = $1',
      ['math-fractions-intro']
    );

    expect(row.rows[0].version).toBe(1);
  });

  it('bumps the version when the stored content actually differs', async () => {
    await importCurriculumFromFiles();
    await executeSql(
      `UPDATE curriculum_concepts SET name = 'Edited elsewhere', content_hash = 'stale'
       WHERE concept_id = $1`,
      ['math-fractions-intro']
    );

    const result = await importCurriculumFromFiles();

    const row = await executeSql<{ version: number; name: string }>(
      'SELECT version, name FROM curriculum_concepts WHERE concept_id = $1',
      ['math-fractions-intro']
    );

    expect(result.updated).toBe(1);
    expect(row.rows[0].version).toBe(2);
    expect(row.rows[0].name).not.toBe('Edited elsewhere');
  });

  it('hides unpublished concepts from the engine', async () => {
    await importCurriculumFromFiles();
    await executeSql(
      `UPDATE curriculum_concepts SET status = 'draft' WHERE concept_id = $1`,
      ['math-fractions-intro']
    );

    const mathConcepts = (await loadSubjectsFromDatabase())
      .find(subject => subject.id === 'math')!
      .concepts.map(concept => concept.id);

    expect(mathConcepts).not.toContain('math-fractions-intro');
  });

  it('hides an unpublished subject entirely', async () => {
    await importCurriculumFromFiles();
    await executeSql(`UPDATE curriculum_subjects SET status = 'draft' WHERE id = 'math'`);

    const ids = (await loadSubjectsFromDatabase()).map(subject => subject.id);
    expect(ids).not.toContain('math');
  });
});
