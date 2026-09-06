/**
 * The lifetime of an open assessment attempt.
 *
 * An attempt used to stay open forever: a student could open a quiz, close the
 * tab, look the answers up, and come back the next day to submit. Everything
 * the engine infers from an attempt — mastery, the pace signals that separate
 * "rushed" from "has a real gap", the review schedule — assumes the attempt
 * happened in one sitting.
 *
 * Two hours is deliberately generous. A child who steps away for lunch should
 * come back to the same quiz; a child who comes back tomorrow should get a
 * fresh one. Nothing is lost by expiring: the answers already graded stay on
 * the attempt as evidence, and a new attempt costs a click.
 */

import { executeSql, executeTransaction } from './db.js';
import { recordEvent } from './events.js';

export const ATTEMPT_LIFETIME_MINUTES = 120;

/** For `datetime('now', ...)`: the moment before which an attempt is stale. */
export const ATTEMPT_DEADLINE_MODIFIER = `-${ATTEMPT_LIFETIME_MINUTES} minutes`;

/**
 * Closes attempts this student left open past the deadline.
 *
 * Serverless has no cron to sweep with, so the sweep rides on the next thing
 * the student does. `expired_at` distinguishes an attempt that timed out from
 * one that was submitted: a finished attempt with no score would otherwise be
 * indistinguishable from a bug.
 */
export async function expireStaleAttempts(studentId: number): Promise<number> {
  const result = await executeSql(
    `UPDATE assessment_attempts
     SET expired_at = datetime('now'), finished_at = datetime('now')
     WHERE student_id = $1 AND finished_at IS NULL AND started_at < datetime('now', $2)`,
    [studentId, ATTEMPT_DEADLINE_MODIFIER]
  );
  return result.rowCount;
}

/**
 * Expires one attempt on the spot. Called when a request arrives for an
 * attempt that is already past its deadline, so the row reflects why the
 * request was refused.
 */
export async function expireAttempt(attemptId: number): Promise<void> {
  // Read before the write, so the event can name what expired. An attempt that
  // times out is a different fact from a browser reporting the person walked
  // away, and the stream keeps them apart.
  const attempt = await executeSql<{ student_id: number; subject: string; concept_id: string }>(
    'SELECT student_id, subject, concept_id FROM assessment_attempts WHERE id = $1 AND finished_at IS NULL',
    [attemptId]
  );

  // Queued rather than issued bare, for the same reason the answer insert is:
  // a lone write racing another request's write transaction gets SQLITE_BUSY,
  // and the student sees "something broke" for an attempt that merely timed
  // out. executeTransaction runs through the write queue, so in one process
  // the two take turns instead of colliding.
  await executeTransaction([
    {
      sql: `UPDATE assessment_attempts
            SET expired_at = datetime('now'), finished_at = datetime('now')
            WHERE id = $1 AND finished_at IS NULL`,
      params: [attemptId],
    },
  ]);

  const row = attempt.rows[0];
  if (row) {
    await recordEvent({
      studentId: row.student_id,
      subject: row.subject,
      conceptId: row.concept_id,
      type: 'quiz_expired',
      attemptId,
    });
  }
}

/** 410: the attempt existed and is gone, which is exactly what happened. */
export function attemptExpired(): Response {
  return Response.json(
    { error: 'Attempt expired', expiredAfterMinutes: ATTEMPT_LIFETIME_MINUTES },
    { status: 410 }
  );
}
