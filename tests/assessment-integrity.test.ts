/**
 * Attempts to cheat, written from the position of a student who controls the
 * browser completely.
 *
 * Before this, the quiz endpoint sent the answer key to the page and the
 * submit endpoint accepted a score the page reported. Mastery, XP, spaced
 * review, the diagnosis and everything a parent is shown were therefore
 * downstream of a number the student's own device chose.
 *
 * The bar these tests hold: a user who controls the browser cannot change
 * mastery, score or XP without producing evidence the server accepted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { POST as buildQuiz } from '../api/tutor/quiz.js';
import { POST as answerQuiz } from '../api/tutor/quiz/answer.js';
import { POST as submitQuiz } from '../api/tutor/quiz/submit.js';
import { createUser, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
/** Has an authored masteryCheck, so the quiz needs no LLM call. */
const CONCEPT = 'math-fractions-intro';

let studentId: number;
let token: string;
let otherStudentId: number;
let otherToken: string;

function post(handler: (r: Request) => Promise<Response>, url: string, body: unknown, as = token) {
  return handler(new Request(`https://test.local${url}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function openQuiz(as = token) {
  const response = await post(buildQuiz, '/api/tutor/quiz', { subject: SUBJECT, conceptId: CONCEPT }, as);
  return (await response.json()) as { attemptId: number; questions: { itemId: number; question: string; options: string[] }[] };
}

/** The answer key, readable here because this is the server side. */
async function correctAnswerFor(itemId: number): Promise<string> {
  const row = await executeSql<{ correct_answer: string }>(
    'SELECT correct_answer FROM assessment_items WHERE id = $1',
    [itemId]
  );
  return row.rows[0].correct_answer;
}

async function masteryOf(student = studentId): Promise<number | undefined> {
  const row = await executeSql<{ mastery_score: number }>(
    'SELECT mastery_score FROM progress WHERE student_id = $1 AND concept_id = $2',
    [student, CONCEPT]
  );
  return row.rows[0]?.mastery_score;
}

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
  otherStudentId = await createUser('student');
  token = signToken({ userId: studentId, role: 'student' });
  otherToken = signToken({ userId: otherStudentId, role: 'student' });
});

describe('the answer key never reaches the browser', () => {
  it('sends questions and options only', async () => {
    const quiz = await openQuiz();
    const serialised = JSON.stringify(quiz);

    expect(quiz.questions.length).toBeGreaterThan(0);
    expect(serialised).not.toContain('correctAnswer');
    expect(serialised).not.toContain('correct_answer');
    expect(serialised).not.toContain('explanation');
  });

  it('reveals the answer only after the student commits to one', async () => {
    const quiz = await openQuiz();
    const verdict = await (await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: quiz.attemptId,
      itemId: quiz.questions[0].itemId,
      chosen: 'A',
    })).json() as any;

    expect(verdict.correctAnswer).toBeTruthy();
  });
});

describe('the score is the server\'s to compute', () => {
  it('ignores a score the client claims', async () => {
    const quiz = await openQuiz();

    // Every answer wrong, then claim a perfect score on submission.
    for (const question of quiz.questions) {
      const right = await correctAnswerFor(question.itemId);
      const wrong = ['A', 'B', 'C', 'D'].find(letter => letter !== right)!;
      await post(answerQuiz, '/api/tutor/quiz/answer', {
        attemptId: quiz.attemptId, itemId: question.itemId, chosen: wrong,
      });
    }

    const result = await (await post(submitQuiz, '/api/tutor/quiz/submit', {
      attemptId: quiz.attemptId,
      score: 100,
      responses: quiz.questions.map(q => ({ itemId: q.itemId, chosen: 'A', correct: true })),
    })).json() as any;

    expect(result.masteryScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(await masteryOf()).toBe(0);
  });

  it('awards mastery when the answers really are right', async () => {
    const quiz = await openQuiz();
    for (const question of quiz.questions) {
      await post(answerQuiz, '/api/tutor/quiz/answer', {
        attemptId: quiz.attemptId,
        itemId: question.itemId,
        chosen: await correctAnswerFor(question.itemId),
      });
    }

    const result = await (await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId })).json() as any;

    expect(result.masteryScore).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.xp.amount).toBeGreaterThan(0);
  });

  it('counts a skipped question as wrong', async () => {
    const quiz = await openQuiz();
    // Answer one correctly and stop.
    await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: quiz.attemptId,
      itemId: quiz.questions[0].itemId,
      chosen: await correctAnswerFor(quiz.questions[0].itemId),
    });

    const result = await (await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId })).json() as any;

    expect(result.masteryScore).toBe(20);
    expect(result.passed).toBe(false);
  });
});

describe('an attempt belongs to one student', () => {
  it('refuses answers from another student', async () => {
    const quiz = await openQuiz();

    const response = await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: quiz.attemptId, itemId: quiz.questions[0].itemId, chosen: 'A',
    }, otherToken);

    expect(response.status).toBe(403);
  });

  it('refuses a submission from another student', async () => {
    const quiz = await openQuiz();

    const response = await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId }, otherToken);

    expect(response.status).toBe(403);
    expect(await masteryOf(otherStudentId)).toBeUndefined();
  });
});

describe('answers cannot be replayed or smuggled', () => {
  it('keeps the first answer when the same item is answered twice', async () => {
    const quiz = await openQuiz();
    const item = quiz.questions[0].itemId;
    const right = await correctAnswerFor(item);
    const wrong = ['A', 'B', 'C', 'D'].find(letter => letter !== right)!;

    await post(answerQuiz, '/api/tutor/quiz/answer', { attemptId: quiz.attemptId, itemId: item, chosen: wrong });
    const retry = await (await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: quiz.attemptId, itemId: item, chosen: right,
    })).json() as any;

    expect(retry.alreadyAnswered).toBe(true);
    expect(retry.correct).toBe(false);

    const stored = await executeSql('SELECT id FROM assessment_responses WHERE attempt_id = $1', [quiz.attemptId]);
    expect(stored.rows).toHaveLength(1);
  });

  it('refuses an item that belongs to a different attempt', async () => {
    const second = await openQuiz();
    const foreign = await executeSql<{ id: number }>(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, stem, options, correct_answer)
       VALUES ($1, $2, 'en', 'generated', 'Foreign item', '["A","B"]', 'A')
       RETURNING id`,
      [SUBJECT, CONCEPT]
    );

    const response = await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: second.attemptId,
      itemId: foreign.rows[0].id,
      chosen: 'A',
    });

    expect(response.status).toBe(400);
  });

  it('refuses an item that does not exist', async () => {
    const quiz = await openQuiz();
    const response = await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: quiz.attemptId, itemId: 999999, chosen: 'A',
    });

    expect(response.status).toBe(400);
  });
});

