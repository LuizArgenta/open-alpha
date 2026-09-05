/**
 * What happens to a mastery attempt that is never finished, and what happens
 * when a write in the middle of finishing one fails.
 *
 * Both used to be undefined behaviour: an abandoned attempt stayed open
 * forever, so a quiz could be opened, looked up offline and submitted the next
 * day; and submission wrote the attempt, the progress, the XP and the decision
 * log in four separate statements, so a failure between them could leave a
 * student with XP for a concept their progress row says they never attempted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, executeTransaction } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { ATTEMPT_LIFETIME_MINUTES } from '../api/_lib/attempts.js';
import { answerKey, callAs, createUser, openQuiz, resetDatabase, takeQuiz } from './helpers/database.js';
import { POST as answerQuiz } from '../api/tutor/quiz/answer.js';
import { POST as submitQuiz } from '../api/tutor/quiz/submit.js';

const FRACTIONS = 'math-fractions-intro';

let studentId: number;
let token: string;

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
  token = signToken({ userId: studentId, role: 'student' });
});

/** Pretends the attempt was opened long enough ago to be abandoned. */
async function ageAttempt(attemptId: number, minutes = ATTEMPT_LIFETIME_MINUTES + 30) {
  await executeSql(
    `UPDATE assessment_attempts SET started_at = datetime('now', $1) WHERE id = $2`,
    [`-${minutes} minutes`, attemptId]
  );
}

async function countRows(table: string): Promise<number> {
  const result = await executeSql<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
  return Number(result.rows[0].n);
}

describe('one transaction per submission', () => {
  it('writes progress, XP and the grounds for both in a single submission', async () => {
    await takeQuiz(token, 'math', FRACTIONS, 5);

    expect(await countRows('progress')).toBe(1);
    expect(await countRows('xp_awards')).toBe(1);

    const kinds = await executeSql<{ kind: string }>(
      'SELECT kind FROM learning_decisions WHERE student_id = $1 ORDER BY kind',
      [studentId]
    );
    expect(kinds.rows.map(row => row.kind)).toEqual(['diagnosis', 'review_schedule', 'xp_award']);
  });

  it('leaves nothing behind when a statement in the batch fails', async () => {
    const quiz = await openQuiz(token, 'math', FRACTIONS);

    await expect(
      executeTransaction([
        {
          sql: `UPDATE assessment_attempts SET score = $1, finished_at = datetime('now') WHERE id = $2`,
          params: [100, quiz.attemptId],
        },
        {
          sql: 'INSERT INTO xp_awards (student_id, subject, concept_id, amount, reason) VALUES ($1, $2, $3, $4, $5)',
          params: [studentId, 'math', FRACTIONS, 30, 'mastery'],
        },
        {
          // A student who does not exist: the same shape of failure a real
          // constraint violation mid-submission would produce.
          sql: 'INSERT INTO progress (student_id, subject, concept_id, mastery_score) VALUES ($1, $2, $3, $4)',
          params: [999999, 'math', FRACTIONS, 100],
        },
      ])
    ).rejects.toThrow();

    // The attempt is still open and no XP was granted: all of it or none.
    const attempt = await executeSql<{ finished_at: string | null; score: number | null }>(
      'SELECT finished_at, score FROM assessment_attempts WHERE id = $1',
      [quiz.attemptId]
    );
    expect(attempt.rows[0].finished_at).toBeNull();
    expect(attempt.rows[0].score).toBeNull();
    expect(await countRows('xp_awards')).toBe(0);
    expect(await countRows('progress')).toBe(0);
  });
});

describe('abandoned attempts', () => {
  it('refuses to grade an answer on an attempt opened hours ago', async () => {
    const quiz = await openQuiz(token, 'math', FRACTIONS);
    await ageAttempt(quiz.attemptId);

    const response = await callAs(token, answerQuiz, {
      attemptId: quiz.attemptId,
      itemId: quiz.questions[0].itemId,
      chosen: await answerKey(quiz.questions[0].itemId),
    });

    expect(response.status).toBe(410);
    expect(await countRows('assessment_responses')).toBe(0);
  });

  it('refuses to award mastery for a quiz answered and left overnight', async () => {
    const quiz = await openQuiz(token, 'math', FRACTIONS);
    for (const question of quiz.questions) {
      await callAs(token, answerQuiz, {
        attemptId: quiz.attemptId,
        itemId: question.itemId,
        chosen: await answerKey(question.itemId),
      });
    }
    await ageAttempt(quiz.attemptId);

    const response = await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    expect(response.status).toBe(410);
    expect(await countRows('progress')).toBe(0);
    expect(await countRows('xp_awards')).toBe(0);
    // The answers stay: they are evidence of what happened, not a decision.
    expect(await countRows('assessment_responses')).toBe(5);
  });

  it('marks an expired attempt as expired rather than merely finished', async () => {
    const quiz = await openQuiz(token, 'math', FRACTIONS);
    await ageAttempt(quiz.attemptId);
    await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    const row = await executeSql<{ expired_at: string | null; finished_at: string | null; score: number | null }>(
      'SELECT expired_at, finished_at, score FROM assessment_attempts WHERE id = $1',
      [quiz.attemptId]
    );
    expect(row.rows[0].expired_at).not.toBeNull();
    expect(row.rows[0].finished_at).not.toBeNull();
    expect(row.rows[0].score).toBeNull();
  });

  it('closes attempts left open when the student starts a new quiz', async () => {
    const abandoned = await openQuiz(token, 'math', FRACTIONS);
    await ageAttempt(abandoned.attemptId);

    await openQuiz(token, 'math', FRACTIONS);

    const row = await executeSql<{ expired_at: string | null }>(
      'SELECT expired_at FROM assessment_attempts WHERE id = $1',
      [abandoned.attemptId]
    );
    expect(row.rows[0].expired_at).not.toBeNull();
  });

  it('does not touch another student\'s open attempt when sweeping', async () => {
    const otherId = await createUser('student');
    const otherToken = signToken({ userId: otherId, role: 'student' });
    const theirs = await openQuiz(otherToken, 'math', FRACTIONS);
    await ageAttempt(theirs.attemptId);

    await openQuiz(token, 'math', FRACTIONS);

    const row = await executeSql<{ expired_at: string | null }>(
      'SELECT expired_at FROM assessment_attempts WHERE id = $1',
      [theirs.attemptId]
    );
    expect(row.rows[0].expired_at).toBeNull();
  });

  it('still lets a student finish a quiz they started a few minutes ago', async () => {
    const quiz = await openQuiz(token, 'math', FRACTIONS);
    await ageAttempt(quiz.attemptId, ATTEMPT_LIFETIME_MINUTES - 30);

    for (const question of quiz.questions) {
      await callAs(token, answerQuiz, {
        attemptId: quiz.attemptId,
        itemId: question.itemId,
        chosen: await answerKey(question.itemId),
      });
    }
    const result = await (await callAs(token, submitQuiz, { attemptId: quiz.attemptId })).json() as any;

    expect(result.passed).toBe(true);
  });
});
