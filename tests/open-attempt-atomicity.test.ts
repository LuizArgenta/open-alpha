/**
 * `openAttempt` used to write the attempt row and each of its item links as
 * separate statements. A failure partway left an attempt that existed with
 * only some of its links — the dangerous shape, because the score divides by
 * `COUNT(*)` over `assessment_attempt_items`: a link that never landed shrinks
 * the denominator and silently inflates the mark.
 *
 * Also covers `withTransaction`, the callback-scoped transaction this needed.
 * `executeTransaction` takes a prepared list and cannot hand back the attempt
 * id its own INSERT produced, which is why the variant exists at all.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, withTransaction } from '../api/_lib/db.js';
import { openAttempt } from '../api/_lib/assessment.js';
import { createUser, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

function itemsFor(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    conceptId: CONCEPT,
    question: {
      question: `Question ${index}`,
      options: ['A', 'B', 'C', 'D'],
      correctAnswer: 'A',
    },
  }));
}

async function countRows(table: string): Promise<number> {
  const result = await executeSql<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`);
  return Number(result.rows[0].total);
}

let studentId: number;

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
});

describe('withTransaction', () => {
  it('returns what the callback returns, and commits its writes', async () => {
    const attemptId = await withTransaction(async scope => {
      const inserted = await scope.run<{ id: number }>(
        `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, kind)
         VALUES ($1, $2, $3, 'en', 'mastery') RETURNING id`,
        [studentId, SUBJECT, CONCEPT]
      );
      return inserted.rows[0].id;
    });

    expect(attemptId).toBeGreaterThan(0);
    expect(await countRows('assessment_attempts')).toBe(1);
  });

  it('lets a later statement depend on what an earlier one returned', async () => {
    // The whole reason this variant exists: executeTransaction's prepared list
    // has no way to reference an id that only exists once the INSERT has run.
    await withTransaction(async scope => {
      const attempt = await scope.run<{ id: number }>(
        `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, kind)
         VALUES ($1, $2, $3, 'en', 'mastery') RETURNING id`,
        [studentId, SUBJECT, CONCEPT]
      );
      const item = await scope.run<{ id: number }>(
        `INSERT INTO assessment_items (subject_id, concept_id, source, stem, options, correct_answer)
         VALUES ($1, $2, 'generated', 'stem', '[]', 'A') RETURNING id`,
        [SUBJECT, CONCEPT]
      );
      await scope.run(
        'INSERT INTO assessment_attempt_items (attempt_id, item_id, position) VALUES ($1, $2, 0)',
        [attempt.rows[0].id, item.rows[0].id]
      );
    });

    expect(await countRows('assessment_attempt_items')).toBe(1);
  });

  it('rolls back every write when the callback throws', async () => {
    await expect(
      withTransaction(async scope => {
        await scope.run(
          `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, kind)
           VALUES ($1, $2, $3, 'en', 'mastery')`,
          [studentId, SUBJECT, CONCEPT]
        );
        throw new Error('interrupted halfway');
      })
    ).rejects.toThrow('interrupted halfway');

    expect(await countRows('assessment_attempts')).toBe(0);
  });

  it('rolls back when a statement itself fails, and surfaces the error', async () => {
    await expect(
      withTransaction(async scope => {
        await scope.run(
          `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, kind)
           VALUES ($1, $2, $3, 'en', 'mastery')`,
          [studentId, SUBJECT, CONCEPT]
        );
        // item_id references a row that does not exist.
        await scope.run(
          'INSERT INTO assessment_attempt_items (attempt_id, item_id, position) VALUES (999999, 999999, 0)'
        );
      })
    ).rejects.toThrow();

    expect(await countRows('assessment_attempts')).toBe(0);
  });

  it('binds $N by number inside the transaction, like executeSql does', async () => {
    await withTransaction(async scope => {
      // $2 written before $1: order-of-appearance binding would swap them.
      await scope.run(
        `INSERT INTO assessment_attempts (concept_id, student_id, subject, language, kind)
         VALUES ($2, $1, $3, 'en', 'mastery')`,
        [studentId, CONCEPT, SUBJECT]
      );
    });

    const row = await executeSql<{ student_id: number; concept_id: string }>(
      'SELECT student_id, concept_id FROM assessment_attempts'
    );
    expect(row.rows[0]).toEqual({ student_id: studentId, concept_id: CONCEPT });
  });
});

describe('openAttempt atomicity', () => {
  it('links every item it was given', async () => {
    const opened = await openAttempt({
      studentId,
      subject: SUBJECT,
      conceptId: CONCEPT,
      language: 'en',
      kind: 'mastery',
      source: 'generated',
      items: itemsFor(5),
    });

    const links = await executeSql<{ total: number }>(
      'SELECT COUNT(*) AS total FROM assessment_attempt_items WHERE attempt_id = $1',
      [opened.attemptId]
    );
    expect(Number(links.rows[0].total)).toBe(5);
  });

  it('refuses to open an attempt with no items', async () => {
    await expect(
      openAttempt({
        studentId,
        subject: SUBJECT,
        conceptId: CONCEPT,
        language: 'en',
        kind: 'mastery',
        source: 'generated',
        items: [],
      })
    ).rejects.toThrow(/no items/);

    expect(await countRows('assessment_attempts')).toBe(0);
  });

  it('never leaves an attempt whose links are incomplete', async () => {
    // Two authored items with the same id and the same content resolve to one
    // stored snapshot, so the second link collides with
    // assessment_attempt_items' PRIMARY KEY (attempt_id, item_id) — a genuine
    // failure partway through the link loop, reached through openAttempt
    // itself rather than a hand-rolled imitation of it. Before the attempt row
    // and its links shared a transaction, this left an attempt behind holding
    // a single link, and the score would then have divided by 1 instead of 2.
    const duplicated = {
      conceptId: CONCEPT,
      authoredId: 'q1',
      question: { question: 'Same', options: ['A', 'B'], correctAnswer: 'A' },
    };

    await expect(
      openAttempt({
        studentId,
        subject: SUBJECT,
        conceptId: CONCEPT,
        language: 'en',
        kind: 'mastery',
        source: 'authored',
        items: [duplicated, { ...duplicated }],
      })
    ).rejects.toThrow();

    expect(await countRows('assessment_attempts')).toBe(0);
    expect(await countRows('assessment_attempt_items')).toBe(0);
  });
});
