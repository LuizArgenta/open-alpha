/**
 * One learner's identifier must never reach another learner's data.
 *
 * Reading the code, every endpoint that takes an id from the browser already
 * scopes it to the caller — this sweep found no hole to fix. That is worth
 * saying plainly, and it is also exactly why the tests belong here: the plan's
 * criterion for item 16 is that an endpoint without a cross-user test counts
 * as unswept, because "it looked right when I read it" stops being true the
 * first time someone adds an endpoint by copying a neighbour.
 *
 * Quizzes, placement, the timeline and overrides are covered by their own
 * suites. This file covers what those left out: progress, chat sessions,
 * interests, and the coach.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, linkParentToChild, resetDatabase } from './helpers/database.js';

import { GET as progressSummary } from '../api/progress/summary.js';
import { GET as recentActivity } from '../api/progress/activity/recent.js';
import { GET as reviewQueue } from '../api/progress/review.js';
import { GET as timeback } from '../api/progress/timeback.js';
import { GET as progressMap } from '../api/progress/map/[subject].js';
import { DELETE as deleteInterest, GET as getInterests } from '../api/interests/index.js';
import { POST as tutorChat } from '../api/tutor/chat.js';
import { POST as coachChat } from '../api/coach/chat.js';
import { GET as childAnalytics } from '../api/parent/children/[childId]/analytics.js';
import { GET as childProgress } from '../api/parent/children/[childId]/progress.js';

const SUBJECT = 'math';
const CONCEPT = 'math-fractions-intro';

let mine: number;
let theirs: number;
let myToken: string;
let theirToken: string;

function getAs(token: string, path = 'https://test.local/api/x'): Request {
  return new Request(path, { headers: { authorization: `Bearer ${token}` } });
}

function postAs(token: string, body: unknown, path = 'https://test.local/api/x'): Request {
  return new Request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Progress on a concept, so there is something for a stranger to try to read. */
async function giveProgress(studentId: number): Promise<void> {
  await executeSql(
    `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at, completed_at)
     VALUES ($1, $2, $3, 100, 1, datetime('now'), datetime('now'))`,
    [studentId, SUBJECT, CONCEPT]
  );
}

beforeEach(async () => {
  await resetDatabase();
  mine = await createUser('student');
  theirs = await createUser('student');
  myToken = signToken({ userId: mine, role: 'student' });
  theirToken = signToken({ userId: theirs, role: 'student' });
});

describe('progress endpoints answer only for the caller', () => {
  it('does not count another student\'s mastery in my summary', async () => {
    await giveProgress(theirs);

    const body = await (await progressSummary(getAs(myToken))).json() as {
      summary: { completed: number }[];
    };

    expect(body.summary.every(subject => subject.completed === 0)).toBe(true);
  });

  it('does not list another student\'s activity as mine', async () => {
    await giveProgress(theirs);
    await executeSql(
      `INSERT INTO learning_events (student_id, subject, concept_id, event_type)
       VALUES ($1, $2, $3, 'quiz_complete')`,
      [theirs, SUBJECT, CONCEPT]
    );

    const response = await recentActivity(getAs(myToken));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(String(theirs));
  });

  it('does not put another student\'s concept in my review queue', async () => {
    await executeSql(
      `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, next_review_at, review_interval_days)
       VALUES ($1, $2, $3, 100, 1, datetime('now', '-1 day'), 1)`,
      [theirs, SUBJECT, CONCEPT]
    );

    const body = await (await reviewQueue(getAs(myToken))).json() as { due?: unknown[] };
    expect(body.due ?? []).toHaveLength(0);
  });

  it('does not credit me with another student\'s time', async () => {
    await giveProgress(theirs);

    const mineBody = await (await timeback(getAs(myToken))).json();
    const theirsBody = await (await timeback(getAs(theirToken))).json();

    expect(JSON.stringify(mineBody)).not.toEqual(JSON.stringify(theirsBody));
  });

  it('does not show another student\'s mastery on my map', async () => {
    await giveProgress(theirs);

    const response = await progressMap(
      getAs(myToken, `https://test.local/api/progress/map/${SUBJECT}`)
    );
    const body = await response.json() as { concepts?: { conceptId: string; masteryScore: number }[] };
    const fractions = (body.concepts ?? []).find(c => c.conceptId === CONCEPT);

    expect(fractions?.masteryScore ?? 0).toBe(0);
  });
});

