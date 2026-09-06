import { beforeEach, describe, expect, it } from 'vitest';
import { drawFromAuthoredItemBank, openAttempt, withoutAnswerKey } from '../api/_lib/assessment.js';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { selectMasteryItems, snapshotItem } from '../api/_lib/item-bank.js';
import type { MasteryQuestion } from '../api/_lib/curriculum.js';
import { POST as contributeLesson } from '../api/contribute/lesson.js';
import { createUser, resetDatabase } from './helpers/database.js';

function question(index: number, difficultyTag: 'easy' | 'medium' | 'hard' = 'medium'): MasteryQuestion {
  return {
    id: `item-${index}`,
    question: `What is the answer to item ${index}?`,
    options: ['A) one', 'B) two', 'C) three'],
    correctAnswer: 'B',
    explanation: 'Two is the expected answer.',
    difficultyTag,
    purpose: 'mastery',
    skillTag: 'number-sense',
    reasoningType: 'recognition',
    distractorRationale: {
      A: 'The learner counted one step too few.',
      C: 'The learner counted one step too many.',
    },
    pedagogicalRationale: 'Checks recognition without requiring calculation.',
  };
}

const pool = [
  question(1, 'easy'), question(2, 'easy'),
  question(3, 'medium'), question(4, 'medium'), question(5, 'medium'),
  question(6, 'hard'), question(7, 'hard'),
];

beforeEach(resetDatabase);

describe('mastery item pool', () => {
  it('draws exactly five distinct mastery items from a larger pool', () => {
    const selected = selectMasteryItems(
      pool.map(item => ({ question: item })),
      () => 0.25
    );

    expect(selected).toHaveLength(5);
    expect(new Set(selected.map(item => item.question.id)).size).toBe(5);
    expect(selected.every(item => pool.some(candidate => candidate.id === item.question.id))).toBe(true);
  });

  it('keeps the item hash stable and includes pedagogical metadata in it', () => {
    const first = snapshotItem(question(1));
    const same = snapshotItem({
      ...question(1),
      distractorRationale: { C: 'The learner counted one step too many.', A: 'The learner counted one step too few.' },
    });
    const changed = snapshotItem({ ...question(1), reasoningType: 'multi-step' });

    expect(first.contentHash).toBe(same.contentHash);
    expect(first.contentHash).not.toBe(changed.contentHash);
  });
});

