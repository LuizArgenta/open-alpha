/**
 * The 94% that was never checked.
 *
 * `curriculum-record.ts` refuses a mastery check nobody can pass — an item
 * whose `correctAnswer` matches none of its options, which every student fails
 * forever while the engine reads the failure as a knowledge gap and sends them
 * back to a prerequisite they already know. That rule ran only on stored
 * curriculum.
 *
 * Generated questions went from `JSON.parse` into the attempt with nothing in
 * between. Since 132 of 141 concepts have no authored quiz, the path that
 * served almost every learner was the unguarded one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';

const GENERATED_CONCEPT = { subject: 'science', conceptId: 'sci-senses' };

const generateQuizQuestions = vi.hoisted(() => vi.fn());
vi.mock('../api/_lib/llm.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/_lib/llm.js')>()),
  generateQuizQuestions,
}));

function option(letter: string, text: string) {
  return `${letter}) ${text}`;
}

const OPTIONS = [option('A', 'Sight'), option('B', 'Hearing'), option('C', 'Taste'), option('D', 'Touch')];

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

async function openQuiz(token: string): Promise<Response> {
  const { POST } = await import('../api/tutor/quiz.js');
  return POST(new Request('https://test.local/api/tutor/quiz', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(GENERATED_CONCEPT),
  }));
}

async function attemptCount(): Promise<number> {
  const rows = await executeSql<{ count: number }>(
    'SELECT COUNT(*) AS count FROM assessment_attempts'
  );
  return Number(rows.rows[0].count);
}

let token: string;

beforeEach(async () => {
  await resetDatabase();
  token = signToken({ userId: await createUser('student'), role: 'student' });
  generateQuizQuestions.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function generationQuality(): Promise<Record<string, number>> {
  const rows = await executeSql<{ payload: string }>(
    `SELECT payload FROM learning_events WHERE event_type = 'quiz_start' ORDER BY id DESC LIMIT 1`
  );
  return JSON.parse(rows.rows[0].payload).generation as Record<string, number>;
}

const COMPLETE = {
  distractorErrorCode: {
    'B': 'confuses_hearing_with_sight',
    'C': 'confuses_taste_with_sight',
    'D': 'confuses_touch_with_sight',
  },
  distractorRationale: {
    'B': 'They associate ears with looking.',
    'C': 'They associate the tongue with looking.',
    'D': 'They associate hands with looking.',
  },
};

describe('a generated quiz nobody could pass', () => {
  it('is refused when an answer matches no option', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({ correctAnswer: 'E' }));

    const response = await openQuiz(token);

    expect(response.status).toBe(502);
    // Refused before the attempt exists: an attempt opened around items the
    // student can never pass is evidence of nothing.
    expect(await attemptCount()).toBe(0);
    // And not on one sample. A bad draw gets a second chance before a student
    // is turned away.
    expect(generateQuizQuestions).toHaveBeenCalledTimes(2);
  });

  it('is served when the retry comes back answerable', async () => {
    generateQuizQuestions
      .mockResolvedValueOnce(quizWith({ correctAnswer: 'E', ...COMPLETE }))
      .mockResolvedValueOnce(quizWith(COMPLETE));

    expect((await openQuiz(token)).status).toBe(200);
    expect(await attemptCount()).toBe(1);
  });
});

/**
 * The trade this makes, stated plainly: a missing `distractorErrorCode` costs
 * a diagnosis, and refusing the quiz over it costs a student their session.
 * In a learning product that is the wrong way round. So the item is served —
 * with the untrustworthy map thrown away, and with a number recorded for how
 * often this happens.
 */
