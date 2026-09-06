/**
 * The stream had one writer, and it was the browser.
 *
 * `learning_events` was written only by `progress/events.ts`, which
 * `Quiz.tsx` and `Learn.tsx` call fire-and-forget with `.catch(() => {})`.
 * Everything the server knew for certain — an attempt opened, an answer
 * graded, a quiz finalised, an attempt expired — never reached it, and a
 * dropped request left no trace of the gap. A student who had just sat a quiz
 * showed a streak of zero, which is how this was found.
 *
 * Making that table a canonical contract while the browser was its only writer
 * would have canonised the holes. So: the whole test below reports nothing
 * from a browser, and expects a complete stream anyway.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { answerKey, callAs, createUser, openQuiz, resetDatabase } from './helpers/database.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

interface StoredEvent {
  event_type: string;
  source: string;
  attempt_id: number | null;
  payload: string;
}

async function streamFor(attemptId: number): Promise<StoredEvent[]> {
  const rows = await executeSql<StoredEvent>(
    `SELECT event_type, source, attempt_id, payload FROM learning_events
     WHERE attempt_id = $1 ORDER BY id`,
    [attemptId]
  );
  return rows.rows;
}

let token: string;

beforeEach(async () => {
  await resetDatabase();
  token = signToken({ userId: await createUser('student'), role: 'student' });
});

describe('a quiz sat without the browser reporting anything', () => {
  it('leaves a complete stream behind', async () => {
    const { POST: answerQuiz } = await import('../api/tutor/quiz/answer.js');
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');

    const quiz = await openQuiz(token, SUBJECT, CONCEPT);
    for (const question of quiz.questions) {
      await callAs(token, answerQuiz, {
        attemptId: quiz.attemptId,
        itemId: question.itemId,
        chosen: await answerKey(question.itemId),
        responseTimeMs: 30_000,
      });
    }
    await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    const stream = await streamFor(quiz.attemptId);
    const types = stream.map(event => event.event_type);

    // Opened, five answers graded, finalised — none of it reported by a client.
    expect(types[0]).toBe('quiz_start');
    expect(types.filter(type => type === 'quiz_answer')).toHaveLength(5);
    expect(types[types.length - 1]).toBe('quiz_complete');

    // Every one of them attributable, and joinable back to the evidence.
    expect(stream.every(event => event.source === 'server')).toBe(true);
    expect(stream.every(event => event.attempt_id === quiz.attemptId)).toBe(true);
  });

  it('records what the submission concluded, not just that it happened', async () => {
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);
    await callAs(token, submitQuiz, { attemptId: quiz.attemptId });

    const complete = (await streamFor(quiz.attemptId))
      .find(event => event.event_type === 'quiz_complete');
    const payload = JSON.parse(complete!.payload) as Record<string, unknown>;

    // An event saying only "a quiz finished" would need a join to mean
    // anything; the conclusion travels with it.
    expect(payload).toHaveProperty('score');
    expect(payload).toHaveProperty('passed');
    expect(payload).toHaveProperty('diagnosis');
  });
});

describe('an attempt that timed out', () => {
  it('is recorded as expired, which is not the same as walking away', async () => {
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);

    await executeSql(
      "UPDATE assessment_attempts SET started_at = datetime('now', '-1 day') WHERE id = $1",
      [quiz.attemptId]
    );
    const response = await callAs(token, submitQuiz, { attemptId: quiz.attemptId });
    expect(response.status).toBe(410);

    const types = (await streamFor(quiz.attemptId)).map(event => event.event_type);
    // `quiz_expired` is the server closing a stale attempt. `idle_timeout` is
    // the browser noticing a person left. Collapsing them would lose the
    // distinction the focus diagnosis rests on.
    expect(types).toContain('quiz_expired');
    expect(types).not.toContain('idle_timeout');
  });
});

describe('the stream never costs a learner their work', () => {
  it('finishes the quiz even when the event write fails', async () => {
    const { POST: submitQuiz } = await import('../api/tutor/quiz/submit.js');
    const quiz = await openQuiz(token, SUBJECT, CONCEPT);

    await executeSql('DROP TABLE learning_events');

    // Telemetry is reconstructible from the operational tables; a lost
    // submission is not. The trade is deliberate and this pins it.
    const response = await callAs(token, submitQuiz, { attemptId: quiz.attemptId });
    expect(response.status).toBe(200);

    const attempt = await executeSql<{ finished_at: string | null }>(
      'SELECT finished_at FROM assessment_attempts WHERE id = $1',
      [quiz.attemptId]
    );
    expect(attempt.rows[0].finished_at).not.toBeNull();
  });
});

describe('a database that predates the event stream', () => {
  /**
   * Found by running the migration against an old database rather than a fresh
   * one, minutes before merging.
   *
   * The first version of migration 008 added the columns and left the CHECK
   * alone, reasoning that the application is the only writer. An existing
   * database does not merely lack a guard — it *rejects* `quiz_expired`. And
   * because recordEvent never throws, every expiry on a deployment with
   * history would have failed silently, on exactly the databases that have
   * users.
   *
   * This is the divergence between a fresh schema and a migrated one that
   * item 8 of the plan exists to prevent, and only the upgrade path shows it.
   */
  it('accepts the event types the server now emits', async () => {
    const { forgetMigration } = await import('./helpers/database.js');
    const { initializeSchema } = await import('../api/_lib/db.js');

    // Rebuild the pre-008 shape, rows and all.
    await executeSql('DROP TABLE learning_events');
    await executeSql(`CREATE TABLE learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('lesson_start', 'lesson_end', 'quiz_start', 'quiz_answer', 'quiz_complete', 'hint_request', 'idle_timeout')),
      payload TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    await executeSql(
      `INSERT INTO learning_events (subject, concept_id, event_type, payload)
       VALUES ('math', 'frac', 'lesson_start', '{"kept":true}')`
    );
    // Every migration from 008 on, not only 008. A database that predates the
    // event stream predates the envelope too, and forgetting one without the
    // other simulates something that cannot exist: a schema carrying 009's
    // columns while 008 has never run. The helper's own comment says what that
    // is — a database vandalised behind the migrator's back, which the
    // migrator is not meant to repair.
    //
    // It matters beyond bookkeeping. 008 rebuilds the table from a column list
    // frozen at 008, so re-running it on a database that already has the
    // envelope drops those columns silently. Ordering is what prevents that,
    // and this is the test that would notice if ordering stopped holding.
    await forgetMigration('008-learning-event-source');
    await forgetMigration('009-learning-event-envelope');

    await initializeSchema();

    // The row this migration exists to preserve is still here, unaltered.
    const kept = await executeSql<{ payload: string; source: string }>(
      "SELECT payload, source FROM learning_events WHERE event_type = 'lesson_start'"
    );
    expect(JSON.parse(kept.rows[0].payload)).toEqual({ kept: true });
    // Classified as browser, which is what it was: nothing else wrote here.
    expect(kept.rows[0].source).toBe('browser');

    // And the constraint now admits what the server emits.
    await expect(executeSql(
      `INSERT INTO learning_events (subject, concept_id, event_type, source)
       VALUES ('math', 'frac', 'quiz_expired', 'server')`
    )).resolves.toBeDefined();
  });

  /**
   * The upgrade path all the way to the current contract, not just to 008.
   *
   * A migrated database and a fresh one must end up the same shape — that is
   * the divergence item 8 exists to prevent, and the only way to see it is to
   * run the chain against an old database and compare.
   */
  it('arrives at the full envelope, and keeps the rows it started with', async () => {
    const { forgetMigration } = await import('./helpers/database.js');
    const { initializeSchema } = await import('../api/_lib/db.js');

    await executeSql('DROP TABLE learning_events');
    await executeSql(`CREATE TABLE learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('lesson_start', 'lesson_end', 'quiz_start', 'quiz_answer', 'quiz_complete', 'hint_request', 'idle_timeout')),
      payload TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    await executeSql(
      `INSERT INTO learning_events (subject, concept_id, event_type, payload, created_at)
       VALUES ('math', 'frac', 'lesson_start', '{"kept":true}', '2020-01-01 10:00:00')`
    );
    await forgetMigration('008-learning-event-source');
    await forgetMigration('009-learning-event-envelope');

    await initializeSchema();

    const columns = await executeSql<{ name: string }>('PRAGMA table_info(learning_events)');
    const names = new Set(columns.rows.map(row => String(row.name)));
    for (const column of ['event_id', 'schema_version', 'occurred_at', 'dedupe_key']) {
      expect(names).toContain(column);
    }

    // Backfilled rather than left null, which is the compatibility promise: no
    // reader should have to know the stream has a before and an after.
    const migrated = await executeSql<{
      event_id: string; schema_version: number; occurred_at: string; payload: string;
    }>("SELECT event_id, schema_version, occurred_at, payload FROM learning_events WHERE event_type = 'lesson_start'");
    const row = migrated.rows[0];
    expect(JSON.parse(row.payload)).toEqual({ kept: true });
    expect(row.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number(row.schema_version)).toBe(1);
    // The best that was ever knowable about an old row: when we heard of it.
    expect(row.occurred_at).toBe('2020-01-01 10:00:00');
  });
});
