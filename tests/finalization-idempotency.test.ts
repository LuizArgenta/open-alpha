/**
 * Two submissions of the same attempt, arriving together.
 *
 * The handler reads `finished_at` before it computes anything, so a second
 * submission can clear that check while the first is still working. Both would
 * then write: XP awarded twice, `progress.attempts` incremented twice, two sets
 * of decisions recorded as grounds for one piece of evidence. XP is the number
 * the student watches, so a double award is both wrong and visibly wrong.
 *
 * The attempt is now claimed by the first statement inside the transaction,
 * conditioned on it still being open, so exactly one submission proceeds.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { POST as answerQuiz } from '../api/tutor/quiz/answer.js';
import { POST as submitQuiz } from '../api/tutor/quiz/submit.js';
import { answerKey, callAs, createUser, openQuiz, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

let studentId: number;
let token: string;

/** Opens an attempt and answers every item correctly, without submitting. */
async function answeredAttempt(): Promise<number> {
  const quiz = await openQuiz(token, SUBJECT, CONCEPT);
  for (const question of quiz.questions) {
    await callAs(token, answerQuiz, {
      attemptId: quiz.attemptId,
      itemId: question.itemId,
      chosen: await answerKey(question.itemId),
      responseTimeMs: 25000,
    });
  }
  return quiz.attemptId;
}

async function countRows(table: string, attemptId?: number): Promise<number> {
  const result = attemptId === undefined
    ? await executeSql<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`)
    : await executeSql<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${table} WHERE attempt_id = $1`,
      [attemptId]
    );
  return Number(result.rows[0].total);
}

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
  token = signToken({ userId: studentId, role: 'student' });
});

describe('concurrent submission of one attempt', () => {
  it('lets exactly one of two simultaneous submissions through', async () => {
    const attemptId = await answeredAttempt();

    const responses = await Promise.all([
      callAs(token, submitQuiz, { attemptId }),
      callAs(token, submitQuiz, { attemptId }),
    ]);

    const statuses = responses.map(response => response.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('awards XP once, counts the attempt once, and records one set of decisions', async () => {
    const attemptId = await answeredAttempt();

    await Promise.all([
      callAs(token, submitQuiz, { attemptId }),
      callAs(token, submitQuiz, { attemptId }),
    ]);

    expect(await countRows('xp_awards')).toBe(1);
    expect(await countRows('xp_awards', attemptId)).toBe(1);

    const progress = await executeSql<{ attempts: number }>(
      'SELECT attempts FROM progress WHERE student_id = $1 AND concept_id = $2',
      [studentId, CONCEPT]
    );
    expect(progress.rows[0].attempts).toBe(1);

    // One diagnosis and one xp_award decision, not two of each.
    const decisions = await executeSql<{ kind: string; total: number }>(
      `SELECT kind, COUNT(*) AS total FROM learning_decisions
       WHERE student_id = $1 GROUP BY kind`,
      [studentId]
    );
    for (const row of decisions.rows) {
      expect(Number(row.total), `decisions of kind ${row.kind}`).toBe(1);
    }
  });

  it('holds under more than two simultaneous submissions', async () => {
    // Two can pass by luck of scheduling; five is a harder coincidence.
    const attemptId = await answeredAttempt();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => callAs(token, submitQuiz, { attemptId }))
    );

    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    expect(responses.filter(response => response.status === 409)).toHaveLength(4);
    expect(await countRows('xp_awards')).toBe(1);
  });

  it('refuses a resubmission that arrives after the first one finished', async () => {
    const attemptId = await answeredAttempt();

    const first = await callAs(token, submitQuiz, { attemptId });
    expect(first.status).toBe(200);

    const second = await callAs(token, submitQuiz, { attemptId });
    expect(second.status).toBe(409);
    expect(await countRows('xp_awards')).toBe(1);
  });

  it('does not let one student\'s attempt block another\'s', async () => {
    // The claim is per attempt, not per student: two learners submitting at
    // the same moment must both succeed.
    const otherId = await createUser('student');
    const otherToken = signToken({ userId: otherId, role: 'student' });

    const mine = await answeredAttempt();
    const theirs = await (async () => {
      const previous = token;
      token = otherToken;
      const attemptId = await answeredAttempt();
      token = previous;
      return attemptId;
    })();

    const responses = await Promise.all([
      callAs(token, submitQuiz, { attemptId: mine }),
      callAs(otherToken, submitQuiz, { attemptId: theirs }),
    ]);

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(await countRows('xp_awards')).toBe(2);
  });

  it('records the attempt each XP award came from', async () => {
    const attemptId = await answeredAttempt();
    await callAs(token, submitQuiz, { attemptId });

    const award = await executeSql<{ attempt_id: number }>(
      'SELECT attempt_id FROM xp_awards WHERE student_id = $1',
      [studentId]
    );
    expect(award.rows[0].attempt_id).toBe(attemptId);
  });

  it('refuses a second XP award for the same attempt at the database level', async () => {
    const attemptId = await answeredAttempt();
    await callAs(token, submitQuiz, { attemptId });

    // Defence in depth: even a code path that bypassed the claim entirely
    // cannot write a second award for this attempt.
    await expect(
      executeSql(
        `INSERT INTO xp_awards (student_id, subject, concept_id, attempt_id, amount, reason)
         VALUES ($1, $2, $3, $4, 10, 'duplicate')`,
        [studentId, SUBJECT, CONCEPT, attemptId]
      )
    ).rejects.toThrow();
  });
});
