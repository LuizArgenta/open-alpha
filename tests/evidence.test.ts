/**
 * The evidence layer: what the student was asked, what they answered, and
 * what the engine decided about it. Before this, a mastery check left behind
 * a single number and nothing else.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { POST as submitQuiz } from '../api/tutor/quiz/submit.js';
import { recordDecision } from '../api/_lib/decisions.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

let studentId: number;
let token: string;

async function seedItems(count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < count; index++) {
    const row = await executeSql<{ id: number }>(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, authored_id, stem, options, correct_answer)
       VALUES ($1, $2, 'pt-BR', 'authored', $3, $4, '["A) um","B) dois"]', 'A')
       RETURNING id`,
      [SUBJECT, CONCEPT, `item-${index}`, `Pergunta ${index}`]
    );
    ids.push(row.rows[0].id);
  }
  return ids;
}

async function openAttempt(): Promise<number> {
  const row = await executeSql<{ id: number }>(
    `INSERT INTO assessment_attempts (student_id, subject, concept_id, language)
     VALUES ($1, $2, $3, 'pt-BR') RETURNING id`,
    [studentId, SUBJECT, CONCEPT]
  );
  return row.rows[0].id;
}

async function submit(body: Record<string, unknown>) {
  const response = await submitQuiz(
    new Request('https://test.local/api/tutor/quiz/submit', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: SUBJECT, conceptId: CONCEPT, ...body }),
    })
  );
  return response.json() as Promise<any>;
}

beforeEach(async () => {
  await initializeSchema();
  for (const table of [
    'assessment_responses', 'assessment_attempts', 'assessment_items',
    'learning_decisions', 'xp_awards', 'learning_events', 'focus_contests',
    'progress', 'users',
  ]) {
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

describe('assessment evidence', () => {
  it('keeps which item was answered and how, not just the score', async () => {
    const items = await seedItems(2);
    const attemptId = await openAttempt();

    await submit({
      score: 50,
      attemptId,
      responses: [
        { itemId: items[0], chosen: 'A', correct: true, responseTimeMs: 8000 },
        { itemId: items[1], chosen: 'B', correct: false, responseTimeMs: 12000 },
      ],
    });

    const stored = await executeSql<{ item_id: number; chosen: string; correct: number; response_ms: number }>(
      'SELECT item_id, chosen, correct, response_ms FROM assessment_responses ORDER BY item_id'
    );

    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]).toMatchObject({ item_id: items[0], chosen: 'A', correct: 1, response_ms: 8000 });
    expect(stored.rows[1]).toMatchObject({ item_id: items[1], chosen: 'B', correct: 0 });
  });

  it('closes the attempt with its score', async () => {
    const items = await seedItems(1);
    const attemptId = await openAttempt();

    await submit({
      score: 100,
      attemptId,
      responses: [{ itemId: items[0], chosen: 'A', correct: true, responseTimeMs: 9000 }],
    });

    const attempt = await executeSql<{ score: number; finished_at: string | null }>(
      'SELECT score, finished_at FROM assessment_attempts WHERE id = $1',
      [attemptId]
    );

    expect(attempt.rows[0].score).toBe(100);
    expect(attempt.rows[0].finished_at).not.toBeNull();
  });

  it('still accepts a submission with no attempt, so older clients keep working', async () => {
    const result = await submit({ score: 100 });

    expect(result.passed).toBe(true);
    const responses = await executeSql('SELECT id FROM assessment_responses');
    expect(responses.rows).toHaveLength(0);
  });
});

describe('decision log', () => {
  it('records the diagnosis, the XP award and the remediation of a failed attempt', async () => {
    await submit({ score: 20 });

    const decisions = await executeSql<{ kind: string; decision: string; reason: string }>(
      'SELECT kind, decision, reason FROM learning_decisions ORDER BY kind'
    );
    const kinds = decisions.rows.map(row => row.kind);

    expect(kinds).toContain('diagnosis');
    expect(kinds).toContain('remediation');
    expect(kinds).toContain('xp_award');
  });

  it('records why a review was scheduled', async () => {
    await submit({ score: 100 });

    const scheduled = await executeSql<{ decision: string; reason: string; inputs: string }>(
      `SELECT decision, reason, inputs FROM learning_decisions WHERE kind = 'review_schedule'`
    );

    expect(scheduled.rows[0].reason).toBe('first_pass');
    expect(scheduled.rows[0].decision).toMatch(/^\+\d+d$/);
    expect(JSON.parse(scheduled.rows[0].inputs)).toMatchObject({ score: 100 });
  });

  it('distinguishes a lapse from a pass when rescheduling', async () => {
    await submit({ score: 100 });
    await submit({ score: 30 });

    const reasons = await executeSql<{ reason: string }>(
      `SELECT reason FROM learning_decisions WHERE kind = 'review_schedule' ORDER BY id`
    );

    expect(reasons.rows.map(row => row.reason)).toEqual(['first_pass', 'lapsed']);
  });

  it('keeps the signals a decision was made from, so it can be replayed', async () => {
    await recordDecision({
      studentId,
      subject: SUBJECT,
      conceptId: CONCEPT,
      kind: 'next_concept',
      decision: 'math-division',
      reason: 'prerequisite_gap',
      inputs: { gradeLevel: 4, conceptsWithProgress: 3 },
    });

    const stored = await executeSql<{ inputs: string }>(
      `SELECT inputs FROM learning_decisions WHERE kind = 'next_concept'`
    );

    expect(JSON.parse(stored.rows[0].inputs)).toEqual({ gradeLevel: 4, conceptsWithProgress: 3 });
  });

  it('does not fail the request when the log cannot be written', async () => {
    // A student is entitled to their next concept even if the audit trail is
    // broken; losing the record is bad, failing the lesson is worse.
    await expect(
      recordDecision({
        studentId: 999999, // no such user: violates the foreign key
        kind: 'next_concept',
        decision: 'x',
        reason: 'y',
      })
    ).resolves.toBeUndefined();
  });
});