describe('interests belong to one student', () => {
  it('refuses to delete an interest that is not mine', async () => {
    const inserted = await executeSql<{ id: number }>(
      `INSERT INTO user_interests (user_id, category, value) VALUES ($1, 'hobby', 'astronomy')
       RETURNING id`,
      [theirs]
    );
    const interestId = inserted.rows[0].id;

    const response = await deleteInterest(
      new Request(`https://test.local/api/interests?id=${interestId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${myToken}` },
      })
    );

    // The endpoint reports success either way — it deleted everything it was
    // allowed to. What matters is that the row is still there.
    expect(response.status).toBe(200);
    const survivors = await executeSql<{ id: number }>(
      'SELECT id FROM user_interests WHERE id = $1',
      [interestId]
    );
    expect(survivors.rows).toHaveLength(1);
  });

  it('does not list another student\'s interests as mine', async () => {
    await executeSql(
      "INSERT INTO user_interests (user_id, category, value) VALUES ($1, 'hobby', 'astronomy')",
      [theirs]
    );

    const body = await (await getInterests(getAs(myToken))).json() as { interests: unknown[] };
    expect(body.interests).toHaveLength(0);
  });
});

describe('chat sessions belong to one user', () => {
  it('refuses to continue another student\'s tutor session', async () => {
    const session = await executeSql<{ id: number }>(
      `INSERT INTO sessions (user_id, session_type, subject, concept_id)
       VALUES ($1, 'tutor', $2, $3) RETURNING id`,
      [theirs, SUBJECT, CONCEPT]
    );

    // The session lookup runs before any model call, so this asserts the
    // authorization boundary without reaching the network.
    const response = await tutorChat(postAs(myToken, {
      message: 'hello',
      subject: SUBJECT,
      conceptId: CONCEPT,
      sessionId: session.rows[0].id,
    }));

    expect(response.status).toBe(404);
  });
});

describe('the coach answers only about a linked child', () => {
  it('refuses a child this parent is not linked to', async () => {
    const parentId = await createUser('parent');
    const parentToken = signToken({ userId: parentId, role: 'parent' });

    const response = await coachChat(postAs(parentToken, {
      message: 'How is she doing?',
      childId: theirs,
    }));

    expect(response.status).toBe(403);
  });

  it('refuses a child linked to a different parent', async () => {
    const parentId = await createUser('parent');
    const otherParentId = await createUser('parent');
    await linkParentToChild(otherParentId, theirs);

    const response = await coachChat(postAs(signToken({ userId: parentId, role: 'parent' }), {
      message: 'How is she doing?',
      childId: theirs,
    }));

    expect(response.status).toBe(403);
  });

  it('refuses a student asking the coach at all', async () => {
    const response = await coachChat(postAs(myToken, { message: 'hi', childId: mine }));
    expect(response.status).toBe(401);
  });
});

describe('a guardian reaches only their own child', () => {
  const childRoute = (childId: number) =>
    `https://test.local/api/parent/children/${childId}/x`;

  it('refuses analytics for an unlinked child', async () => {
    const parentToken = signToken({ userId: await createUser('parent'), role: 'parent' });
    const response = await childAnalytics(getAs(parentToken, childRoute(theirs)));
    expect(response.status).toBe(403);
  });

  it('refuses progress for an unlinked child', async () => {
    const parentToken = signToken({ userId: await createUser('parent'), role: 'parent' });
    const response = await childProgress(getAs(parentToken, childRoute(theirs)));
    expect(response.status).toBe(403);
  });

  it('refuses a child linked to a different parent', async () => {
    const parentId = await createUser('parent');
    const otherParentId = await createUser('parent');
    await linkParentToChild(otherParentId, theirs);

    const response = await childProgress(
      getAs(signToken({ userId: parentId, role: 'parent' }), childRoute(theirs))
    );
    expect(response.status).toBe(403);
  });

  it('refuses a link that was invited but never accepted', async () => {
    // linked_at is what separates "invited" from "linked"; a pending invite
    // must not already grant access to the child's record.
    const parentId = await createUser('parent');
    await executeSql(
      'INSERT INTO parent_links (parent_id, student_id, invite_code) VALUES ($1, $2, $3)',
      [parentId, theirs, `pending-${Math.random()}`]
    );

    const response = await childProgress(
      getAs(signToken({ userId: parentId, role: 'parent' }), childRoute(theirs))
    );
    expect(response.status).toBe(403);
  });
});
