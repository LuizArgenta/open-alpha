/**
 * Reading and writing interventions and their runs.
 *
 * The vocabulary, the catalogue and the judgement live in
 * `intervention-contract.ts`, which imports nothing from the database — the
 * same split `event-contract.ts` has from `events.ts`, and for a concrete
 * reason: `db.ts` builds its CHECK constraints from those lists, so a
 * vocabulary module that reached back into `db.ts` would be a cycle.
 */

import { randomUUID } from 'node:crypto';
import { type SqlStatement, executeSql, executeTransaction } from './db.js';
import {
  type ExpectedOutcome,
  type Intervention,
  type InterventionSource,
  type InterventionTarget,
  type InterventionType,
  RUN_ABANDONED_AFTER_DAYS,
  type RunResult,
  type StartRun,
} from './intervention-contract.js';

interface InterventionRow {
  id: number;
  key: string;
  type: string;
  target_kind: string;
  target_id: string | null;
  source: string;
  content_ref: string | null;
  estimated_minutes: number | null;
  version: number;
  status: string;
}

/**
 * The live version of an intervention.
 *
 * `active`, not "anything but retired". Those differ the moment a draft
 * revision of an existing key is written: excluding only retired rows picks
 * the newest draft, and since `submit.ts` uses this to choose what a student
 * actually receives, an unpublished definition would start taking real runs
 * the instant someone saved it. A draft is a draft.
 */
export async function findIntervention(key: string): Promise<Intervention | undefined> {
  const rows = await executeSql<InterventionRow>(
    `SELECT id, key, type, target_kind, target_id, source, content_ref,
            estimated_minutes, version, status
     FROM interventions WHERE key = $1 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [key]
  );
  const row = rows.rows[0];
  if (!row) return undefined;
  return {
    id: Number(row.id),
    key: row.key,
    type: row.type as InterventionType,
    targetKind: row.target_kind as InterventionTarget,
    targetId: row.target_id,
    source: row.source as InterventionSource,
    contentRef: row.content_ref,
    estimatedMinutes: row.estimated_minutes === null ? null : Number(row.estimated_minutes),
    version: Number(row.version),
    status: row.status,
  };
}

/**
 * The statement that starts a run, for a caller that has to write it inside
 * the transaction that produced the decision.
 *
 * Same reasoning `decisionStatement` gives: these are the grounds for the rows
 * beside them, and a write that lands without its justification is worse than
 * one that fails. `submit.ts` writes the progress update, the decision and
 * this run together or not at all.
 */
export function startRunStatement(
  run: StartRun,
  interventionId: number
): { statement: SqlStatement; runId: string } {
  // The id is minted here and handed back rather than left inside the SQL,
  // because the response now names the run: the client is told which
  // intervention it was given, not merely what to do.
  const runId = randomUUID();
  const statement: SqlStatement = {
    sql: `INSERT INTO intervention_runs
            (run_id, intervention_id, student_id, decision_id, subject, concept_id,
             target_concept_id, reason, evidence, expected_outcome)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    params: [
      runId,
      interventionId,
      run.studentId,
      run.decisionId ?? null,
      run.subject,
      run.conceptId,
      // Null when the offer and the measurement are the same concept, which
      // is most of the time. Only a prerequisite review splits them.
      run.targetConceptId && run.targetConceptId !== run.conceptId ? run.targetConceptId : null,
      run.reason,
      JSON.stringify(run.evidence),
      JSON.stringify(run.expectedOutcome),
    ],
  };
  return { statement, runId };
}

export interface OpenRun {
  id: number;
  runId: string;
  interventionId: number;
  expectedOutcome: ExpectedOutcome;
  startedAt: string;
}

interface OpenRunRow {
  id: number;
  run_id: string;
  intervention_id: number;
  expected_outcome: string;
  started_at: string;
}

/** Runs still waiting on a result, oldest first. */
/** Runs a query, either directly or inside a transaction that owns the lock. */
export type Runner = <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

export const directRunner: Runner = <T>(sql: string, params?: unknown[]) =>
  executeSql<T>(sql, params) as Promise<{ rows: T[] }>;

/**
 * Runs still waiting on a result, oldest first.
 *
 * Takes a runner so the caller can read *inside* its own transaction. That is
 * not a nicety: read before the transaction, two submissions of two attempts
 * on the same concept both see the same open run, and each starts a
 * replacement — leaving two open runs that a later attempt would credit with
 * one outcome. The same shape `scoreFromStoredAnswers` uses, and for the same
 * reason.
 */
export async function openRunsFor(
  runner: Runner,
  studentId: number,
  subject: string,
  conceptId: string
): Promise<OpenRun[]> {
  const rows = await runner<OpenRunRow>(
    `SELECT id, run_id, intervention_id, expected_outcome, started_at
     FROM intervention_runs
     WHERE student_id = $1 AND subject = $2 AND concept_id = $3 AND completed_at IS NULL
     ORDER BY started_at ASC, id ASC`,
    [studentId, subject, conceptId]
  );

  return rows.rows.flatMap((row: OpenRunRow) => {
    let expectedOutcome: ExpectedOutcome;
    try {
      expectedOutcome = JSON.parse(row.expected_outcome) as ExpectedOutcome;
    } catch {
      // A run whose prediction cannot be read cannot be judged against one.
      // Skipping it leaves it open rather than scoring it arbitrarily.
      return [];
    }
    return [{
      id: Number(row.id),
      runId: row.run_id,
      interventionId: Number(row.intervention_id),
      expectedOutcome,
      startedAt: row.started_at,
    }];
  });
}

export function completeRunStatement(runId: number, result: RunResult): SqlStatement {
  return {
    sql: `UPDATE intervention_runs
          SET completed_at = datetime('now'), outcome = $1, evidence_summary = $2
          WHERE id = $3 AND completed_at IS NULL`,
    params: [result.outcome, JSON.stringify(result.evidenceSummary), runId],
  };
}

export async function abandonStaleRuns(studentId: number): Promise<void> {
  await executeTransaction([{
    sql: `UPDATE intervention_runs
          SET completed_at = datetime('now'),
              outcome = 'abandoned',
              evidence_summary = json_object('reason', 'no_follow_up_within_days',
                                             'days', $1)
          WHERE student_id = $2
            AND completed_at IS NULL
            AND started_at < datetime('now', $3)`,
    params: [RUN_ABANDONED_AFTER_DAYS, studentId, `-${RUN_ABANDONED_AFTER_DAYS} days`],
  }]);
}