describe('an attempt finishes once', () => {
  it('refuses a second submission', async () => {
    const quiz = await openQuiz();
    await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId });

    const again = await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId });
    expect(again.status).toBe(409);
  });

  it('does not award XP twice for the same attempt', async () => {
    const quiz = await openQuiz();
    for (const question of quiz.questions) {
      await post(answerQuiz, '/api/tutor/quiz/answer', {
        attemptId: quiz.attemptId,
        itemId: question.itemId,
        chosen: await correctAnswerFor(question.itemId),
      });
    }

    await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId });
    await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId });

    const awards = await executeSql('SELECT id FROM xp_awards WHERE student_id = $1', [studentId]);
    expect(awards.rows).toHaveLength(1);
  });

  it('refuses answers after the attempt is finished', async () => {
    const quiz = await openQuiz();
    await post(submitQuiz, '/api/tutor/quiz/submit', { attemptId: quiz.attemptId });

    const response = await post(answerQuiz, '/api/tutor/quiz/answer', {
      attemptId: quiz.attemptId, itemId: quiz.questions[0].itemId, chosen: 'A',
    });

    expect(response.status).toBe(409);
  });

  it('refuses a submission with no attempt at all', async () => {
    const response = await post(submitQuiz, '/api/tutor/quiz/submit', {
      subject: SUBJECT, conceptId: CONCEPT, score: 100,
    });

    expect(response.status).toBe(400);
    expect(await masteryOf()).toBeUndefined();
  });
});
