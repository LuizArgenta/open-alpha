/**
 * The guardrail, as a test rather than a sentence.
 *
 * The PRD states it plainly: *Intervention cannot become "a new lessons
 * table". If it does not represent a human action, an external resource and an
 * AI action with equal naturalness, the design has failed.*
 *
 * A guardrail nobody exercises is a paragraph. The obvious way to fail it is
 * to build the table around the four things the engine happens to produce
 * today and discover, the first time a teacher assigns anything, that the
 * schema has no room for it — by which point there are runs in it and the
 * migration is expensive.
 *
 * So this runs a teacher's action, an outside video, a tutoring session and a
 * peer activity through **exactly the code path the engine uses**: same table,
 * same run, same prediction recorded before the result, same judgement after
 * it. No branch anywhere reads `source`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSql, executeTransaction } from '../api/_lib/db.js';
import { createUser, resetDatabase } from './helpers/database.js';
import {
  completeRunStatement,
  findIntervention,
  openRunsFor,
  startRunStatement,
} from '../api/_lib/interventions.js';
import {
  type ExpectedOutcome,
  type InterventionSource,
  type InterventionType,
  judgeRun,
} from '../api/_lib/intervention-contract.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

let studentId: number;

/** Anything anyone might do for a student, entered the same way. */
async function define(intervention: {
  key: string;
  type: InterventionType;
  source: InterventionSource;
  targetKind: string;
  targetId?: string;
  contentRef?: string;
  estimatedMinutes?: number;
}) {
  await executeTransaction([{
    sql: `INSERT INTO interventions
            (key, type, target_kind, target_id, source, content_ref, estimated_minutes, version, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'active')`,
    params: [
      intervention.key, intervention.type, intervention.targetKind,
      intervention.targetId ?? null, intervention.source,
      intervention.contentRef ?? null, intervention.estimatedMinutes ?? null,
    ],
  }]);
  return (await findIntervention(intervention.key))!;
}

const EXPECTED: ExpectedOutcome = {
  metric: 'mastery_score',
  subject: SUBJECT,
  conceptId: CONCEPT,
  baseline: 40,
  target: 80,
  within: 'next_attempt',
};

/**
 * The catalogue is not test data.
 *
 * `resetDatabase` deliberately leaves `interventions` alone — the engine's
 * four rows are seeded by migration and deleting them would break every later
 * file. Which means the ones invented here leak, so this file clears its own:
 * anything not from the engine belongs to a test.
 */
async function forgetInventedInterventions() {
  // Runs first: they reference the catalogue, and the last test in this file
  // leaves completed ones behind that afterAll would otherwise trip over.
  await executeSql(
    "DELETE FROM intervention_runs WHERE intervention_id IN (SELECT id FROM interventions WHERE source != 'engine')"
  );
  await executeSql("DELETE FROM interventions WHERE source != 'engine'");
}

beforeEach(async () => {
  await resetDatabase();
  await forgetInventedInterventions();
  studentId = await createUser('student');
});

afterAll(forgetInventedInterventions);

