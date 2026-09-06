/**
 * The evidence has to explain the decision.
 *
 * Everything this project has built on the assessment path rests on one
 * invariant: the score stored on an attempt is reconstructible from the
 * responses stored for that attempt. Server-side grading, immutable item
 * snapshots, the decision log and the parent's right to contest all assume
 * it. A response that exists but was never counted breaks it silently — the
 * row is there, the mastery decision is there, and they disagree.
 *
 * Two writers can reach that state:
 *
 *   answer × submit — `answer` checks the attempt is open, then does three
 *   more round trips before inserting. `submit` reads the answers, decides,
 *   and only then closes the attempt. An answer that passed its check before
 *   `submit` read can land after `submit` wrote.
 *
 *   answer × answer — two answers for the same item both pass the "already
 *   answered?" read and both insert. The unique index keeps the database
 *   honest, but the loser used to surface as a 500.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { POST as answerQuiz } from '../api/tutor/quiz/answer.js';
import { POST as submitQuiz } from '../api/tutor/quiz/submit.js';
import { POST as signup } from '../api/auth/signup.js';
import { answerKey, callAs, openQuiz, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

async function studentToken(): Promise<string> {
  const response = await signup(new Request('https://test.local/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `race-${Date.now()}-${Math.random()}@example.test`,
      password: 'correct horse battery staple',
      name: 'Race',
      role: 'student',
      gradeLevel: 4,
    }),
  }));
  return (await response.json() as { token: string }).token;
}

/**
 * The invariant, checked against the database rather than against what the
 * endpoints reported: recompute the score from the responses that are
 * actually stored and hold it against the one written on the attempt.
 */
async function scoreDisagreement(attemptId: number): Promise<{
  stored: number;
  fromEvidence: number;
  responses: number;
}> {
  const attempt = await executeSql<{ score: number }>(
    'SELECT score FROM assessment_attempts WHERE id = $1',
    [attemptId]
  );
  const counts = await executeSql<{ total: number; correct: number; answered: number }>(
    `SELECT
       (SELECT COUNT(*) FROM assessment_attempt_items WHERE attempt_id = $1) as total,
       (SELECT COUNT(*) FROM assessment_responses WHERE attempt_id = $2) as answered,
       (SELECT COALESCE(SUM(correct), 0) FROM assessment_responses WHERE attempt_id = $3) as correct`,
    [attemptId, attemptId, attemptId]
  );

  const total = Number(counts.rows[0].total);
  const correct = Number(counts.rows[0].correct);
  return {
    stored: Number(attempt.rows[0].score),
    fromEvidence: total > 0 ? Math.round((correct / total) * 100) : 0,
    responses: Number(counts.rows[0].answered),
  };
}

beforeEach(async () => {
  await resetDatabase();
});

describe('an answer racing the submission', () => {
  /**
   * Run enough times that an interleaving which only sometimes happens is not
   * mistaken for one that never does. Before the fix this failed on the first
   * or second round; a single round would have been a coin toss reported as a
   * pass.
   */
  const ROUNDS = 12;

  it('never leaves a stored score the stored answers cannot explain', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetDatabase();
      const token = await studentToken();
      const quiz = await openQuiz(token, SUBJECT, CONCEPT);

      // Answer all but the last, so the race is over one specific response.
      for (const question of quiz.questions.slice(0, -1)) {
        await callAs(token, answerQuiz, {
          attemptId: quiz.attemptId,
          itemId: question.itemId,
          chosen: await answerKey(question.itemId),
        });
      }

      const last = quiz.questions[quiz.questions.length - 1];
      const chosen = await answerKey(last.itemId);

      // The race itself: the student's final answer and their submission in
      // flight at the same time, which is exactly what a double-click or a
      // slow network produces.
      await Promise.all([
        callAs(token, answerQuiz, { attemptId: quiz.attemptId, itemId: last.itemId, chosen }),
        callAs(token, submitQuiz, { attemptId: quiz.attemptId }),
      ]);

      const { stored, fromEvidence, responses } = await scoreDisagreement(quiz.attemptId);

      // Either the answer landed and was counted, or it was refused and never
      // stored. What must never happen is a response sitting in the table that
      // the score does not account for.
      expect(
        stored,
        `round ${round}: stored score ${stored} but ${responses} stored responses give ${fromEvidence}`
      ).toBe(fromEvidence);
    }
  });

  it('refuses the answer outright once the attempt is finished', async () => {
    const token = await studentToken();
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);
    const first = quiz.questions[0];

    await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    const response = await callAs(token, answerQuiz, {
      attemptId: quiz.attemptId,
      itemId: first.itemId,
      chosen: await answerKey(first.itemId),
    });

    expect(response.status).toBe(409);
    const stored = await executeSql(
      'SELECT id FROM assessment_responses WHERE attempt_id = $1',
      [quiz.attemptId]
    );
    // Not merely reported as refused — not written.
    expect(stored.rows).toHaveLength(0);
  });
});

describe('two answers to the same item at once', () => {
  it('both get the first answer rather than one getting a 500', async () => {
    const token = await studentToken();
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);
    const item = quiz.questions[0];
    const chosen = await answerKey(item.itemId);

    const [a, b] = await Promise.all([
      callAs(token, answerQuiz, { attemptId: quiz.attemptId, itemId: item.itemId, chosen }),
      callAs(token, answerQuiz, { attemptId: quiz.attemptId, itemId: item.itemId, chosen }),
    ]);

    // The unique index already kept the database honest. What it did not do
    // was keep the loser from seeing "something broke" for a request that
    // succeeded.
    expect([a.status, b.status]).toEqual([200, 200]);

    const stored = await executeSql(
      'SELECT id FROM assessment_responses WHERE attempt_id = $1 AND item_id = $2',
      [quiz.attemptId, item.itemId]
    );
    expect(stored.rows).toHaveLength(1);
  });
});
