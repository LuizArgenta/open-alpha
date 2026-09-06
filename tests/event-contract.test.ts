/**
 * The contract, tested as a contract.
 *
 * Three things it has to be true of, and all three were false before:
 *
 * 1. **One vocabulary.** It lived in three copies and they had already
 *    diverged — `progress/events.ts` accepted seven types where the schema
 *    allows eight, so a browser could not report an expiry. Nothing compared
 *    them, so nothing failed.
 * 2. **Idempotent recording.** The endpoint is called by a
 *    `fetch(...).catch(() => {})`, which is the one shape where a retry is
 *    both likely and unaccounted for.
 * 3. **`occurred_at` separate from `created_at`.** The waste meter measures
 *    gaps between events to infer focus, and was measuring the gaps between
 *    the moments requests landed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';
import {
  CURRENT_SCHEMA_VERSION,
  LEARNING_EVENT_TYPES,
  credibleOccurredAt,
  toEnvelope,
} from '../api/_lib/event-contract.js';
import { readEvents, recordEvent } from '../api/_lib/events.js';

async function postEvent(token: string, body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import('../api/progress/events.js');
  return POST(new Request('https://test.local/api/progress/events', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

let studentId: number;
let token: string;

beforeEach(async () => {
  await resetDatabase();
  studentId = await createUser('student');
  token = signToken({ userId: studentId, role: 'student' });
});

describe('one vocabulary', () => {
  it('is the same list the database enforces', async () => {
    // The drift this closes: the endpoint's own array was missing
    // `quiz_expired`, so the schema allowed an event the API refused.
    for (const type of LEARNING_EVENT_TYPES) {
      const response = await postEvent(token, {
        subject: 'math', conceptId: 'frac', eventType: type,
      });
      expect(response.status, `endpoint rejected ${type}`).toBe(200);
    }

    const stored = await executeSql<{ n: number }>(
      'SELECT COUNT(DISTINCT event_type) AS n FROM learning_events'
    );
    expect(Number(stored.rows[0].n)).toBe(LEARNING_EVENT_TYPES.length);
  });

  it('refuses a type outside it', async () => {
    const response = await postEvent(token, {
      subject: 'math', conceptId: 'frac', eventType: 'vibes_check',
    });
    expect(response.status).toBe(400);
  });
});

describe('every event carries its own identity', () => {
  it('stamps a unique id and the schema version', async () => {
    await recordEvent({ studentId, subject: 'math', conceptId: 'frac', type: 'quiz_start' });
    await recordEvent({ studentId, subject: 'math', conceptId: 'frac', type: 'quiz_complete' });

    const rows = await executeSql<{ event_id: string; schema_version: number }>(
      'SELECT event_id, schema_version FROM learning_events ORDER BY id'
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].event_id).not.toBe(rows.rows[1].event_id);
    for (const row of rows.rows) {
      expect(row.event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number(row.schema_version)).toBe(CURRENT_SCHEMA_VERSION);
    }
  });
});

describe('recording the same report twice', () => {
  it('is a no-op for one student', async () => {
    const report = {
      subject: 'math', conceptId: 'frac', eventType: 'lesson_start', dedupeKey: 'retry-me',
    };

    expect((await postEvent(token, report)).status).toBe(200);
    // The retry answers 200 too: from the client's side the report landed,
    // which is true. Reporting a conflict would push a caller into a loop.
    expect((await postEvent(token, report)).status).toBe(200);

    const rows = await executeSql<{ n: number }>('SELECT COUNT(*) AS n FROM learning_events');
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  /**
   * Why the retry token is not the event id.
   *
   * The obvious design lets the client supply the event id and makes that
   * globally unique — and hands one learner the ability to erase another's
   * event by writing their id first. Uniqueness is per student, so a replay
   * can only ever collide with its own author.
   */
  it('cannot suppress another student\'s event', async () => {
    const otherToken = signToken({ userId: await createUser('student'), role: 'student' });
    const key = { subject: 'math', conceptId: 'frac', eventType: 'lesson_start', dedupeKey: 'shared' };

    expect((await postEvent(token, key)).status).toBe(200);
    expect((await postEvent(otherToken, key)).status).toBe(200);

    const rows = await executeSql<{ n: number }>('SELECT COUNT(*) AS n FROM learning_events');
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('does not collapse two genuine events that carry no key', async () => {
    const report = { subject: 'math', conceptId: 'frac', eventType: 'hint_request' };
    await postEvent(token, report);
    await postEvent(token, report);

    // Two hints asked for is two hints asked for. Only an explicit key means
    // "this is the same report again".
    const rows = await executeSql<{ n: number }>('SELECT COUNT(*) AS n FROM learning_events');
    expect(Number(rows.rows[0].n)).toBe(2);
  });
});

