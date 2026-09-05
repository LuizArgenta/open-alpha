/**
 * Placement replaces the assumption that a student knows everything below
 * their grade. The assumption was silent, which is what made it dangerous —
 * these tests make the replacement explicit.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { GET as getProbe, POST as submitProbe } from '../api/tutor/placement/[subject].js';
import {
  MAX_PROBED_CONCEPTS,
  PLACEMENT_CONFIDENCE,
  chooseProbeConcepts,
  estimateFromProbe,
} from '../api/_lib/placement.js';
import { POST as answerItem } from '../api/tutor/quiz/answer.js';
import { getConcept } from '../api/_lib/curriculum.js';
import { createUser, openQuiz, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
const GRADE = 4;

let studentId: number;
let token: string;

function probeRequest(method: 'GET' | 'POST', body?: unknown) {
  return new Request(`https://test.local/api/tutor/placement/${SUBJECT}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student', GRADE);
  token = signToken({ userId: studentId, role: 'student' });
});

describe('choosing what to probe', () => {
  it('spans levels instead of clustering on one', () => {
    const concepts = chooseProbeConcepts(SUBJECT, GRADE);
    const levels = new Set(concepts.map(concept => concept.gradeLevel));

    expect(concepts.length).toBeGreaterThan(1);
    expect(levels.size).toBeGreaterThan(1);
  });

  it('stays short enough that a child will finish it', () => {
    expect(chooseProbeConcepts(SUBJECT, 12).length).toBeLessThanOrEqual(MAX_PROBED_CONCEPTS);
  });

  it('never probes above the student grade', () => {
    for (const concept of chooseProbeConcepts(SUBJECT, GRADE)) {
      expect(concept.gradeLevel).toBeLessThanOrEqual(GRADE);
    }
  });

  it('skips concepts the student already has a record for', () => {
    const first = chooseProbeConcepts(SUBJECT, GRADE)[0];
    const rest = chooseProbeConcepts(SUBJECT, GRADE, new Set([first.id]));

    expect(rest.map(concept => concept.id)).not.toContain(first.id);
  });

  it('only probes concepts that have questions to ask', () => {
    for (const concept of chooseProbeConcepts(SUBJECT, GRADE)) {
      expect(concept.masteryCheck?.questions?.length).toBeGreaterThan(0);
    }
  });
});

describe('reading a probe', () => {
  it('counts a concept as demonstrated only on a clean sweep', () => {
    // Two items are too few for a partial score to mean anything: one lucky
    // guess out of two would place a student above a gap they still have.
    const estimates = estimateFromProbe([
      { conceptId: 'a', correct: true },
      { conceptId: 'a', correct: true },
      { conceptId: 'b', correct: true },
      { conceptId: 'b', correct: false },
    ]);

    expect(estimates.find(e => e.conceptId === 'a')?.demonstrated).toBe(true);
    expect(estimates.find(e => e.conceptId === 'b')?.demonstrated).toBe(false);
  });

  it('reports how many were asked and answered per concept', () => {
    const [estimate] = estimateFromProbe([
      { conceptId: 'a', correct: true },
      { conceptId: 'a', correct: false },
    ]);

    expect(estimate).toMatchObject({ correct: 1, asked: 2, demonstrated: false });
  });
});

describe('the placement endpoint', () => {
  interface OpenProbe {
    available: boolean;
    attemptId: number;
    items: { itemId: number; conceptId: string; question: string; options: string[] }[];
  }

  async function openProbe(): Promise<OpenProbe> {
    return (await getProbe(probeRequest('GET'))).json() as Promise<OpenProbe>;
  }

  /** The stored answer key, which only the server is supposed to know. */
  async function keyFor(itemId: number): Promise<string> {
    const row = await executeSql<{ correct_answer: string }>(
      'SELECT correct_answer FROM assessment_items WHERE id = $1',
      [itemId]
    );
    return row.rows[0].correct_answer;
  }

  /** Answers one item through the same grading endpoint the quiz uses. */
  async function answer(attemptId: number, itemId: number, chosen: string, as = token) {
    return answerItem(
      new Request('https://test.local/api/tutor/quiz/answer', {
        method: 'POST',
        headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId, itemId, chosen }),
      })
    );
  }

  /** Sits the whole probe, deciding per item whether to answer it correctly. */
  async function sitProbe(rightWhen: (conceptId: string) => boolean = () => true) {
    const probe = await openProbe();
    for (const item of probe.items) {
      const right = await keyFor(item.itemId);
      await answer(probe.attemptId, item.itemId, rightWhen(item.conceptId) ? right : 'Z');
    }
    const response = await submitProbe(probeRequest('POST', { attemptId: probe.attemptId }));
    return { probe, response, body: await response.json() as any };
  }

  it('never sends the correct answers to the client', async () => {
    // A placement a student can see through measures nothing.
    const body = await openProbe();
    const serialised = JSON.stringify(body);

    expect(body.items.length).toBeGreaterThan(0);
    expect(serialised).not.toContain('correctAnswer');
    expect(serialised).not.toContain('explanation');
  });

  it('places the student on the concepts they demonstrated', async () => {
    const { body } = await sitProbe();

    expect(body.placed.length).toBeGreaterThan(0);

    const rows = await executeSql<{ concept_id: string; mastery_source: string; mastery_confidence: number }>(
      'SELECT concept_id, mastery_source, mastery_confidence FROM progress WHERE student_id = $1',
      [studentId]
    );
    expect(rows.rows[0].mastery_source).toBe('placement');
    expect(rows.rows[0].mastery_confidence).toBe(PLACEMENT_CONFIDENCE);
  });

  it('places nobody when every answer is wrong', async () => {
    const { body } = await sitProbe(() => false);

    expect(body.placed).toEqual([]);
    const rows = await executeSql('SELECT id FROM progress WHERE student_id = $1', [studentId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('counts an answer for the concept the server stored it under', async () => {
    // The hole this closes: the concept an answer counted for used to come
    // from the client, so a student could answer the easiest item, label it
    // with the hardest concept, and be placed above the gap they still had.
    const probe = await openProbe();
    const easiest = probe.items[0].conceptId;

    const { body } = await sitProbe(conceptId => conceptId === easiest);

    expect(body.placed).toEqual([easiest]);
  });

  it('treats an item the student skipped as wrong', async () => {
    // Otherwise the way to be placed above a gap is to leave it unanswered.
    const probe = await openProbe();
    const target = probe.items[0].conceptId;
    const forTarget = probe.items.filter(item => item.conceptId === target);
    expect(forTarget.length).toBeGreaterThan(1);

    await answer(probe.attemptId, forTarget[0].itemId, await keyFor(forTarget[0].itemId));

    const body = await (await submitProbe(probeRequest('POST', { attemptId: probe.attemptId }))).json() as any;

    expect(body.placed).not.toContain(target);
  });

  it('keeps the evidence of what was asked and answered', async () => {
    const { probe } = await sitProbe();

    const items = await executeSql<{ n: number }>(
      'SELECT COUNT(*) as n FROM assessment_attempt_items WHERE attempt_id = $1',
      [probe.attemptId]
    );
    const responses = await executeSql<{ n: number }>(
      'SELECT COUNT(*) as n FROM assessment_responses WHERE attempt_id = $1',
      [probe.attemptId]
    );

    expect(Number(items.rows[0].n)).toBe(probe.items.length);
    expect(Number(responses.rows[0].n)).toBe(probe.items.length);
  });

  it('refuses to place a second time from the same probe', async () => {
    const { probe } = await sitProbe();

    const again = await submitProbe(probeRequest('POST', { attemptId: probe.attemptId }));

    expect(again.status).toBe(409);
  });

  it("refuses another student's probe", async () => {
    const probe = await openProbe();
    const otherId = await createUser('student', GRADE);
    const otherToken = signToken({ userId: otherId, role: 'student' });

    const response = await submitProbe(
      new Request(`https://test.local/api/tutor/placement/${SUBJECT}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId: probe.attemptId }),
      })
    );

    expect(response.status).toBe(403);
  });

  it('refuses a mastery attempt submitted as a placement', async () => {
    // Placing off one concept would write placement confidence over a whole
    // subject from a single mastery check.
    const quiz = await openQuiz(token, SUBJECT, 'math-fractions-intro');

    const response = await submitProbe(probeRequest('POST', { attemptId: quiz.attemptId }));

    expect(response.status).toBe(400);
  });

  it('refuses a probe that was opened hours ago', async () => {
    const probe = await openProbe();
    await executeSql(
      `UPDATE assessment_attempts SET started_at = datetime('now', '-5 hours') WHERE id = $1`,
      [probe.attemptId]
    );

    const response = await submitProbe(probeRequest('POST', { attemptId: probe.attemptId }));

    expect(response.status).toBe(410);
  });

  it('records the placement as a decision, with what it was based on', async () => {
    await sitProbe();

    const decision = await executeSql<{ reason: string; inputs: string }>(
      `SELECT reason, inputs FROM learning_decisions WHERE kind = 'placement'`
    );

    expect(decision.rows[0].reason).toBe('probe_completed');
    expect(JSON.parse(decision.rows[0].inputs)).toMatchObject({ gradeLevel: GRADE });
  });

  it('leaves an existing record alone rather than overwriting it', async () => {
    const concept = chooseProbeConcepts(SUBJECT, GRADE)[0];
    await executeSql(
      `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, mastery_source)
       VALUES ($1, $2, $3, 100, 3, 'quiz')`,
      [studentId, SUBJECT, concept.id]
    );

    await sitProbe();

    const row = await executeSql<{ mastery_source: string }>(
      'SELECT mastery_source FROM progress WHERE student_id = $1 AND concept_id = $2',
      [studentId, concept.id]
    );
    expect(row.rows[0].mastery_source).toBe('quiz');
  });

  it('refuses a student with no grade set', async () => {
    const noGrade = await createUser('student', null);
    const response = await getProbe(
      new Request(`https://test.local/api/tutor/placement/${SUBJECT}`, {
        headers: { authorization: `Bearer ${signToken({ userId: noGrade, role: 'student' })}` },
      })
    );

    expect(response.status).toBe(400);
  });

  it('refuses a parent', async () => {
    const parentId = await createUser('parent');
    const response = await getProbe(
      new Request(`https://test.local/api/tutor/placement/${SUBJECT}`, {
        headers: { authorization: `Bearer ${signToken({ userId: parentId, role: 'parent' })}` },
      })
    );

    expect(response.status).toBe(401);
  });

  it('reports nothing to ask for a subject with no authored checks', async () => {
    const response = await getProbe(
      new Request('https://test.local/api/tutor/placement/marketing', {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    const body = await response.json() as any;

    expect(body.available).toBe(false);
    expect(getConcept('marketing', 'marketing-intro')?.masteryCheck).toBeUndefined();
  });
});
