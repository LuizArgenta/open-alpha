/**
 * The first consumer of the evidence layer, plus the adult's right to
 * overrule the engine. Authorization is the part worth being paranoid about:
 * these endpoints expose one child's learning record to an adult.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { GET as getTimeline } from '../api/parent/children/[childId]/timeline.js';
import { POST as postOverride } from '../api/parent/children/[childId]/override.js';
import { MASTERY_THRESHOLD } from '../api/_lib/curriculum.js';
import { createUser, linkParentToChild, resetDatabase, takeQuiz } from './helpers/database.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

let childId: number;
let parentId: number;
let strangerId: number;
let parentToken: string;
let strangerToken: string;
let childToken: string;

function timelineRequest(target: number, token: string) {
  return new Request(`https://test.local/api/parent/children/${target}/timeline`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function overrideRequest(target: number, token: string, body: Record<string, unknown>) {
  return new Request(`https://test.local/api/parent/children/${target}/override`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readTimeline(target = childId, token = parentToken) {
  const response = await getTimeline(timelineRequest(target, token));
  return { status: response.status, body: (await response.json()) as any };
}

beforeEach(async () => {
  await resetDatabase();

  childId = await createUser('student');
  parentId = await createUser('parent');
  strangerId = await createUser('parent');

  await linkParentToChild(parentId, childId);

  parentToken = signToken({ userId: parentId, role: 'parent' });
  strangerToken = signToken({ userId: strangerId, role: 'parent' });
  childToken = signToken({ userId: childId, role: 'student' });
});

describe('timeline access', () => {
  it('refuses a parent who is not linked to the child', async () => {
    const { status } = await readTimeline(childId, strangerToken);
    expect(status).toBe(403);
  });

  it('refuses a student reading their own record through the parent endpoint', async () => {
    const { status } = await readTimeline(childId, childToken);
    expect(status).toBe(401);
  });

  it('refuses a request with no token', async () => {
    const response = await getTimeline(
      new Request(`https://test.local/api/parent/children/${childId}/timeline`)
    );
    expect(response.status).toBe(401);
  });

  it('rejects a malformed child id instead of guessing', async () => {
    const response = await getTimeline(
      new Request('https://test.local/api/parent/children/not-a-number/timeline', {
        headers: { authorization: `Bearer ${parentToken}` },
      })
    );
    expect(response.status).toBe(400);
  });
});

describe('timeline contents', () => {
  it('is empty for a child who has done nothing', async () => {
    const { body } = await readTimeline();
    expect(body.events).toEqual([]);
  });

  it('shows the decisions the engine made about a failed attempt', async () => {
    await takeQuiz(signToken({ userId: childId, role: 'student' }), SUBJECT, CONCEPT, 1);

    const { body } = await readTimeline();
    const kinds = body.events.filter((e: any) => e.type === 'decision').map((e: any) => e.kind);

    expect(kinds).toContain('diagnosis');
    expect(kinds).toContain('remediation');
  });

  it('names the concept rather than showing its id', async () => {
    await executeSql(
      // Note the repeated concept: executeSql binds by order of appearance,
      // not by the $N number, so a reused placeholder needs a repeated value.
      `INSERT INTO learning_decisions (student_id, subject, concept_id, kind, decision, reason)
       VALUES ($1, $2, $3, 'next_concept', $4, 'next_in_sequence')`,
      [childId, SUBJECT, CONCEPT, CONCEPT]
    );

    const { body } = await readTimeline();
    expect(body.events[0].conceptName).toBe('Introduction to Fractions');
  });

  it('puts the most recent event first', async () => {
    await executeSql(
      `INSERT INTO learning_decisions (student_id, subject, concept_id, kind, decision, reason, created_at)
       VALUES ($1, $2, $3, 'diagnosis', 'old', 'failed', datetime('now', '-2 days'))`,
      [childId, SUBJECT, CONCEPT]
    );
    await executeSql(
      `INSERT INTO learning_decisions (student_id, subject, concept_id, kind, decision, reason, created_at)
       VALUES ($1, $2, $3, 'diagnosis', 'recent', 'failed', datetime('now'))`,
      [childId, SUBJECT, CONCEPT]
    );

    const { body } = await readTimeline();
    expect(body.events[0].decision).toBe('recent');
  });

  it('summarises an attempt with how many items were answered and got right', async () => {
    const item = await executeSql<{ id: number }>(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, stem, options, correct_answer)
       VALUES ($1, $2, 'pt-BR', 'generated', 'Q', '["A) x"]', 'A') RETURNING id`,
      [SUBJECT, CONCEPT]
    );
    const attempt = await executeSql<{ id: number }>(
      `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, score, finished_at)
       VALUES ($1, $2, $3, 'pt-BR', 100, datetime('now')) RETURNING id`,
      [childId, SUBJECT, CONCEPT]
    );
    await executeSql(
      `INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct)
       VALUES ($1, $2, 'A', 1)`,
      [attempt.rows[0].id, item.rows[0].id]
    );

    const { body } = await readTimeline();
    const attemptEvent = body.events.find((e: any) => e.type === 'attempt');

    expect(attemptEvent).toMatchObject({ score: 100, answered: 1, correct: 1 });
  });

  it('does not leak another child\'s record', async () => {
    const otherChild = await createUser('student');
    await executeSql(
      `INSERT INTO learning_decisions (student_id, subject, concept_id, kind, decision, reason)
       VALUES ($1, $2, $3, 'diagnosis', 'not yours', 'failed')`,
      [otherChild, SUBJECT, CONCEPT]
    );

    const { body } = await readTimeline();
    expect(body.events).toEqual([]);
  });
});

describe('human override', () => {
  async function override(body: Record<string, unknown>, token = parentToken) {
    const response = await postOverride(overrideRequest(childId, token, body));
    return { status: response.status, body: (await response.json()) as any };
  }

  it('marks a concept as mastered and schedules its first review', async () => {
    const { status } = await override({
      action: 'mark_mastered',
      subject: SUBJECT,
      conceptId: CONCEPT,
      reason: 'Ele já sabia isso da escola anterior',
    });

    expect(status).toBe(200);

    const row = await executeSql<{ mastery_score: number; next_review_at: string | null }>(
      'SELECT mastery_score, next_review_at FROM progress WHERE student_id = $1 AND concept_id = $2',
      [childId, CONCEPT]
    );

    expect(row.rows[0].mastery_score).toBeGreaterThanOrEqual(MASTERY_THRESHOLD);
    expect(row.rows[0].next_review_at).not.toBeNull();
  });

  it('clears a concept so it is met fresh', async () => {
    await executeSql(
      `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts)
       VALUES ($1, $2, $3, 30, 4)`,
      [childId, SUBJECT, CONCEPT]
    );

    await override({
      action: 'reset_concept',
      subject: SUBJECT,
      conceptId: CONCEPT,
      reason: 'Estava doente na semana toda',
    });

    const rows = await executeSql('SELECT id FROM progress WHERE student_id = $1', [childId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('records who overrode what and why', async () => {
    await override({
      action: 'mark_mastered',
      subject: SUBJECT,
      conceptId: CONCEPT,
      reason: 'Demonstrou para mim em casa',
    });

    const logged = await executeSql<{ decision: string; inputs: string }>(
      `SELECT decision, inputs FROM learning_decisions WHERE kind = 'override'`
    );

    expect(logged.rows[0].decision).toBe('mark_mastered');
    expect(JSON.parse(logged.rows[0].inputs)).toMatchObject({
      byUserId: parentId,
      note: 'Demonstrou para mim em casa',
    });
  });

  it('demands a reason, because a bare override is indistinguishable from a mistake', async () => {
    const { status } = await override({
      action: 'mark_mastered',
      subject: SUBJECT,
      conceptId: CONCEPT,
    });

    expect(status).toBe(400);
    const rows = await executeSql('SELECT id FROM progress WHERE student_id = $1', [childId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses an unlinked parent', async () => {
    const { status } = await override(
      { action: 'mark_mastered', subject: SUBJECT, conceptId: CONCEPT, reason: 'porque sim' },
      strangerToken
    );

    expect(status).toBe(403);
  });

  it('refuses an unknown action', async () => {
    const { status } = await override({
      action: 'delete_everything',
      subject: SUBJECT,
      conceptId: CONCEPT,
      reason: 'testing',
    });

    expect(status).toBe(400);
  });

  it('refuses a concept that does not exist', async () => {
    const { status } = await override({
      action: 'mark_mastered',
      subject: SUBJECT,
      conceptId: 'math-not-a-real-concept',
      reason: 'testing',
    });

    expect(status).toBe(404);
  });
});

/**
 * Item 1.5, and the first time an adult can see the engine's own bet.
 *
 * The prediction and the verdict have existed since 1.3 and lived only in the
 * database. A parent asking "what is it doing about this?" had no answer, and
 * a system that judges itself in private is not accountable to anyone —
 * which is most of the reason the judgement is worth recording at all.
 */
