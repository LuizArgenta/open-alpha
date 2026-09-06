/**
 * The stream had one writer, and it was the browser.
 *
 * `learning_events` was written only by `progress/events.ts`, which
 * `Quiz.tsx` and `Learn.tsx` call fire-and-forget with `.catch(() => {})`.
 * Everything the server knew for certain — an attempt opened, an answer
 * graded, a quiz finalised, an attempt expired — never reached it, and a
 * dropped request left no trace of the gap. A student who had just sat a quiz
 * showed a streak of zero, which is how this was found.
 *
 * Making that table a canonical contract while the browser was its only writer
 * would have canonised the holes. So: the whole test below reports nothing
 * from a browser, and expects a complete stream anyway.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { answerKey, callAs, createUser, openQuiz, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

interface StoredEvent {
  event_type: string;
  source: string;
  attempt_id: number | null;
  payload: string;
}

async function streamFor(attemptId: number): Promise<StoredEvent[]> {
  const rows = await executeSql<StoredEvent>(
    `SELECT event_type, source, attempt_id, payload FROM learning_events
     WHERE attempt_id = $1 ORDER BY id`,
    [attemptId]
  );
  return rows.rows;
}

let token: string;

beforeEach(async () => {
  await resetDatabase();
  token = signToken({ userId: await createUser('student'), role: 'student' });
});

describe('a quiz sat without the browser reporting anything', () => {
  it('leaves a complete stream behind', async () => {
    const { POST: answerQuiz } = await import('../api/tutor/quiz/answer.js');
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');

    const quiz = await openQuiz(token, SUBJECT, CONCEPT);
    for (const question of quiz.questions) {
      await callAs(token, answerQuiz, {
        attemptId: quiz.attemptId,
        itemId: question.itemId,
        chosen: await answerKey(question.itemId),
        responseTimeMs: 30_000,
      });
    }
    await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    const stream = await streamFor(quiz.attemptId);
    const types = stream.map(event => event.event_type);

    // Opened, five answers graded, finalised — none of it reported by a client.
    expect(types[0]).toBe('quiz_start');
    expect(types.filter(type => type === 'quiz_answer')).toHaveLength(5);
    expect(types[types.length - 1]).toBe('quiz_complete');

    // Every one of them attributable, and joinable back to the evidence.
    expect(stream.every(event => event.source === 'server')).toBe(true);
    expect(stream.every(event => event.attempt_id === quiz.attemptId)).toBe(true);
  });

  it('records what the submission concluded, not just that it happened', async () => {
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);
    await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    const complete = (await streamFor(quiz.attemptId))
      .find(event => event.event_type === 'quiz_complete');
    const payload = JSON.parse(complete!.payload) as Record<string, unknown>;

    // An event saying only "a quiz finished" would need a join to mean
    // anything; the conclusion travels with it.
    expect(payload).toHaveProperty('score');
    expect(payload).toHaveProperty('passed');
    expect(payload).toHaveProperty('diagnosis');
  });
});

describe('an attempt that timed out', () => {
  it('is recorded as expired, which is not the same as walking away', async () => {
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);

    await executeSql(
      "UPDATE assessment_attempts SET started_at = datetime('now', '-1 day') WHERE id = $1",
      [quiz.attemptId]
    );
    const response = await callAs(token, submitQuiz, { attemptId: quiz.attemptId });
    expect(response.status).toBe(410);

    const types = (await streamFor(quiz.attemptId)).map(event => event.event_type);
    // `quiz_expired` is the server closing a stale attempt. `idle_timeout` is
    // the browser noticing a person left. Collapsing them would lose the
    // distinction the focus diagnosis rests on.
    expect(types).toContain('quiz_expired');
    expect(types).not.toContain('idle_timeout');
  });
});

describe('the stream never costs a learner their work', () => {
  it('finishes the quiz even when the event write fails', async () => {
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);

    await executeSql('DROP TABLE learning_events');

    // Telemetry is reconstructible from the operational tables; a lost
    // submission is not. The trade is deliberate and this pins it.
    const response = await callAs(token, submitQuiz, { attemptId: quiz.attemptId });
    expect(response.status).toBe(200);

    const attempt = await executeSql<{ finished_at: string | null }>(
      'SELECT finished_at FROM assessment_attempts WHERE id = $1',
      [quiz.attemptId]
    );
    expect(attempt.rows[0].finished_at).not.toBeNull();
  });
});
