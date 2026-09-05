/**
 * A record of what the engine decided about a student and why.
 *
 * learning_events says what the student did. Nothing said what the system
 * did in response — so when the parent dashboard reports that a child "was
 * sent back to an earlier concept", there was no way to show the grounds for
 * it, or to notice that the engine had been making a bad call for weeks.
 *
 * Cheap to keep because the engine is deterministic: the inputs recorded here
 * are the whole basis of the decision, so replaying them reproduces it.
 */

import { type SqlStatement, executeSql } from './db.js';

export type DecisionKind =
  | 'next_concept'
  | 'remediation'
  | 'diagnosis'
  | 'review_schedule'
  | 'xp_award'
  | 'override'
  | 'placement';

export interface DecisionRecord {
  studentId: number;
  kind: DecisionKind;
  /** What was chosen: a concept id, a schedule, a reason code. */
  decision: string;
  /** Machine-readable grounds, stable enough to group and count on. */
  reason: string;
  subject?: string;
  conceptId?: string;
  /** The signals the decision was made from. */
  inputs?: Record<string, unknown>;
}

const INSERT_DECISION = `INSERT INTO learning_decisions (student_id, subject, concept_id, kind, decision, reason, inputs)
   VALUES ($1, $2, $3, $4, $5, $6, $7)`;

function decisionParams(record: DecisionRecord): unknown[] {
  return [
    record.studentId,
    record.subject ?? null,
    record.conceptId ?? null,
    record.kind,
    record.decision,
    record.reason,
    JSON.stringify(record.inputs ?? {}),
  ];
}

/**
 * The same write, queued rather than executed, for callers that need the
 * decision to land in the same transaction as what it describes.
 */
export function decisionStatement(record: DecisionRecord): SqlStatement {
  return { sql: INSERT_DECISION, params: decisionParams(record) };
}

/**
 * Never throws: a decision that cannot be logged is still a decision the
 * student is entitled to. Losing the audit trail is bad, failing the request
 * the student is waiting on is worse.
 */
export async function recordDecision(record: DecisionRecord): Promise<void> {
  try {
    await executeSql(INSERT_DECISION, decisionParams(record));
  } catch (error) {
    console.error('Failed to record learning decision:', error);
  }
}