describe('what the engine offered, and whether it worked', () => {
  const DECIMALS = 'math-decimals';

  async function ageOpenRuns(seconds = 60) {
    await executeSql(
      `UPDATE intervention_runs SET started_at = datetime(started_at, $1) WHERE completed_at IS NULL`,
      [`-${seconds} seconds`]
    );
  }

  it('shows the offer with what it expected to achieve', async () => {
    await takeQuiz(childToken, SUBJECT, DECIMALS, 1, 30_000);

    const { body } = await readTimeline();
    const started = body.events.find(
      (event: any) => event.type === 'intervention' && event.phase === 'started'
    );

    expect(started).toBeDefined();
    // The bet, in the parent's view: where the child was, and where this was
    // supposed to get them.
    expect(started.expected).toEqual({ baseline: 20, target: 80 });
    expect(started.conceptName).toBeTruthy();
    expect(started.outcome).toBeNull();
  });

  it('adds a second entry when it concludes, rather than rewriting the first', async () => {
    await takeQuiz(childToken, SUBJECT, DECIMALS, 1, 30_000);
    await ageOpenRuns();
    await takeQuiz(childToken, SUBJECT, DECIMALS, 5, 30_000);

    const { body } = await readTimeline();
    const entries = body.events.filter((event: any) => event.type === 'intervention');

    // Two moments, two rows. Collapsing them into one verdict would hide the
    // gap between being offered something and finding out whether it helped,
    // which is the part being asked about.
    expect(entries.map((event: any) => event.phase).sort()).toEqual(['completed', 'started']);
    const completed = entries.find((event: any) => event.phase === 'completed');
    expect(completed.outcome).toBe('met');
    expect(completed.observed).toBe(100);
    expect(entries.every((event: any) => event.runId === entries[0].runId)).toBe(true);
  });

  it('reports a verdict it could not reach as exactly that', async () => {
    await takeQuiz(childToken, SUBJECT, DECIMALS, 1, 30_000);
    await ageOpenRuns();
    // Rushed: says nothing about whether the offer helped.
    await takeQuiz(childToken, SUBJECT, DECIMALS, 1, 300);

    const { body } = await readTimeline();
    const completed = body.events.find(
      (event: any) => event.type === 'intervention' && event.phase === 'completed'
    );
    expect(completed.outcome).toBe('inconclusive');
  });

  it('stays a parent-only view', async () => {
    await takeQuiz(childToken, SUBJECT, DECIMALS, 1, 30_000);

    const stranger = await getTimeline(timelineRequest(childId, strangerToken));
    expect(stranger.status).toBe(403);
  });
});
