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

import { executeSql, executeTransaction } from './db.js';
import {
  CURRENT_SCHEMA_VERSION,
  ENVELOPE_COLUMNS,
  type EventSource,
  type LearningEventEnvelope,
  type LearningEventRow,
  type LearningEventType,
  newEventId,
  toEnvelope,
} from './event-contract.js';
import { toDbTimestamp } from './time.js';

export type { LearningEventType };

export interface LearningEvent {
  studentId: number;
  subject: string;
  conceptId: string;
  type: LearningEventType;
  /** The attempt this is about, when it is about one. */
  attemptId?: number;
  payload?: Record<string, unknown>;
  /**
   * Who observed it. Defaults to `server`, because that is what this module
   * is: everything written through here is something the engine saw happen.
   */
  source?: EventSource;
  /**
   * When it happened, if that is not now. A browser report is placed when the
   * person did the thing, not when the request arrived.
   */
  occurredAt?: Date;
  /**
   * A client's retry token. Recording the same key twice for the same student
   * is a no-op, so a browser that retries a dropped request does not double
   * its own events. Unique per student, never across students.
   */
  dedupeKey?: string;
}

/**
 * Records one thing the server observed.
 *
 * Never throws, and never awaited for correctness — a caller that depends on
 * this having succeeded has misunderstood what the stream is for.
 *
 * It does *report*, though, which is not the same thing. The endpoint the
 * browser posts to has recording as its entire job, and a client that is told
 * "success" for a write that failed cannot retry. Returning false lets that
 * one caller answer honestly while every other caller keeps ignoring it, which
 * is the correct behaviour for both.
 */
export async function recordEvent(event: LearningEvent): Promise<boolean> {
  try {
    // Queued, not bare. A lone `executeSql` write races any transaction in
    // flight and gets SQLITE_BUSY — the same collision PR #46 fixed for the
    // answer insert and for expireAttempt. Writing it bare here reintroduced
    // it on the first run, which is why this note is longer than the fix.
    await executeTransaction([{
      // ON CONFLICT rather than a read-then-write: two requests racing the
      // same retry token would both find nothing and both insert. The index
      // is the only thing that can decide this, so let it.
      sql: `INSERT INTO learning_events
              (event_id, schema_version, student_id, subject, concept_id, event_type,
               source, attempt_id, occurred_at, dedupe_key, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT DO NOTHING`,
      params: [
        newEventId(),
        CURRENT_SCHEMA_VERSION,
        event.studentId,
        event.subject,
        event.conceptId,
        event.type,
        event.source ?? 'server',
        event.attemptId ?? null,
        toDbTimestamp(event.occurredAt ?? new Date()),
        event.dedupeKey ?? null,
        JSON.stringify(event.payload ?? {}),
      ],
    }]);
    return true;
  } catch (error) {
    console.error(`Failed to record ${event.type} event:`, error);
    return false;
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

/**
 * Reading the stream as envelopes rather than as rows.
 *
 * The reason the contract exists: a consumer written against
 * `LearningEventEnvelope` does not break when a column is renamed, and does
 * not have to know that rows written before v1 have no `event_id` and no
 * `occurred_at`. `toEnvelope` answers for those.
 *
 * Aggregate queries — counting distinct active days, summing a rate — stay in
 * SQL and should. Pulling every row into JavaScript to count them would be
 * slower and no more honest. This is for readers that walk individual events,
 * which is what the waste meter does.
 */
export async function readEvents(query: {
  studentId: number;
  /** Inclusive lower bound on `occurred_at`, as a stored timestamp. */
  since?: string;
  types?: LearningEventType[];
  limit?: number;
}): Promise<LearningEventEnvelope[]> {
  const conditions = ['student_id = $1'];
  const params: (string | number)[] = [query.studentId];

  if (query.since) {
    params.push(query.since);
    conditions.push(`COALESCE(occurred_at, created_at) >= $${params.length}`);
  }
  if (query.types && query.types.length > 0) {
    const placeholders = query.types.map(type => {
      params.push(type);
      return `$${params.length}`;
    });
    conditions.push(`event_type IN (${placeholders.join(', ')})`);
  }

  let sql = `SELECT ${ENVELOPE_COLUMNS} FROM learning_events
             WHERE ${conditions.join(' AND ')}
             ORDER BY COALESCE(occurred_at, created_at) ASC, id ASC`;
  if (query.limit !== undefined) {
    params.push(query.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const result = await executeSql<LearningEventRow>(sql, params);
  return result.rows.map(toEnvelope);
}