describe('a generated quiz missing its pedagogical metadata', () => {
  it('is retried once, and a complete second draw is the one served', async () => {
    generateQuizQuestions
      .mockResolvedValueOnce(quizWith({}))
      .mockResolvedValueOnce(quizWith(COMPLETE));

    expect((await openQuiz(token)).status).toBe(200);
    expect(generateQuizQuestions).toHaveBeenCalledTimes(2);

    const stored = await executeSql<{ distractor_error_code: string }>(
      'SELECT distractor_error_code FROM assessment_items'
    );
    expect(stored.rows).toHaveLength(5);
    for (const row of stored.rows) {
      expect(JSON.parse(row.distractor_error_code)).toEqual(COMPLETE.distractorErrorCode);
    }

    expect(await generationQuality()).toEqual({ attempts: 2, items: 5, withoutErrorCodes: 0, discarded: 0 });
  });

  it('serves the quiz anyway when the retry omits it too, and counts that', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({}));

    expect((await openQuiz(token)).status).toBe(200);
    expect(generateQuizQuestions).toHaveBeenCalledTimes(2);

    // The whole point. A student who opened a quiz gets a quiz; the cost lands
    // on the diagnosis, and the cost is written down.
    expect(await generationQuality()).toEqual({ attempts: 2, items: 5, withoutErrorCodes: 5, discarded: 0 });
  });

  it('discards a map that covers only some distractors rather than trusting it', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({
      distractorErrorCode: { 'B': 'confuses_hearing_with_sight' },
    }));

    expect((await openQuiz(token)).status).toBe(200);

    // Half-filled would be worse than empty: the diagnosis reads "no code" as
    // "no shared cause", so three mistakes from one misunderstanding would
    // look like three unrelated ones.
    const stored = await executeSql<{ distractor_error_code: string }>(
      'SELECT distractor_error_code FROM assessment_items LIMIT 1'
    );
    expect(JSON.parse(stored.rows[0].distractor_error_code)).toEqual({});
    expect(await generationQuality()).toEqual({ attempts: 2, items: 5, withoutErrorCodes: 5, discarded: 5 });
  });

  it('discards a map pinned to the correct answer', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({
      distractorErrorCode: { 'A': 'nope', 'B': 'b', 'C': 'c', 'D': 'd' },
    }));

    expect((await openQuiz(token)).status).toBe(200);
    expect(await generationQuality()).toEqual({ attempts: 2, items: 5, withoutErrorCodes: 5, discarded: 5 });
  });

  it('keeps the field that came back whole when only the other is broken', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({
      distractorErrorCode: COMPLETE.distractorErrorCode,
      distractorRationale: { 'B': 'Only one of three.' },
    }));

    expect((await openQuiz(token)).status).toBe(200);

    const stored = await executeSql<{ distractor_error_code: string; distractor_rationale: string }>(
      'SELECT distractor_error_code, distractor_rationale FROM assessment_items LIMIT 1'
    );
    expect(JSON.parse(stored.rows[0].distractor_error_code)).toEqual(COMPLETE.distractorErrorCode);
    expect(JSON.parse(stored.rows[0].distractor_rationale)).toEqual({});

    // The codes survived, so nothing is missing — only the rationales were
    // thrown away.
    expect(await generationQuality()).toEqual({ attempts: 2, items: 5, withoutErrorCodes: 0, discarded: 5 });
  });

  it('asks the model only once when the first draw is complete', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith(COMPLETE));

    expect((await openQuiz(token)).status).toBe(200);
    expect(generateQuizQuestions).toHaveBeenCalledTimes(1);
    expect(await generationQuality()).toEqual({ attempts: 1, items: 5, withoutErrorCodes: 0, discarded: 0 });
  });
});

describe('a generated quiz the model got right', () => {
  it('opens an attempt and keeps the metadata on the stored item', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({
      skillTag: 'sense_identification',
      reasoningType: 'recall',
      distractorErrorCode: {
        'B': 'confuses_hearing_with_sight',
        'C': 'confuses_taste_with_sight',
        'D': 'confuses_touch_with_sight',
      },
      distractorRationale: {
        'B': 'They associate ears with looking.',
        'C': 'They associate the tongue with looking.',
        'D': 'They associate hands with looking.',
      },
    }));

    const response = await openQuiz(token);
    expect(response.status).toBe(200);

    const stored = await executeSql<{ skill_tag: string; reasoning_type: string; distractor_error_code: string }>(
      'SELECT skill_tag, reasoning_type, distractor_error_code FROM assessment_items LIMIT 1'
    );

    // The point of the whole exercise: the columns hold something now.
    expect(stored.rows[0].skill_tag).toBe('sense_identification');
    expect(stored.rows[0].reasoning_type).toBe('recall');
    expect(JSON.parse(stored.rows[0].distractor_error_code)).toEqual({
      B: 'confuses_hearing_with_sight',
      C: 'confuses_taste_with_sight',
      D: 'confuses_touch_with_sight',
    });
  });

});

describe('the whole path, from a generated item to a recorded diagnosis', () => {
  /**
   * The test that could not be written before this wave: it starts at the
   * model's output and ends at what the engine concluded, with nothing stubbed
   * in between. Written against the real item path on purpose — the first
   * version of this design passed every unit test while the columns it read
   * were empty, because the tests inserted their own fixtures.
   */
  it('names the misunderstanding a student repeated', async () => {
    generateQuizQuestions.mockResolvedValue(quizWith({
      skillTag: 'sense_identification',
      reasoningType: 'recall',
      distractorErrorCode: {
        'B': 'confuses_hearing_with_sight',
        'C': 'confuses_taste_with_sight',
        'D': 'confuses_touch_with_sight',
      },
    }));

    const opened = await (await openQuiz(token)).json() as {
      attemptId: number;
      questions: { itemId: number }[];
    };

    const { POST: answerQuiz } = await import('../api/tutor/quiz/answer.js');
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const call = (handler: (r: Request) => Promise<Response>, body: unknown) =>
      handler(new Request('https://test.local/api', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));

    // Three answers wrong the same way, at a considered pace, then two right.
    for (const [index, question] of opened.questions.entries()) {
      await call(answerQuiz, {
        attemptId: opened.attemptId,
        itemId: question.itemId,
        chosen: index < 3 ? 'B' : 'A',
        responseTimeMs: 30_000,
      });
    }

    const result = await (await call(submitQuiz, { attemptId: opened.attemptId })).json() as {
      diagnosis: string;
    };

    expect(result.diagnosis).toBe('recurring_misconception');

    // And it is contestable: the grounds are in the decision log, not only in
    // the response the student happened to see.
    const decision = await executeSql<{ inputs: string }>(
      `SELECT inputs FROM learning_decisions
       WHERE student_id = (SELECT student_id FROM assessment_attempts WHERE id = $1)
         AND kind = 'diagnosis'`,
      [opened.attemptId]
    );
    expect(JSON.parse(decision.rows[0].inputs).misconception).toEqual({
      code: 'confuses_hearing_with_sight',
      count: 3,
    });
  });
});
