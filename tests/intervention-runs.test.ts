/**
 * The loop this table exists to close.
 *
 * `learning_decisions` already records *what* the engine chose and on what
 * grounds. What it cannot record is what the choice was supposed to achieve —
 * so there has never been a way to find out whether any of it works. The
 * question the whole design is for is comparative:
 *
 * > For students with misconception X in context Y, which intervention
 * > produces the larger gain and the better retention?
 *
 * That question is unanswerable without a prediction written down *before* the
 * result, because an explanation is always available for something that has
 * already happened. `expected_outcome` is that prediction, and these tests
 * cover it being written at the start and judged at the end.
 *
 * Nothing here changes for the student. Item 1.3's criterion is that the
 * current flow is encapsulated, and `keeps the student's experience
 * unchanged` below is the one that says so.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, openQuiz, resetDatabase, takeQuiz } from './helpers/database.js';
import { judgeRun } from '../api/_lib/intervention-contract.js';

const FRACTIONS = 'math-fractions-intro';
/** A concept with a prerequisite, so the engine has somewhere to send them. */
const DECIMALS = 'math-decimals';

interface RunRow {
  run_id: string;
  intervention_key: string;
  reason: string;
  evidence: string;
  expected_outcome: string;
  completed_at: string | null;
  outcome: string | null;
  evidence_summary: string | null;
  decision_id: number | null;
}

async function runs(): Promise<RunRow[]> {
  const result = await executeSql<RunRow>(
    `SELECT r.run_id, i.key AS intervention_key, r.reason, r.evidence, r.expected_outcome,
            r.completed_at, r.outcome, r.evidence_summary, r.decision_id
     FROM intervention_runs r JOIN interventions i ON i.id = r.intervention_id
     ORDER BY r.id ASC`
  );
  return result.rows;
}

let studentId: number;
let token: string;

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
  token = signToken({ userId: studentId, role: 'student' });
});

describe('the engine catalogue', () => {
  it('is seeded by migration, and is not a table of lessons', async () => {
    const catalogue = await executeSql<{ key: string; type: string; source: string }>(
      "SELECT key, type, source FROM interventions ORDER BY key"
    );

    expect(catalogue.rows.map(row => row.key)).toEqual([
      'engine.extra_practice',
      'engine.review_prerequisites',
      'engine.simpler_explanation',
      'engine.sub_skill',
    ]);
    // Every seeded row is the engine's own. Teacher, AI and external sources
    // are equally representable — see intervention-guardrail.test.ts — they
    // simply have no author yet.
    expect(catalogue.rows.every(row => row.source === 'engine')).toBe(true);
  });
});

describe('failing a mastery check', () => {
  it('starts a run carrying what it expects to achieve', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    const [run] = await runs();
    expect(run).toBeDefined();
    expect(run.completed_at).toBeNull();

    const expected = JSON.parse(run.expected_outcome);
    expect(expected).toEqual({
      metric: 'mastery_score',
      subject: 'math',
      conceptId: DECIMALS,
      baseline: 20,
      target: 80,
      within: 'next_attempt',
    });

    // Grounds, not just an outcome: a choice about someone has to be
    // contestable, which is the same requirement learning_decisions meets.
    expect(JSON.parse(run.evidence)).toMatchObject({ score: 20, answers: 5 });
    expect(run.decision_id).not.toBeNull();
  });

  it('links the run to the decision that chose it', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    const [run] = await runs();
    const decision = await executeSql<{ kind: string; student_id: number }>(
      'SELECT kind, student_id FROM learning_decisions WHERE id = $1',
      [run.decision_id]
    );
    // Challenging one has to reach the other.
    expect(decision.rows[0].kind).toBe('remediation');
    expect(Number(decision.rows[0].student_id)).toBe(studentId);
  });

  it('keeps the student\'s experience unchanged', async () => {
    const result = await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    // Item 1.3 encapsulates the current flow and nothing more. The response is
    // the same shape it has always been — no interventionId, no nextAction.
    // Those are 1.4.
    expect(result).toMatchObject({ passed: false, remediation: expect.any(Object) });
    expect(result).not.toHaveProperty('nextAction');
    expect(result.remediation).not.toHaveProperty('interventionId');
  });

  it('starts nothing when the student passes', async () => {
    await takeQuiz(token, 'math', FRACTIONS, 5, 30_000);
    expect(await runs()).toHaveLength(0);
  });
});

describe('the next attempt judges the prediction', () => {
  it('records met when the student reaches the target', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await takeQuiz(token, 'math', DECIMALS, 5, 30_000);

    const [run] = await runs();
    expect(run.outcome).toBe('met');
    expect(run.completed_at).not.toBeNull();
    expect(JSON.parse(run.evidence_summary!)).toEqual({
      baseline: 20, target: 80, observed: 100, delta: 80,
    });
  });

  it('records not_met, and keeps the delta that says how close', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await takeQuiz(token, 'math', DECIMALS, 3, 30_000);

    const [run] = await runs();
    expect(run.outcome).toBe('not_met');
    // "Improved by 40 and still failed" and "went backwards" are different
    // facts about the same not_met, and the comparison this table is for
    // needs both.
    expect(JSON.parse(run.evidence_summary!)).toMatchObject({ observed: 60, delta: 40 });
  });

  it('records inconclusive when the follow-up shows rushing, not learning', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    // Answered in under a second each: an attention signal, so this attempt is
    // evidence about focus and not about whether the intervention taught
    // anything. Scoring it against the material would blame the wrong cause.
    await takeQuiz(token, 'math', DECIMALS, 1, 400);

    const [run] = await runs();
    expect(run.outcome).toBe('inconclusive');
    expect(JSON.parse(run.evidence_summary!)).toMatchObject({ reason: 'attention_pattern' });
  });

  it('judges only the concept the run was about', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await takeQuiz(token, 'math', FRACTIONS, 5, 30_000);

    const open = (await runs()).filter(run => run.completed_at === null);
    expect(open).toHaveLength(1);
  });
});

describe('a run the student never comes back to', () => {
  it('is closed as abandoned rather than left to inflate the numbers', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    await executeSql(
      "UPDATE intervention_runs SET started_at = datetime('now', '-30 days')"
    );

    // The sweep rides on the next quiz the student opens, for the same reason
    // expireStaleAttempts does: serverless has nowhere to run one.
    await openQuiz(token, 'math', FRACTIONS);

    const [run] = await runs();
    expect(run.outcome).toBe('abandoned');
    expect(JSON.parse(run.evidence_summary!)).toMatchObject({
      reason: 'no_follow_up_within_days', days: 14,
    });
  });

  it('leaves a recent one alone', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await openQuiz(token, 'math', FRACTIONS);

    const [run] = await runs();
    expect(run.outcome).toBeNull();
  });
});

describe('judging a run', () => {
  const expected = {
    metric: 'mastery_score' as const,
    subject: 'math',
    conceptId: DECIMALS,
    baseline: 40,
    target: 80,
    within: 'next_attempt' as const,
  };

  it('counts reaching the target exactly as met', () => {
    expect(judgeRun(expected, { score: 80, attention: false }).outcome).toBe('met');
  });

  it('records a regression as not_met with a negative delta', () => {
    const result = judgeRun(expected, { score: 20, attention: false });
    expect(result.outcome).toBe('not_met');
    expect(result.evidenceSummary).toMatchObject({ delta: -20 });
  });

  it('never scores an attempt that shows an attention pattern', () => {
    // Even a perfect one: five right answers in two seconds is not evidence
    // that the intervention worked.
    expect(judgeRun(expected, { score: 100, attention: true }).outcome).toBe('inconclusive');
  });
});