describe('persisted item bank', () => {
  it('rejects an invalid pool before writing any item', async () => {
    const practiceOnly = pool.slice(0, 5).map(item => ({ ...item, purpose: 'practice' as const }));
    await expect(drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'invalid-pool', language: 'en', questions: practiceOnly,
    })).rejects.toThrow('at least five mastery items');

    const stored = await executeSql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM assessment_items WHERE concept_id = 'invalid-pool'`
    );
    expect(Number(stored.rows[0].count)).toBe(0);
  });

  it('accepts an authored lesson contribution with a pool larger than five', async () => {
    const response = await contributeLesson(new Request('https://test.local/api/contribute/lesson', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conceptId: 'math-fractions-intro',
        subjectId: 'math',
        contributorId: 'teacher@example.test',
        content: { masteryCheck: { questions: pool } },
      }),
    }));
    const body = await response.json() as { validation: { errors: string[] } };

    expect(response.status).toBe(201);
    expect(body.validation.errors).toEqual([]);
  });

  it('persists the whole pool with metadata while the attempt receives five', async () => {
    const selected = await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool, random: () => 0.5,
    });

    const stored = await executeSql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM assessment_items
       WHERE subject_id = 'math' AND concept_id = 'item-bank-test'`
    );
    const metadata = await executeSql<{ difficulty_tag: string; content_hash: string }>(
      `SELECT difficulty_tag, content_hash FROM assessment_items WHERE concept_id = 'item-bank-test'`
    );

    expect(selected).toHaveLength(5);
    expect(Number(stored.rows[0].count)).toBe(7);
    expect(metadata.rows).toHaveLength(7);
    expect(metadata.rows.every(row => row.content_hash.length === 64)).toBe(true);
  });

  it('deduplicates concurrent synchronization of the same authored pool', async () => {
    await Promise.all([
      drawFromAuthoredItemBank({
        subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
      }),
      drawFromAuthoredItemBank({
        subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
      }),
    ]);

    const stored = await executeSql<{ count: number; active: number }>(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
       FROM assessment_items WHERE concept_id = 'item-bank-test'`
    );
    expect(Number(stored.rows[0].count)).toBe(7);
    expect(Number(stored.rows[0].active)).toBe(7);
  });

  it('retires items removed from the current pool without changing attempt evidence', async () => {
    const studentId = await createUser('student');
    const selected = await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
      // No Fisher-Yates swaps: item-1 is guaranteed to be linked to the attempt.
      random: () => 0.999,
    });
    const opened = await openAttempt({
      studentId,
      subject: 'math',
      conceptId: 'item-bank-test',
      language: 'en',
      kind: 'mastery',
      source: 'authored',
      items: selected,
    });
    const original = await executeSql<{ id: number; stem: string }>(
      `SELECT id, stem FROM assessment_items
       WHERE concept_id = 'item-bank-test' AND authored_id = 'item-1'`
    );

    await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool.slice(1),
    });

    const removed = await executeSql<{ id: number; status: string; stem: string }>(
      `SELECT id, status, stem FROM assessment_items
       WHERE concept_id = 'item-bank-test' AND authored_id = 'item-1'`
    );
    const evidence = await executeSql<{ item_id: number; stem: string; status: string }>(
      `SELECT ai.item_id, i.stem, i.status
       FROM assessment_attempt_items ai
       JOIN assessment_items i ON i.id = ai.item_id
       WHERE ai.attempt_id = $1 AND i.authored_id = 'item-1'`,
      [opened.attemptId]
    );
    const activeIds = await executeSql<{ authored_id: string }>(
      `SELECT authored_id FROM assessment_items
       WHERE concept_id = 'item-bank-test' AND status = 'active'
       ORDER BY authored_id`
    );

    expect(removed.rows).toEqual([{
      id: original.rows[0].id,
      status: 'retired',
      stem: original.rows[0].stem,
    }]);
    expect(evidence.rows).toEqual([{
      item_id: original.rows[0].id,
      stem: original.rows[0].stem,
      status: 'retired',
    }]);
    expect(activeIds.rows.map(row => row.authored_id)).toEqual(
      pool.slice(1).map(item => item.id)
    );
  });

  it('rolls back version changes and retirement when a pool synchronization fails', async () => {
    await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
    });
    const invalidPool = [
      { ...pool[0], question: 'A changed stem that must roll back.' },
      // item-7 is absent, so a successful synchronization would retire it.
      ...pool.slice(1, -1),
      { ...question(8), difficultyTag: 'impossible' as any },
    ];

    await expect(drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: invalidPool,
    })).rejects.toThrow();

    const state = await executeSql<{ authored_id: string; version: number; status: string }>(
      `SELECT authored_id, version, status FROM assessment_items
       WHERE concept_id = 'item-bank-test' ORDER BY authored_id, version`
    );
    expect(state.rows).toHaveLength(7);
    expect(state.rows.every(row => Number(row.version) === 1 && row.status === 'active')).toBe(true);
  });

  it('serializes concurrent pool replacements and leaves one complete pool active', async () => {
    const withoutFirst = pool.slice(1);
    const withoutSecond = pool.filter(item => item.id !== 'item-2');

    await Promise.all([
      drawFromAuthoredItemBank({
        subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: withoutFirst,
      }),
      drawFromAuthoredItemBank({
        subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: withoutSecond,
      }),
    ]);

    const active = await executeSql<{ authored_id: string }>(
      `SELECT authored_id FROM assessment_items
       WHERE concept_id = 'item-bank-test' AND status = 'active'
       ORDER BY authored_id`
    );
    const duplicateActive = await executeSql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM (
         SELECT authored_id FROM assessment_items
         WHERE concept_id = 'item-bank-test' AND status = 'active'
         GROUP BY authored_id HAVING COUNT(*) > 1
       )`
    );
    expect(active.rows.map(row => row.authored_id)).toEqual(
      withoutSecond.map(item => item.id)
    );
    expect(Number(duplicateActive.rows[0].count)).toBe(0);
  });

  it('resumes a partial backfill and preserves identical legacy duplicates', async () => {
    const legacyQuestion: MasteryQuestion = {
      id: 'legacy-1',
      question: 'Legacy stem',
      options: ['A) no', 'B) yes'],
      correctAnswer: 'B',
      explanation: 'Because yes.',
    };
    const firstHash = snapshotItem(legacyQuestion).contentHash;
    await executeSql(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, authored_id, stem, options,
          correct_answer, explanation, content_hash, version, status)
       VALUES ('math', 'legacy-concept', 'en', 'authored', 'legacy-1',
               'Legacy stem', '["A) no","B) yes"]', 'B', 'Because yes.', $1, 1, 'retired')`,
      [firstHash]
    );
    await executeSql(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, authored_id, stem, options,
          correct_answer, explanation, content_hash, version, status)
       VALUES ('math', 'legacy-concept', 'en', 'authored', 'legacy-1',
               'Legacy stem', '["A) no","B) yes"]', 'B', 'Because yes.', NULL, 2, 'active')`
    );

    // An interrupted migration is never recorded, so it resumes on the next
    // start — which is exactly the state this row is standing in for.
    await executeSql("DELETE FROM _schema_migrations WHERE id = '002-assessment-item-bank'");
    await initializeSchema();
    const migrated = await executeSql<{ content_hash: string; version: number; status: string }>(
      `SELECT content_hash, version, status FROM assessment_items
       WHERE authored_id = 'legacy-1' ORDER BY version`
    );
    expect(migrated.rows).toHaveLength(2);
    expect(migrated.rows.map(row => Number(row.version))).toEqual([1, 2]);
    expect(new Set(migrated.rows.map(row => row.content_hash))).toEqual(new Set([firstHash]));
    expect(migrated.rows.map(row => row.status)).toEqual(['retired', 'active']);
  });

  it('reuses an unchanged snapshot and versions a changed authored item', async () => {
    await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
    });
    await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
    });

    let stored = await executeSql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM assessment_items WHERE concept_id = 'item-bank-test'`
    );
    expect(Number(stored.rows[0].count)).toBe(7);

    const edited = pool.map(item => item.id === 'item-1'
      ? { ...item, question: 'This stem changed without changing its authored id.' }
      : item);
    await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: edited,
    });

    stored = await executeSql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM assessment_items WHERE concept_id = 'item-bank-test'`
    );
    const versions = await executeSql<{ stem: string; version: number; status: string }>(
      `SELECT stem, version, status
       FROM assessment_items WHERE authored_id = 'item-1' ORDER BY version`
    );

    expect(Number(stored.rows[0].count)).toBe(8);
    expect(versions.rows.map(row => Number(row.version))).toEqual([1, 2]);
    expect(versions.rows.map(row => row.status)).toEqual(['retired', 'active']);
    expect(versions.rows[0].stem).toBe(pool[0].question);

    // Reverting content reuses the identical immutable snapshot rather than
    // creating a duplicate row with the same hash.
    await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
    });
    const afterRevert = await executeSql<{ version: number; status: string }>(
      `SELECT version, status
       FROM assessment_items WHERE authored_id = 'item-1' ORDER BY version`
    );
    expect(afterRevert.rows.map(row => Number(row.version))).toEqual([1, 2]);
    expect(afterRevert.rows.map(row => row.status)).toEqual(['active', 'retired']);

    await initializeSchema();
    const afterRestart = await executeSql<{ version: number; status: string }>(
      `SELECT version, status FROM assessment_items
       WHERE authored_id = 'item-1' ORDER BY version`
    );
    expect(afterRestart.rows.map(row => row.status)).toEqual(['active', 'retired']);
  });

  it('records the selected snapshots on an attempt without leaking internal metadata', async () => {
    const studentId = await createUser('student');
    const selected = await drawFromAuthoredItemBank({
      subject: 'math', conceptId: 'item-bank-test', language: 'en', questions: pool,
    });
    const opened = await openAttempt({
      studentId,
      subject: 'math',
      conceptId: 'item-bank-test',
      language: 'en',
      kind: 'mastery',
      source: 'authored',
      items: selected,
    });

    const evidence = await executeSql<{ version: number; content_hash: string }>(
      `SELECT i.version, i.content_hash
       FROM assessment_attempt_items ai
       JOIN assessment_items i ON i.id = ai.item_id
       WHERE ai.attempt_id = $1`,
      [opened.attemptId]
    );
    const browserPayload = JSON.stringify(opened.items.map(withoutAnswerKey));

    expect(evidence.rows).toHaveLength(5);
    expect(evidence.rows.every(row => Number(row.version) === 1)).toBe(true);
    expect(browserPayload).not.toContain('correctAnswer');
    expect(browserPayload).not.toContain('distractorRationale');
    expect(browserPayload).not.toContain('contentHash');
  });
});