describe('an intervention is not a lesson', () => {
  /**
   * Four sources, one path. If any of these needed a special case — a nullable
   * column only teachers use, a branch on `source`, a second table — that
   * would be the design failing, and this is where it would show.
   */
  const cases: Array<{
    label: string;
    key: string;
    type: InterventionType;
    source: InterventionSource;
    targetKind: string;
    targetId?: string;
    contentRef?: string;
  }> = [
    {
      label: 'a teacher sitting with the student',
      key: 'teacher.one_on_one',
      type: 'teacher_action',
      source: 'teacher',
      targetKind: 'concept',
      targetId: CONCEPT,
    },
    {
      label: 'a video someone else made',
      key: 'external.khan_fractions',
      type: 'external_resource',
      source: 'external',
      targetKind: 'concept',
      targetId: CONCEPT,
      // Content living outside this database is the normal case, not the
      // exception: the point of the open-content thesis is that most of it
      // will be someone else's.
      contentRef: 'https://example.org/fractions',
    },
    {
      label: 'a model tutoring against a named misconception',
      key: 'ai.socratic_on_misconception',
      type: 'ai_tutoring',
      source: 'ai',
      // A misconception is as legitimate a target as a concept. This is the
      // one an engine-shaped schema would have had no column for.
      targetKind: 'misconception',
      targetId: 'numerator-only-addition',
    },
    {
      label: 'two students working through it together',
      key: 'peer.pair_practice',
      type: 'peer_activity',
      source: 'peer',
      targetKind: 'skill',
      targetId: 'fraction_addition',
    },
  ];

  for (const testCase of cases) {
    it(`runs ${testCase.label} through the same path as the engine`, async () => {
      const intervention = await define(testCase);

      await executeTransaction([startRunStatement({
        interventionKey: intervention.key,
        studentId,
        subject: SUBJECT,
        conceptId: CONCEPT,
        reason: 'knowledge_gap',
        evidence: { score: 40 },
        expectedOutcome: EXPECTED,
      }, intervention.id)]);

      // Found by the same query the engine's own runs are found by. No filter
      // on source anywhere in it.
      const open = await openRunsFor(studentId, SUBJECT, CONCEPT);
      expect(open).toHaveLength(1);
      expect(open[0].expectedOutcome).toEqual(EXPECTED);

      // And judged by the same rule, against a prediction recorded before it.
      await executeTransaction([completeRunStatement(
        open[0].id,
        judgeRun(open[0].expectedOutcome, { score: 90, attention: false })
      )]);

      const stored = await executeSql<{ outcome: string; source: string; content_ref: string | null }>(
        `SELECT r.outcome, i.source, i.content_ref
         FROM intervention_runs r JOIN interventions i ON i.id = r.intervention_id`
      );
      expect(stored.rows[0].outcome).toBe('met');
      expect(stored.rows[0].source).toBe(testCase.source);
      expect(stored.rows[0].content_ref).toBe(testCase.contentRef ?? null);

      expect(await openRunsFor(studentId, SUBJECT, CONCEPT)).toHaveLength(0);
    });
  }

  it('compares a teacher\'s action against the engine\'s on the same terms', async () => {
    // The comparison the moat rests on. Two interventions, same student, same
    // concept, same prediction — so the only difference in the result is the
    // intervention. Nothing about this query knows which is which.
    const teacher = await define({
      key: 'teacher.one_on_one', type: 'teacher_action', source: 'teacher', targetKind: 'concept',
    });
    const engine = (await findIntervention('engine.review_prerequisites'))!;

    for (const [index, intervention] of [teacher, engine].entries()) {
      const otherStudent = await createUser('student');
      await executeTransaction([startRunStatement({
        interventionKey: intervention.key,
        studentId: otherStudent,
        subject: SUBJECT,
        conceptId: CONCEPT,
        reason: 'knowledge_gap',
        evidence: { score: 40 },
        expectedOutcome: EXPECTED,
      }, intervention.id)]);

      const [run] = await openRunsFor(otherStudent, SUBJECT, CONCEPT);
      await executeTransaction([completeRunStatement(
        run.id,
        judgeRun(run.expectedOutcome, { score: index === 0 ? 95 : 55, attention: false })
      )]);
    }

    const byIntervention = await executeSql<{ key: string; outcome: string; n: number }>(
      `SELECT i.key, r.outcome, COUNT(*) AS n
       FROM intervention_runs r JOIN interventions i ON i.id = r.intervention_id
       WHERE r.completed_at IS NOT NULL
       GROUP BY i.key, r.outcome ORDER BY i.key`
    );

    expect(byIntervention.rows).toEqual([
      { key: 'engine.review_prerequisites', outcome: 'not_met', n: 1 },
      { key: 'teacher.one_on_one', outcome: 'met', n: 1 },
    ]);
  });
});
