/**
 * The half of "serve and count" that makes the trade defensible.
 *
 * Serving an item with no `distractorErrorCode` costs a diagnosis, and that is
 * the right call next to refusing a student's session over a telemetry field.
 * It is only the right call if the cost is visible. This project has already
 * found four things written by one end and read by no other — including
 * `distractor_error_code` itself, empty in 45 of 45 authored questions with
 * nothing anywhere to notice.
 *
 * So the number has a reader.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';

const GENERATED_CONCEPT = { subject: 'science', conceptId: 'sci-senses' };

const generateQuizQuestions = vi.hoisted(() => vi.fn());
vi.mock('../api/_lib/llm.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/_lib/llm.js')>()),
  generateQuizQuestions,
}));

const OPTIONS = ['A) Sight', 'B) Hearing', 'C) Taste', 'D) Touch'];

function quizWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    questions: Array.from({ length: 5 }, (_, index) => ({
      question: `Which sense is used for question ${index + 1}?`,
      options: OPTIONS,
      correctAnswer: 'A',
      explanation: 'Sight uses the eyes.',
      ...overrides,
    })),
  });
}

const COMPLETE = {
  distractorErrorCode: { B: 'confuses_hearing', C: 'confuses_taste', D: 'confuses_touch' },
  distractorRationale: { B: 'Ears with looking.', C: 'Tongue with looking.', D: 'Hands with looking.' },
};

async function openQuiz(token: string): Promise<Response> {
  const { POST } = await import('../api/tutor/quiz.js');
  return POST(new Request('https://test.local/api/tutor/quiz', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(GENERATED_CONCEPT),
  }));
}

async function readHealth(token: string, query = ''): Promise<Response> {
  const { GET } = await import('../api/health/generation.js');
  return GET(new Request(`https://test.local/api/health/generation${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }));
}

let studentToken: string;
let teacherToken: string;

beforeEach(async () => {
  await resetDatabase();
  studentToken = signToken({ userId: await createUser('student'), role: 'student' });

  const teacherId = await createUser('student');
  await executeSql("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'teacher')", [teacherId]);
  teacherToken = signToken({ userId: teacherId, role: 'student' });

  generateQuizQuestions.mockReset();
});

describe('the generation health report', () => {
  it('says "no data" rather than "no omissions" when nothing was generated', async () => {
    const body = await (await readHealth(teacherToken)).json() as Record<string, unknown>;

    expect(body.items).toBe(0);
    // Zero omissions out of zero items is not a 0% omission rate. Rounding
    // those together is how a metric starts lying.
    expect(body.withoutErrorCodesRate).toBeNull();
  });

  it('counts the items a learner sat that cannot feed a diagnosis', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({}));
    expect((await openQuiz(studentToken)).status).toBe(200);

    const body = await (await readHealth(teacherToken)).json() as Record<string, unknown>;

    expect(body).toMatchObject({
      quizzes: 1,
      retried: 1,
      items: 5,
      withoutErrorCodes: 5,
      discarded: 0,
      withoutErrorCodesRate: 1,
    });
  });

  it('separates the two ways a rate goes wrong across quizzes', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith(COMPLETE));
    expect((await openQuiz(studentToken)).status).toBe(200);

    const second = signToken({ userId: await createUser('student'), role: 'student' });
    generateQuizQuestions.mockResolvedValue(quizWith({
      distractorErrorCode: { B: 'only_one_of_three' },
    }));
    expect((await openQuiz(second)).status).toBe(200);

    const body = await (await readHealth(teacherToken)).json() as Record<string, unknown>;

    expect(body).toMatchObject({
      quizzes: 2,
      // Only the second draw was retried: a complete first draw costs one call.
      retried: 1,
      items: 10,
      withoutErrorCodes: 5,
      // Half-filled maps thrown away, which is a different failure from a
      // model that returned nothing at all.
      discarded: 5,
      withoutErrorCodesRate: 0.5,
    });
  });

  it('is not a student-facing number', async () => {
    expect((await readHealth(studentToken)).status).toBe(403);
    const { GET } = await import('../api/health/generation.js');
    const anonymous = await GET(new Request('https://test.local/api/health/generation'));
    expect(anonymous.status).toBe(401);
  });

  it('bounds the window a caller can ask for', async () => {
    const body = await (await readHealth(teacherToken, '?days=99999')).json() as { windowDays: number };
    expect(body.windowDays).toBe(90);

    const bad = await (await readHealth(teacherToken, '?days=nonsense')).json() as { windowDays: number };
    expect(bad.windowDays).toBe(7);
  });
});
