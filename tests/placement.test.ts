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
  buildProbe,
  chooseProbeConcepts,
  estimateFromProbe,
} from '../api/_lib/placement.js';
import { getConcept } from '../api/_lib/curriculum.js';
import { createUser, resetDatabase } from './helpers/database.js';

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
  it('never sends the correct answers to the client', async () => {
    // A placement a student can see through measures nothing.
    const body = await (await getProbe(probeRequest('GET'))).json() as any;
    const serialised = JSON.stringify(body);

    expect(body.items.length).toBeGreaterThan(0);
    expect(serialised).not.toContain('correctAnswer');
    expect(serialised).not.toContain('explanation');
  });

  it('places the student on the concepts they demonstrated', async () => {
    const probe = buildProbe(chooseProbeConcepts(SUBJECT, GRADE));
    const answers = probe.items.map(item => ({
      conceptId: item.conceptId,
      chosen: item.question.correctAnswer,
    }));

    const result = await (await submitProbe(probeRequest('POST', { answers }))).json() as any;

    expect(result.placed.length).toBeGreaterThan(0);

    const rows = await executeSql<{ concept_id: string; mastery_source: string; mastery_confidence: number }>(
      'SELECT concept_id, mastery_source, mastery_confidence FROM progress WHERE student_id = $1',
      [studentId]
    );
    expect(rows.rows[0].mastery_source).toBe('placement');
    expect(rows.rows[0].mastery_confidence).toBe(PLACEMENT_CONFIDENCE);
  });

  it('places nobody when every answer is wrong', async () => {
    const probe = buildProbe(chooseProbeConcepts(SUBJECT, GRADE));
    const answers = probe.items.map(item => ({ conceptId: item.conceptId, chosen: 'Z' }));

    const result = await (await submitProbe(probeRequest('POST', { answers }))).json() as any;

    expect(result.placed).toEqual([]);
    const rows = await executeSql('SELECT id FROM progress WHERE student_id = $1', [studentId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('grades against the curriculum, not against what the client claims', async () => {
    // A client that reports its own correctness could place itself anywhere.
    const probe = buildProbe(chooseProbeConcepts(SUBJECT, GRADE));
    const answers = probe.items.map(item => ({
      conceptId: item.conceptId,
      chosen: 'Z',
      correct: true, // ignored on purpose
    }));

    const result = await (await submitProbe(probeRequest('POST', { answers }))).json() as any;
    expect(result.placed).toEqual([]);
  });

  it('records the placement as a decision, with what it was based on', async () => {
    const probe = buildProbe(chooseProbeConcepts(SUBJECT, GRADE));
    await submitProbe(probeRequest('POST', {
      answers: probe.items.map(item => ({
        conceptId: item.conceptId,
        chosen: item.question.correctAnswer,
      })),
    }));

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

    const probe = buildProbe(chooseProbeConcepts(SUBJECT, GRADE));
    await submitProbe(probeRequest('POST', {
      answers: probe.items.map(item => ({
        conceptId: item.conceptId,
        chosen: item.question.correctAnswer,
      })),
    }));

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
