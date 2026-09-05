/**
 * End-to-end over the real endpoints and a real SQLite file.
 *
 * These cover the parts where a silent mistake is most expensive: the SQL in
 * executeSql binds parameters by order of appearance rather than by their $N
 * number, so a reordered placeholder writes the wrong column without failing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { POST as submitQuiz } from '../api/tutor/quiz/submit.js';
import { GET as getReviewQueue } from '../api/progress/review.js';
import { REVIEW_INTERVALS_DAYS } from '../api/_lib/review.js';

const FRACTIONS = 'math-fractions-intro';
const DECIMALS = 'math-decimals';

let studentId: number;
let token: string;

async function createStudent(gradeLevel = 4) {
  const result = await executeSql<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, grade_level)
     VALUES ($1, $2, 'student', $3) RETURNING id`,
    [`student-${Date.now()}-${Math.random()}@example.test`, 'hash', gradeLevel]
  );
  return result.rows[0].id;
}

async function submit(conceptId: string, score: number) {
  const response = await submitQuiz(
    new Request('https://test.local/api/tutor/quiz/submit', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'math', conceptId, score }),
    })
  );
  return response.json() as Promise<any>;
}

async function progressRow(conceptId: string) {
  const result = await executeSql<{
    mastery_score: number;
    attempts: number;
    next_review_at: string | null;
    review_interval_days: number | null;
    completed_at: string | null;
  }>(
    `SELECT mastery_score, attempts, next_review_at, review_interval_days, completed_at
     FROM progress WHERE student_id = $1 AND concept_id = $2`,
    [studentId, conceptId]
  );
  return result.rows[0];
}

/** Log the answers a quiz attempt would have produced. */
async function logAnswers(
  conceptId: string,
  answers: { correct: boolean; responseTimeMs: number; gapSeconds?: number }[]
) {
  await executeSql(
    `INSERT INTO learning_events (student_id, subject, concept_id, event_type, payload, created_at)
     VALUES ($1, 'math', $2, 'quiz_start', '{}', datetime('now', '-600 seconds'))`,
    [studentId, conceptId]
  );

  let offset = -590;
  for (const answer of answers) {
    offset += answer.gapSeconds ?? 15;
    await executeSql(
      `INSERT INTO learning_events (student_id, subject, concept_id, event_type, payload, created_at)
       VALUES ($1, 'math', $2, 'quiz_answer', $3, datetime('now', $4))`,
      [
        studentId,
        conceptId,
        JSON.stringify({ correct: answer.correct, responseTimeMs: answer.responseTimeMs }),
        `${offset} seconds`,
      ]
    );
  }
}

beforeEach(async () => {
  await initializeSchema();
  for (const table of ['learning_events', 'focus_contests', 'progress', 'users']) {
    await executeSql(`DELETE FROM ${table}`);
  }
  studentId = await createStudent();
  token = signToken({ userId: studentId, role: 'student' });
});

describe('quiz submission', () => {
  it('records a pass and schedules the first review', async () => {
    const result = await submit(FRACTIONS, 100);

    expect(result.passed).toBe(true);
    expect(result.remediation).toBeUndefined();

    const row = await progressRow(FRACTIONS);
    expect(row.mastery_score).toBe(100);
    expect(row.attempts).toBe(1);
    expect(row.completed_at).not.toBeNull();
    expect(row.review_interval_days).toBe(REVIEW_INTERVALS_DAYS[0]);
    expect(row.next_review_at).not.toBeNull();
  });

  it('climbs the review ladder across successive passes', async () => {
    const intervals: (number | null)[] = [];
    for (let pass = 0; pass < 3; pass++) {
      await submit(FRACTIONS, 100);
      intervals.push((await progressRow(FRACTIONS)).review_interval_days);
    }

    expect(intervals).toEqual(REVIEW_INTERVALS_DAYS.slice(0, 3));
  });

  it('drops a forgotten concept back to the first rung without lowering mastery', async () => {
    await submit(FRACTIONS, 100);
    await submit(FRACTIONS, 100);
    expect((await progressRow(FRACTIONS)).review_interval_days).toBe(REVIEW_INTERVALS_DAYS[1]);

    await submit(FRACTIONS, 40);

    const row = await progressRow(FRACTIONS);
    expect(row.review_interval_days).toBe(REVIEW_INTERVALS_DAYS[0]);
    expect(row.mastery_score).toBe(100); // never regresses, by design
  });

  it('does not schedule reviews for a concept that was never passed', async () => {
    await submit(DECIMALS, 20);

    const row = await progressRow(DECIMALS);
    expect(row.next_review_at).toBeNull();
    expect(row.review_interval_days).toBeNull();
    expect(row.completed_at).toBeNull();
  });

  it('answers a failure with a concrete next step instead of "try again"', async () => {
    await logAnswers(DECIMALS, Array(5).fill({ correct: false, responseTimeMs: 25000 }));

    const result = await submit(DECIMALS, 20);

    expect(result.passed).toBe(false);
    expect(result.diagnosis).toBe('high_difficulty');
    expect(result.remediation.conceptId).toBe(FRACTIONS);
    expect(result.remediation.message).toBeTruthy();
  });

  it('does not send a rushing student to a prerequisite', async () => {
    await logAnswers(DECIMALS, Array(5).fill({ correct: false, responseTimeMs: 1200 }));

    const result = await submit(DECIMALS, 20);

    expect(result.diagnosis).toBe('rapid_guessing');
    expect(result.remediation.conceptId).toBeUndefined();
    expect(result.remediation.message).toContain('Slow down');
  });

  it('escalates to a conceptual gap on the second careful failure', async () => {
    const careful = Array(5).fill({ correct: false, responseTimeMs: 25000 });

    await logAnswers(DECIMALS, careful);
    const first = await submit(DECIMALS, 20);

    await executeSql('DELETE FROM learning_events');
    await logAnswers(DECIMALS, careful);
    const second = await submit(DECIMALS, 20);

    expect(first.diagnosis).toBe('high_difficulty');
    expect(second.diagnosis).toBe('conceptual_gap');
  });

  it('rejects a submission without a valid token', async () => {
    const response = await submitQuiz(
      new Request('https://test.local/api/tutor/quiz/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'math', conceptId: FRACTIONS, score: 100 }),
      })
    );

    expect(response.status).toBe(401);
  });
});

describe('review queue', () => {
  async function readQueue() {
    const response = await getReviewQueue(
      new Request('https://test.local/api/progress/review', {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    return (await response.json()) as any;
  }

  it('holds a concept back until its review falls due', async () => {
    await submit(FRACTIONS, 100);
    expect((await readQueue()).review).toHaveLength(0);

    await executeSql(
      `UPDATE progress SET next_review_at = datetime('now', '-1 day') WHERE student_id = $1`,
      [studentId]
    );

    const due = (await readQueue()).review;
    expect(due).toHaveLength(1);
    expect(due[0].conceptId).toBe(FRACTIONS);
    expect(due[0].intervalDays).toBe(REVIEW_INTERVALS_DAYS[0]);
  });

  it('still surfaces rows mastered before scheduling existed', async () => {
    // Legacy rows have no next_review_at; the old 7-day window keeps them in
    // the queue until their next pass puts them on the ladder.
    await submit(FRACTIONS, 100);
    await executeSql(
      `UPDATE progress
       SET next_review_at = NULL, review_interval_days = NULL,
           last_attempt_at = datetime('now', '-30 days')
       WHERE student_id = $1`,
      [studentId]
    );

    const due = (await readQueue()).review;
    expect(due).toHaveLength(1);
    expect(due[0].conceptId).toBe(FRACTIONS);
  });
});
