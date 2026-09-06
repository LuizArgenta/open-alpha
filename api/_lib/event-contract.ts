/**
 * The Learning Event Contract, version 1.
 *
 * `learning_events` stops being a telemetry table and becomes a stable,
 * versioned vocabulary of pedagogical happenings. The point is not
 * sophistication — it needs no Kafka and no data lake — it is that later
 * readers (analytics, experiments, evaluating the engine itself, integrations,
 * audit, research) can be written against *this* rather than against the
 * operational tables, which is the coupling that makes a schema impossible to
 * change.
 *
 * ## Why the vocabulary lives here and nowhere else
 *
 * It was in three places and they had already drifted. `events.ts` declared a
 * union of eight types, the CHECK constraint in `db.ts` listed eight, and
 * `progress/events.ts` hardcoded its own array of **seven** — missing
 * `quiz_expired`, so the browser could not report an expiry the server can
 * write. Nothing failed, because nothing compared them. A vocabulary that
 * exists in three copies is not a vocabulary.
 *
 * ## Two non-goals, kept from the PRD
 *
 * 1. **This is not event sourcing.** The operational tables remain the source
 *    of writes; the stream is evidence and telemetry. Every event here is
 *    reconstructible from the rows it describes, which is what makes
 *    best-effort recording acceptable.
 * 2. **This is not a security audit log.** Sign-in, role changes and admin
 *    access want append-only storage and immutability, which are different
 *    properties with different costs. Mixing them would give the worst version
 *    of each.
 *
 * ## What v1 fixes, and what it deliberately leaves out
 *
 * In: a stable event id, a schema version, `occurred_at` separate from
 * `created_at`, and idempotent recording.
 *
 * Out: `organization_id`, `actor_id`, `object_type`/`object_id` and
 * `intervention_id`. Every one of them is in the target envelope, and every
 * one of them would today be written by nothing and read by nothing — this
 * project has found five instances of exactly that shape and the last one was
 * inside the test written to prevent it. They arrive with the entities that
 * give them values: `intervention_id` with `Intervention` in 1.3,
 * `organization_id` with the school layer.
 */

import { randomUUID } from 'node:crypto';

export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Every pedagogical happening the platform names.
 *
 * Adding one means a migration widening the CHECK — deliberately, so the
 * vocabulary cannot grow by accident in a payload field where no reader will
 * ever find it.
 */
export const LEARNING_EVENT_TYPES = [
  /** A lesson was opened. */
  'lesson_start',
  /** A lesson was left, however it ended. */
  'lesson_end',
  /** An attempt was opened around a set of items. */
  'quiz_start',
  /** One item was answered and graded. */
  'quiz_answer',
  /** An attempt was finalised and scored. */
  'quiz_complete',
  /** The server closed an attempt the student abandoned. */
  'quiz_expired',
  /** The student asked for help on an item. */
  'hint_request',
  /** The browser observed the person walk away. */
  'idle_timeout',
] as const;

export type LearningEventType = typeof LEARNING_EVENT_TYPES[number];

export function isLearningEventType(value: unknown): value is LearningEventType {
  return typeof value === 'string' && (LEARNING_EVENT_TYPES as readonly string[]).includes(value);
}

/** The SQL fragment for the CHECK, so the constraint cannot drift from the list. */
export function eventTypeCheckList(): string {
  return LEARNING_EVENT_TYPES.map(type => `'${type}'`).join(', ');
}

/**
 * Where an event came from, which is not a detail.
 *
 * `server` is something the engine observed and can prove from its own tables.
 * `browser` is a report that may have been delayed, retried, or never sent —
 * the streak that read zero for a student who had just sat a quiz was this
 * distinction being absent.
 */
export type EventSource = 'server' | 'browser';

/** One event, as any reader should see it. */
export interface LearningEventEnvelope {
  eventId: string;
  schemaVersion: number;
  studentId: number;
  subject: string;
  conceptId: string;
  type: LearningEventType;
  attemptId: number | null;
  source: EventSource;
  /** When the thing happened. */
  occurredAt: string;
  /** When the platform learned of it. Equal to `occurredAt` for server events. */
  recordedAt: string;
  payload: Record<string, unknown>;
}

/** The row shape, as stored. */
export interface LearningEventRow {
  id: number;
  event_id: string | null;
  schema_version: number | null;
  student_id: number;
  subject: string;
  concept_id: string;
  event_type: string;
  attempt_id: number | null;
  source: string | null;
  occurred_at: string | null;
  created_at: string;
  payload: string | null;
}

export const ENVELOPE_COLUMNS =
  'id, event_id, schema_version, student_id, subject, concept_id, event_type, ' +
  'attempt_id, source, occurred_at, created_at, payload';

/**
 * Reads a stored row as a v1 envelope, including rows written before v1
 * existed.
 *
 * This is the compatibility promise, and it is the reason the migration
 * backfills rather than leaving nulls to every caller: a row from before the
 * contract has no `event_id` and no `occurred_at`, and a reader should not
 * have to know that. It gets an id derived from the row and the moment it was
 * recorded as the moment it happened — which is exactly what was knowable
 * about it.
 */
export function toEnvelope(row: LearningEventRow): LearningEventEnvelope {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed payload costs one event's detail, not the read. The stream
    // is evidence; a reader walking a student's day must not fail on one row.
  }

  return {
    eventId: row.event_id ?? `legacy:${row.id}`,
    schemaVersion: Number(row.schema_version ?? CURRENT_SCHEMA_VERSION),
    studentId: Number(row.student_id),
    subject: row.subject,
    conceptId: row.concept_id,
    // The CHECK constraint is what guarantees this, and it is enforced in the
    // database rather than trusted here.
    type: row.event_type as LearningEventType,
    attemptId: row.attempt_id === null || row.attempt_id === undefined ? null : Number(row.attempt_id),
    source: row.source === 'server' ? 'server' : 'browser',
    occurredAt: row.occurred_at ?? row.created_at,
    recordedAt: row.created_at,
    payload,
  };
}

export function newEventId(): string {
  return randomUUID();
}

/**
 * How far a client-reported time may sit from the server's clock.
 *
 * A browser supplies `occurredAt` because it knows when the person actually
 * did the thing, and a report that arrives late should be placed when it
 * happened rather than when it landed — the waste meter measures gaps between
 * events, so a delayed batch currently reads as focus that never occurred.
 *
 * But it is a *report*, and the waste meter is student-facing. A claimed time
 * outside this window is discarded in favour of the server's, because the
 * alternative is a number a learner can set by editing a request.
 */
export const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_CLIENT_BACKDATE_MS = 24 * 60 * 60 * 1000;

/** The reported time, or the server's when the report is not credible. */
export function credibleOccurredAt(reported: unknown, now: Date = new Date()): Date {
  if (typeof reported !== 'string') return now;
  const claimed = new Date(reported);
  if (Number.isNaN(claimed.getTime())) return now;

  const drift = claimed.getTime() - now.getTime();
  if (drift > MAX_CLIENT_CLOCK_SKEW_MS) return now;
  if (-drift > MAX_CLIENT_BACKDATE_MS) return now;
  return claimed;
}
