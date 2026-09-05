import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { GET as getTimeback } from '../api/progress/timeback.js';
import { POST as postContest } from '../api/progress/contest.js';

/** metadata.difficulty: foundational (2s threshold) */
const FOUNDATIONAL = 'math-fractions-intro';
/** metadata.difficulty: standard (3s threshold) */
const STANDARD = 'math-decimals';

let studentId: number;
let token: string;

async function answer(conceptId: string, responseTimeMs: number, offsetSeconds: number, correct = true) {
  await executeSql(
    `INSERT INTO learning_events (student_id, subject, concept_id, event_type, payload, created_at)
     VALUES ($1, 'math', $2, 'quiz_answer', $3, datetime('now', $4))`,
    [studentId, conceptId, JSON.stringify({ correct, responseTimeMs }), `${offsetSeconds} seconds`]
  );
}

async function readMeter() {
  const response = await getTimeback(
    new Request('https://test.local/api/progress/timeback', {
      headers: { authorization: `Bearer ${token}` },
    })
  );
  return ((await response.json()) as any).wasteMeter;
}

async function contest(pattern: string) {
  return postContest(
    new Request('https://test.local/api/progress/contest', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pattern }),
    })
  );
}

beforeEach(async () => {
  await initializeSchema();
  for (const table of ['learning_events', 'focus_contests', 'progress', 'users']) {
    await executeSql(`DELETE FROM ${table}`);
  }
  const created = await executeSql<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, grade_level)
     VALUES ($1, 'hash', 'student', 4) RETURNING id`,
    [`student-${Date.now()}-${Math.random()}@example.test`]
  );
  studentId = created.rows[0].id;
  token = signToken({ userId: studentId, role: 'student' });
});

describe('focus meter', () => {
  it('reports nothing against a student with no events', async () => {
    const meter = await readMeter();

    expect(meter.score).toBe(0);
    expect(meter.focusScore).toBe(100);
    expect(meter.reasons).toEqual([]);
  });

  it('judges the same pace differently depending on the concept', async () => {
    await answer(STANDARD, 2500, -300);
    await answer(STANDARD, 2500, -280);
    const onStandard = await readMeter();

    await executeSql('DELETE FROM learning_events');
    await answer(FOUNDATIONAL, 2500, -300);
    await answer(FOUNDATIONAL, 2500, -280);
    const onFoundational = await readMeter();

    expect(onStandard.rapidGuessCount).toBe(2);
    expect(onFoundational.rapidGuessCount).toBe(0);
  });

  it('counts a long break between answers as leaving the quiz', async () => {
    await answer(STANDARD, 20000, -900);
    await answer(STANDARD, 20000, -480);
    await answer(STANDARD, 20000, -460);

    const meter = await readMeter();

    expect(meter.walkedAwayCount).toBe(1);
    expect(meter.reasons.map((reason: any) => reason.code)).toContain('walked_away');
  });

  it('explains every point it takes off', async () => {
    await answer(STANDARD, 1000, -300, false);
    await answer(STANDARD, 1000, -280, false);

    const meter = await readMeter();
    const total = meter.reasons.reduce((sum: number, reason: any) => sum + reason.points, 0);

    expect(meter.reasons.length).toBeGreaterThan(0);
    expect(meter.score).toBe(Math.min(total, 100));
  });

  it('stops counting a signal the student has disputed', async () => {
    await answer(STANDARD, 1000, -300);
    await answer(STANDARD, 1000, -280);

    const before = await readMeter();
    expect(before.score).toBeGreaterThan(0);

    await contest('rapid_guessing');
    const after = await readMeter();

    const disputed = after.reasons.find((reason: any) => reason.code === 'rapid_guessing');
    expect(disputed.contested).toBe(true);
    expect(disputed.points).toBe(0);
    expect(after.score).toBeLessThan(before.score);
  });

  it('is idempotent when the same signal is disputed twice', async () => {
    await answer(STANDARD, 1000, -300);
    await answer(STANDARD, 1000, -280);

    await contest('rapid_guessing');
    await contest('rapid_guessing');

    const stored = await executeSql<{ count: number }>(
      'SELECT COUNT(*) as count FROM focus_contests WHERE student_id = $1',
      [studentId]
    );
    expect(Number(stored.rows[0].count)).toBe(1);
  });

  it('refuses to dispute a signal that is a fact about the answers', async () => {
    const response = await contest('low_accuracy');
    expect(response.status).toBe(400);
  });

  it('requires a student token', async () => {
    const response = await getTimeback(new Request('https://test.local/api/progress/timeback'));
    expect(response.status).toBe(401);
  });
});
