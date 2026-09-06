/**
 * What the server knows, written down.
 *
 * `learning_events` had one writer: `progress/events.ts`, which the browser
 * calls and whose failures it swallows with `.catch(() => {})`. Everything the
 * engine knows for certain — an attempt opened, an answer graded, a quiz
 * finalised, an attempt expired — was absent from the stream, and a dropped
 * request left no trace of the gap. The dashboard showed a streak of zero for
 * a student who had just sat a quiz, and that was the symptom.
 *
 * Making this table a canonical contract while the browser was its only writer
 * would have canonised the holes. The server writes first; the contract comes
 * after.
 *
 * **Written after the transaction commits, never inside it, and never
 * throwing.** Three reasons, in order of weight:
 *
 * 1. The operational tables remain the source of truth. This is telemetry and
 *    evidence, not event sourcing — every event here is reconstructible from
 *    the rows it describes, which is what makes best-effort acceptable.
 * 2. Holding a write transaction open across extra statements is what produced
 *    the SQLITE_BUSY that PR #46 had to fix. A longer lock costs learners.
 * 3. A lost event understates telemetry. A failed insert inside the submission
 *    would lose a student's finished quiz. Those are not comparable.
 */

import { executeTransaction } from './db.js';

export type LearningEventType =
  | 'lesson_start'
  | 'lesson_end'
  | 'quiz_start'
  | 'quiz_answer'
  | 'quiz_complete'
  | 'quiz_expired'
  | 'hint_request'
  | 'idle_timeout';

export interface LearningEvent {
  studentId: number;
  subject: string;
  conceptId: string;
  type: LearningEventType;
  /** The attempt this is about, when it is about one. */
  attemptId?: number;
  payload?: Record<string, unknown>;
}

/**
 * Records one thing the server observed.
 *
 * Never throws, and never awaited for correctness — a caller that depends on
 * this having succeeded has misunderstood what the stream is for.
 */
export async function recordEvent(event: LearningEvent): Promise<void> {
  try {
    // Queued, not bare. A lone `executeSql` write races any transaction in
    // flight and gets SQLITE_BUSY — the same collision PR #46 fixed for the
    // answer insert and for expireAttempt. Writing it bare here reintroduced
    // it on the first run, which is why this note is longer than the fix.
    await executeTransaction([{
      sql: `INSERT INTO learning_events
              (student_id, subject, concept_id, event_type, source, attempt_id, payload)
            VALUES ($1, $2, $3, $4, 'server', $5, $6)`,
      params: [
        event.studentId,
        event.subject,
        event.conceptId,
        event.type,
        event.attemptId ?? null,
        JSON.stringify(event.payload ?? {}),
      ],
    }]);
  } catch (error) {
    console.error(`Failed to record ${event.type} event:`, error);
  }
}

/**
 * Records several, independently.
 *
 * Not a transaction on purpose: one malformed event must not take the others
 * with it, and none of them is worth failing a request over.
 */
export async function recordEvents(events: LearningEvent[]): Promise<void> {
  for (const event of events) {
    await recordEvent(event);
  }
}
