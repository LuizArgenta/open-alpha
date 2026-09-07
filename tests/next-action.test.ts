/**
 * The engine answers with an action, not a place.
 *
 * Two endpoints decided what a student should do and neither said so. `next`
 * returned a concept — the same shape whether the engine was moving the
 * student forward or sending them back to something they had not got — and
 * `submit` returned a remediation the client had to interpret.
 *
 * The interpretation was visibly wrong. The results screen showed a button
 * whenever the remediation happened to carry a `conceptId`, so a student told
 * "let's try explaining this another way" was given nothing to click, while a
 * student sent to a sub-skill got a button. Nobody decided that; it fell out
 * of which fields a shape happened to have.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase, takeQuiz } from './helpers/database.js';
import { NEXT_ACTION_TYPES, POLICY_VERSION } from '../api/_lib/next-action.js';

const FRACTIONS = 'math-fractions-intro';
const DECIMALS = 'math-decimals';

interface NextResponse {
  concept: { id: string; name: string } | null;
  nextAction: {
    type: string;
    reason: string;
    conceptId?: string;
    conceptName?: string;
    interventionRunId?: string;
    policyVersion: number;
  } | null;
}

async function nextFor(subject: string): Promise<NextResponse> {
  const { GET } = await import('../api/tutor/next/[subject].js');
  const response = await GET(new Request(`https://test.local/api/tutor/next/${subject}`, {
    headers: { authorization: `Bearer ${token}` },
  }));
  return response.json() as Promise<NextResponse>;
}

let studentId: number;
let token: string;

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
  token = signToken({ userId: studentId, role: 'student' });
});

describe('what to study next', () => {
  it('says move forward, and names the concept', async () => {
    const body = await nextFor('math');

    expect(body.nextAction).toMatchObject({
      type: 'study_concept',
      reason: 'next_in_sequence',
      conceptId: body.concept!.id,
      conceptName: body.concept!.name,
      policyVersion: POLICY_VERSION,
    });
  });

  it('keeps `concept` for the client that has not moved yet', async () => {
    const body = await nextFor('math');
    // The PRD is explicit that the old field stays. A contract change that
    // breaks the running client is a contract change nobody can deploy.
    expect(body.concept?.id).toBe(body.nextAction?.conceptId);
  });

  it('distinguishes stepping back from moving on', async () => {
    // Three failures on the concept the engine had chosen. This is the one
    // branch that actually reaches back — the grade-4 student was working on
    // fractions and gets sent to division underneath it.
    await executeSql(
      `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at)
       VALUES ($1, 'math', 'math-fractions-intro', 20, 3, datetime('now'))`,
      [studentId]
    );

    const body = await nextFor('math');

    // Under the old contract both cases returned "a concept" and the reason
    // lived only in the decision log. They are different instructions.
    expect(body.concept?.id).toBe('math-division');
    expect(body.nextAction?.type).toBe('review_prerequisite');
    expect(body.nextAction?.reason).toBe('prerequisite_gap');
  });

  /**
   * The bug that made the reason worth getting from the selector rather than
   * inferring it.
   *
   * A student who masters a concept is sent to the next *unseen* one, which by
   * definition has no progress row. "No row for this concept, and progress
   * elsewhere" therefore matched every ordinary advancement — so mastering
   * something told the learner to go back and review it, and the decision log
   * recorded `prerequisite_gap` for the most common move in the system.
   */
  it('calls mastering a concept and moving on exactly that', async () => {
    await executeSql(
      `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at)
       VALUES ($1, 'math', 'math-fractions-intro', 100, 1, datetime('now'))`,
      [studentId]
    );

    const body = await nextFor('math');

    expect(body.nextAction?.type).toBe('study_concept');
    expect(body.nextAction?.reason).toBe('next_in_sequence');

    const decision = await executeSql<{ reason: string }>(
      `SELECT reason FROM learning_decisions WHERE student_id = $1 AND kind = 'next_concept'`,
      [studentId]
    );
    expect(decision.rows[0].reason).toBe('next_in_sequence');
  });

  it('answers null rather than inventing an action', async () => {
    const body = await nextFor('not-a-subject');
    expect(body.concept).toBeNull();
    expect(body.nextAction).toBeNull();
  });
});

describe('what to do after failing', () => {
  it('turns the remediation into an instruction, naming the run it opened', async () => {
    const result = await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    expect(NEXT_ACTION_TYPES).toContain(result.nextAction.type);
    expect(result.nextAction.policyVersion).toBe(POLICY_VERSION);

    // The action and the intervention run are the same event seen from two
    // sides: what the student was told to do, and what the engine is going to
    // be judged on.
    const run = await executeSql<{ run_id: string }>(
      'SELECT run_id FROM intervention_runs WHERE student_id = $1',
      [studentId]
    );
    expect(result.nextAction.interventionRunId).toBe(run.rows[0].run_id);
  });

  it('carries the diagnosis as the reason, so the grounds travel with it', async () => {
    // Answered in under a second each: this is inattention, not a knowledge
    // gap, and the instruction should not claim otherwise.
    const result = await takeQuiz(token, 'math', DECIMALS, 1, 300);
    expect(result.nextAction.reason).toBe(result.diagnosis);
  });

  it('offers no action when the student passed', async () => {
    const result = await takeQuiz(token, 'math', FRACTIONS, 5, 30_000);
    expect(result.passed).toBe(true);
    // Passing is not an instruction to do something else here — the client
    // asks `next` for that. Inventing an action would be the engine
    // pretending to a decision it did not make.
    expect(result.nextAction ?? null).toBeNull();
  });
});

describe('the policy that chose it', () => {
  it('is recorded with the decision, not only returned', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    const decision = await executeSql<{ inputs: string }>(
      `SELECT inputs FROM learning_decisions
       WHERE student_id = $1 AND kind = 'remediation'`,
      [studentId]
    );

    // Without it, a decision recorded before the rules changed cannot be told
    // from one after, and comparing their outcomes compares two things.
    expect(JSON.parse(decision.rows[0].inputs).policyVersion).toBe(POLICY_VERSION);
  });

  it('is recorded on the forward decision too', async () => {
    await nextFor('math');

    const decision = await executeSql<{ inputs: string }>(
      `SELECT inputs FROM learning_decisions
       WHERE student_id = $1 AND kind = 'next_concept'`,
      [studentId]
    );
    expect(JSON.parse(decision.rows[0].inputs).policyVersion).toBe(POLICY_VERSION);
  });
});
