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

/**
 * The student going away and coming back.
 *
 * `takeQuiz` opens, answers and submits inside one second, so without this
 * every follow-up attempt appears to start in the same second the run did —
 * and a run is only judged by an attempt that began strictly after it. Real
 * students take longer than a second to sit a second quiz; the tests have to
 * say so rather than rely on how fast the suite runs.
 */
async function comeBackLater(seconds = 60) {
  await executeSql(
    `UPDATE intervention_runs SET started_at = datetime(started_at, $1) WHERE completed_at IS NULL`,
    [`-${seconds} seconds`]
  );
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

  it('names the run it started in the answer the student gets', async () => {
    const result = await takeQuiz(token, 'math', DECIMALS, 1, 30_000);

    // Item 1.3 deliberately changed nothing for the student; 1.4 is where the
    // engine starts answering with an action. `remediation` is still there —
    // the PRD keeps it for compatibility — and now the run the engine opened
    // is named alongside it, so "what were you given" and "did it work" refer
    // to the same thing.
    expect(result).toMatchObject({ passed: false, remediation: expect.any(Object) });

    const [run] = await runs();
    expect(result.nextAction.interventionRunId).toBe(run.run_id);
  });

  it('starts nothing when the student passes', async () => {
    await takeQuiz(token, 'math', FRACTIONS, 5, 30_000);
    expect(await runs()).toHaveLength(0);
  });
});

describe('the next attempt judges the prediction', () => {
  it('records met when the student reaches the target', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await comeBackLater();
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
    await comeBackLater();
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
    await comeBackLater();
    await takeQuiz(token, 'math', DECIMALS, 1, 400);

    const [run] = await runs();
    expect(run.outcome).toBe('inconclusive');
    expect(JSON.parse(run.evidence_summary!)).toMatchObject({ reason: 'attention_pattern' });
  });

  it('judges only the concept the run was about', async () => {
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await comeBackLater();
    await takeQuiz(token, 'math', FRACTIONS, 5, 30_000);

    const open = (await runs()).filter(run => run.completed_at === null);
    expect(open).toHaveLength(1);
  });
});

/**
 * Three ways the effectiveness data could be corrupted quietly, all found by
 * review on the first version of this PR.
 *
 * Each of them writes an outcome that looks like evidence and is not, which is
 * the worst failure this table can have: a comparison drawn from it would be
 * confidently wrong, and nothing in the numbers would say so.
 */
describe('what must not be counted as an intervention working', () => {
  it('will not judge a run with an attempt the student had already answered', async () => {
    // Two quizzes open on the same concept. The second is answered *before*
    // the first is submitted, so its answers contain no evidence about an
    // intervention that did not exist yet.
    const { POST: answerQuiz } = await import('../api/tutor/quiz/answer.js');
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const { answerKey, callAs } = await import('./helpers/database.js');

    const first = await openQuiz(token, 'math', DECIMALS);
    const second = await openQuiz(token, 'math', DECIMALS);

    for (const quiz of [first, second]) {
      for (const question of quiz.questions) {
        const right = await answerKey(question.itemId);
        await callAs(token, answerQuiz, {
          attemptId: quiz.attemptId,
          itemId: question.itemId,
          chosen: ['A', 'B', 'C', 'D'].find(letter => letter !== right)!,
          responseTimeMs: 30_000,
        });
      }
    }

    await callAs(token, submitQuiz, { attemptId: first.attemptId });
    const opened = await runs();
    expect(opened).toHaveLength(1);

    await callAs(token, submitQuiz, { attemptId: second.attemptId });

    const after = await runs();
    // The run stays open and waits for an attempt that can actually speak to
    // it. And no second run is stacked beside it, which would give the next
    // attempt two runs to resolve identically.
    expect(after).toHaveLength(1);
    expect(after[0].outcome).toBeNull();
  });

  it('resolves that waiting run on the next attempt that begins after it', async () => {
    // The other half: waiting must not mean never. Once a genuine follow-up
    // arrives, the run is judged normally.
    await takeQuiz(token, 'math', DECIMALS, 1, 30_000);
    await comeBackLater();
    await takeQuiz(token, 'math', DECIMALS, 5, 30_000);

    const [run] = await runs();
    expect(run.outcome).toBe('met');
  });

  it('does not hand a student a draft revision of an intervention', async () => {
    const { findIntervention } = await import('../api/_lib/interventions.js');

    // A newer version saved but not published. Selecting "anything not
    // retired" would pick it, and it would start receiving real runs the
    // moment someone saved it.
    await executeSql(
      `INSERT INTO interventions (key, type, target_kind, source, version, status)
       VALUES ('engine.extra_practice', 'practice', 'concept', 'engine', 2, 'draft')`
    );

    const live = await findIntervention('engine.extra_practice');
    expect(live?.version).toBe(1);
    expect(live?.status).toBe('active');

    await executeSql("DELETE FROM interventions WHERE key = 'engine.extra_practice' AND version = 2");
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
