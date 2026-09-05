/**
 * One damaged concept should cost one concept.
 *
 * `prerequisites` and `content` are JSON blobs and JSON.parse throws, so a
 * single corrupted row used to fail the whole read — and the caller, seeing a
 * failed read, replaced the entire published curriculum with the seed files.
 * A record that cannot be trusted is now skipped, counted and named.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import {
  conceptContentHash,
  importCurriculumFromFiles,
  readCurriculumFromDatabase,
} from '../api/_lib/curriculum.js';
import { parseConceptRecord } from '../api/_lib/curriculum-record.js';
import { resetDatabase } from './helpers/database.js';

const FRACTIONS = 'math-fractions-intro';

async function clearCurriculumTables() {
  await executeSql('DELETE FROM curriculum_concepts');
  await executeSql('DELETE FROM curriculum_subjects');
}

beforeEach(async () => {
  await resetDatabase();
  await clearCurriculumTables();
});

afterAll(clearCurriculumTables);

/** Rewrites one stored concept's content, as a corrupted row would read. */
async function corrupt(conceptId: string, column: 'content' | 'prerequisites', value: string) {
  await executeSql(
    `UPDATE curriculum_concepts SET ${column} = $1 WHERE concept_id = $2`,
    [value, conceptId]
  );
}

async function mathConceptIds(): Promise<string[]> {
  const { subjects } = await readCurriculumFromDatabase();
  return subjects.find(subject => subject.id === 'math')!.concepts.map(concept => concept.id);
}

describe('reading a corrupted record', () => {
  it('drops the broken concept and keeps the rest of the curriculum', async () => {
    await importCurriculumFromFiles();
    await corrupt(FRACTIONS, 'content', '{ not json');

    const { subjects, problems } = await readCurriculumFromDatabase();

    expect(problems).toHaveLength(1);
    expect(problems[0].conceptId).toBe(FRACTIONS);
    expect(problems[0].code).toBe('invalid_json');
    // The point of the whole change: everything else still loads.
    expect(subjects.length).toBeGreaterThan(1);
    expect(await mathConceptIds()).not.toContain(FRACTIONS);
  });

  it('rejects prerequisites that are not a list of concept ids', async () => {
    await importCurriculumFromFiles();
    await corrupt(FRACTIONS, 'prerequisites', '{"was":"an object"}');

    const { problems } = await readCurriculumFromDatabase();

    expect(problems[0].code).toBe('invalid_field');
    expect(problems[0].detail).toContain('prerequisites');
  });

  it('rejects a mastery check whose answer matches no option', async () => {
    // The failure nothing else would catch: the question renders, the student
    // answers, and every answer is wrong — which the engine reads as a gap and
    // answers by sending them back to a prerequisite they already know.
    await importCurriculumFromFiles();
    await corrupt(
      FRACTIONS,
      'content',
      JSON.stringify({
        masteryCheck: {
          passingScore: 80,
          questions: [
            { question: 'What is 1/2 of 8?', options: ['A) 2', 'B) 4'], correctAnswer: 'E' },
          ],
        },
      })
    );

    const { problems } = await readCurriculumFromDatabase();

    expect(problems[0].code).toBe('invalid_mastery_check');
    expect(problems[0].detail).toContain('matches none');
  });

  it('accepts both answer conventions the content actually uses', () => {
    const byLabel = parseConceptRecord({
      subject_id: 'math', concept_id: 'c', name: 'C', description: null, level: 1,
      prerequisites: '[]',
      content: JSON.stringify({
        masteryCheck: { questions: [{ question: 'q', options: ['A) one', 'B) two'], correctAnswer: 'B' }] },
      }),
    });
    const byText = parseConceptRecord({
      subject_id: 'math', concept_id: 'c', name: 'C', description: null, level: 1,
      prerequisites: '[]',
      content: JSON.stringify({
        masteryCheck: { questions: [{ question: 'q', options: ['one', 'two'], correctAnswer: 'two' }] },
      }),
    });

    expect('record' in byLabel).toBe(true);
    expect('record' in byText).toBe(true);
  });

  it('rejects a remediation that sends the student nowhere', async () => {
    await importCurriculumFromFiles();
    await corrupt(FRACTIONS, 'content', JSON.stringify({ remediationPath: { action: 'sub_skill' } }));

    const { problems } = await readCurriculumFromDatabase();

    expect(problems[0].code).toBe('invalid_field');
    expect(problems[0].detail).toContain('names no concept');
  });

  it('reports every bad record, not just the first', async () => {
    await importCurriculumFromFiles();
    await corrupt(FRACTIONS, 'content', 'not json');
    await corrupt('math-decimals', 'content', 'also not json');

    const { problems } = await readCurriculumFromDatabase();

    expect(problems.map(problem => problem.conceptId).sort()).toEqual(['math-decimals', FRACTIONS].sort());
  });
});

describe('content hash', () => {
  it('ignores the order the author happened to write the keys in', () => {
    const a = conceptContentHash({
      name: 'Fractions', description: 'd', gradeLevel: 3,
      prerequisites: ['a', 'b'],
      content: { objective: 'o', whyItMatters: 'w' },
    });
    const b = conceptContentHash({
      name: 'Fractions', description: 'd', gradeLevel: 3,
      prerequisites: ['b', 'a'],
      content: { whyItMatters: 'w', objective: 'o' },
    });

    expect(a).toBe(b);
  });

  it('changes when the content changes', () => {
    const before = conceptContentHash({
      name: 'Fractions', description: 'd', gradeLevel: 3, prerequisites: [], content: { objective: 'o' },
    });
    const after = conceptContentHash({
      name: 'Fractions', description: 'd', gradeLevel: 3, prerequisites: [], content: { objective: 'o2' },
    });

    expect(before).not.toBe(after);
  });
});

describe('transactional import', () => {
  it('leaves no half-imported curriculum when a write partway through fails', async () => {
    // Rebuild the subjects table so that writing 'math' fails. The import
    // writes subject by subject, so by the time it gets there it has already
    // written whole subjects — exactly the half-old, half-new state that used
    // to survive an interrupted import.
    await executeSql('DROP TABLE curriculum_subjects');
    await executeSql(`CREATE TABLE curriculum_subjects (
      id TEXT PRIMARY KEY CHECK (id <> 'math'),
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    try {
      await expect(importCurriculumFromFiles()).rejects.toThrow();

      const subjects = await executeSql<{ total: number }>('SELECT COUNT(*) as total FROM curriculum_subjects');
      const concepts = await executeSql<{ total: number }>('SELECT COUNT(*) as total FROM curriculum_concepts');

      expect(Number(subjects.rows[0].total)).toBe(0);
      expect(Number(concepts.rows[0].total)).toBe(0);
    } finally {
      await executeSql('DROP TABLE curriculum_subjects');
      await initializeSchema();
    }
  });

  it('imports everything once the obstacle is gone', async () => {
    const result = await importCurriculumFromFiles();

    expect(result.created).toBeGreaterThan(0);
    const concepts = await executeSql<{ total: number }>('SELECT COUNT(*) as total FROM curriculum_concepts');
    expect(Number(concepts.rows[0].total)).toBe(result.created);
  });
});