describe('when it happened, against when we heard', () => {
  it('places a late report at the moment the student did it', async () => {
    const earlier = new Date(Date.now() - 30 * 60 * 1000);

    await postEvent(token, {
      subject: 'math', conceptId: 'frac', eventType: 'lesson_start',
      occurredAt: earlier.toISOString(),
    });

    const [event] = await readEvents({ studentId });
    expect(event.occurredAt).not.toBe(event.recordedAt);
    expect(new Date(`${event.occurredAt}Z`).getTime())
      .toBeCloseTo(earlier.getTime(), -4);
    expect(event.source).toBe('browser');
  });

  it('stores it in the one shape the schema uses', async () => {
    await postEvent(token, {
      subject: 'math', conceptId: 'frac', eventType: 'lesson_start',
      occurredAt: new Date().toISOString(),
    });

    // Not the ISO string verbatim: two notations in one column order wrongly
    // on a string compare, so rows a minute apart could come back reversed.
    const rows = await executeSql<{ occurred_at: string }>(
      'SELECT occurred_at FROM learning_events'
    );
    expect(rows.rows[0].occurred_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('does not let a student post themselves into the future', async () => {
    // The guard has unit tests below, and unit tests would not have noticed the
    // endpoint dropping the call — which is this project's recurring defect,
    // caught here by reverting the wiring and watching nothing fail.
    const ahead = new Date(Date.now() + 3 * 60 * 60 * 1000);

    await postEvent(token, {
      subject: 'math', conceptId: 'frac', eventType: 'lesson_start',
      occurredAt: ahead.toISOString(),
    });

    const [event] = await readEvents({ studentId });
    expect(new Date(`${event.occurredAt}Z`).getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('does not let one backdate a lesson into last month', async () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    await postEvent(token, {
      subject: 'math', conceptId: 'frac', eventType: 'lesson_start',
      occurredAt: longAgo.toISOString(),
    });

    const [event] = await readEvents({ studentId });
    expect(new Date(`${event.occurredAt}Z`).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  describe('a claimed time is a report, not a fact', () => {
    const now = new Date('2026-09-06T12:00:00.000Z');

    it('takes a plausible one', () => {
      const claimed = new Date('2026-09-06T11:30:00.000Z');
      expect(credibleOccurredAt(claimed.toISOString(), now)).toEqual(claimed);
    });

    it('refuses the future', () => {
      // The waste meter is student-facing. A time set by editing a request is
      // a focus score set by editing a request.
      expect(credibleOccurredAt('2026-09-09T12:00:00.000Z', now)).toEqual(now);
    });

    it('refuses a backdate older than a day', () => {
      expect(credibleOccurredAt('2026-08-01T12:00:00.000Z', now)).toEqual(now);
    });

    it('refuses nonsense and absence alike', () => {
      expect(credibleOccurredAt('yesterday-ish', now)).toEqual(now);
      expect(credibleOccurredAt(undefined, now)).toEqual(now);
      expect(credibleOccurredAt(42, now)).toEqual(now);
    });
  });
});

describe('rows written before the contract existed', () => {
  /**
   * The compatibility promise. A reader written against the envelope must not
   * have to know that the stream has a before and an after.
   */
  it('read back as valid v1 envelopes', () => {
    const envelope = toEnvelope({
      id: 17,
      event_id: null,
      schema_version: null,
      student_id: 3,
      subject: 'math',
      concept_id: 'frac',
      event_type: 'lesson_start',
      attempt_id: null,
      source: null,
      occurred_at: null,
      created_at: '2024-01-01 09:00:00',
      payload: null,
    });

    expect(envelope).toEqual({
      eventId: 'legacy:17',
      schemaVersion: 1,
      studentId: 3,
      subject: 'math',
      conceptId: 'frac',
      type: 'lesson_start',
      attemptId: null,
      // Absent means browser: nothing but the browser wrote here before 008.
      source: 'browser',
      occurredAt: '2024-01-01 09:00:00',
      recordedAt: '2024-01-01 09:00:00',
      payload: {},
    });
  });

  it('survive a payload that will not parse', () => {
    // One corrupt row costs that row's detail, not the read. A reader walking
    // a student's day must not fail on it.
    const envelope = toEnvelope({
      id: 1, event_id: 'e', schema_version: 1, student_id: 1, subject: 'math',
      concept_id: 'frac', event_type: 'quiz_answer', attempt_id: 2, source: 'server',
      occurred_at: '2026-01-01 00:00:00', created_at: '2026-01-01 00:00:00',
      payload: '{"correct": tr',
    });
    expect(envelope.payload).toEqual({});
    expect(envelope.attemptId).toBe(2);
  });
});
