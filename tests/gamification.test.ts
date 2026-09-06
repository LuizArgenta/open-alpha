/**
 * The dashboard has been calling this endpoint since before this half of the
 * codebase existed, and nothing answered it.
 *
 * `StudentDashboard.tsx` does not check the response, so the XP and level panel
 * has simply been missing for every student who used the deployed app — no
 * error, no empty state, just absence. The routing contract test in #41 found
 * the gap; this closes it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { GET as gamification, levelFor, streakFrom } from '../api/progress/gamification.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';

function get(token?: string): Request {
  return new Request('https://test.local/api/progress/gamification', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

interface Stats {
  xp: number;
  streak: number;
  level: number;
  xpForCurrent: number;
  xpForNext: number;
  levelProgress: number;
}

async function statsFor(studentId: number): Promise<Stats> {
  const response = await gamification(get(signToken({ userId: studentId, role: 'student' })));
  expect(response.status).toBe(200);
  return response.json() as Promise<Stats>;
}

async function award(studentId: number, amount: number): Promise<void> {
  await executeSql(
    `INSERT INTO xp_awards (student_id, subject, concept_id, amount, reason)
     VALUES ($1, 'math', 'math-fractions-intro', $2, 'mastery')`,
    [studentId, amount]
  );
}

/** An event on the day `daysAgo` days before today, in UTC. */
async function activeOn(studentId: number, daysAgo: number): Promise<void> {
  await executeSql(
    `INSERT INTO learning_events (student_id, subject, concept_id, event_type, created_at)
     VALUES ($1, 'math', 'math-fractions-intro', 'lesson_start', datetime('now', $2))`,
    [studentId, `-${daysAgo} days`]
  );
}

beforeEach(async () => {
  await resetDatabase();
});

describe('the XP the dashboard shows', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await gamification(get())).status).toBe(401);
  });

  it('is the sum of awards actually earned, not a denormalised counter', async () => {
    const studentId = await createUser('student');
    await award(studentId, 40);
    await award(studentId, 35);

    // The deleted implementation read users.xp_points, a column this schema
    // does not have and nothing writes. Reading it would have shown zero
    // forever, which looks like an answer.
    expect((await statsFor(studentId)).xp).toBe(75);
  });

  it('shows nothing rather than failing for a student who has earned none', async () => {
    const studentId = await createUser('student');
    const stats = await statsFor(studentId);
    expect(stats).toMatchObject({ xp: 0, streak: 0, level: 1 });
  });

  it('counts only the awards belonging to the caller', async () => {
    const mine = await createUser('student');
    const theirs = await createUser('student');
    await award(mine, 50);
    await award(theirs, 900);

    expect((await statsFor(mine)).xp).toBe(50);
  });
});

describe('levels', () => {
  it('places a student in the band their XP reaches', () => {
    expect(levelFor(0).level).toBe(1);
    expect(levelFor(199).level).toBe(1);
    expect(levelFor(200).level).toBe(2);
    expect(levelFor(15_000).level).toBe(10);
  });

  it('reports progress through the current band', () => {
    // Halfway between 200 and 500.
    expect(levelFor(350).levelProgress).toBe(50);
    expect(levelFor(200).levelProgress).toBe(0);
  });

  it('reads full at the top band instead of dividing by zero', () => {
    const top = levelFor(1_000_000);
    expect(top.level).toBe(10);
    expect(top.levelProgress).toBe(100);
    expect(Number.isFinite(top.xpForNext)).toBe(true);
  });
});

describe('the streak', () => {
  const TODAY = '2026-09-06';
  const YESTERDAY = '2026-09-05';

  it('counts consecutive days back from today', () => {
    expect(streakFrom(['2026-09-06', '2026-09-05', '2026-09-04'], TODAY, YESTERDAY)).toBe(3);
  });

  it('is not broken by a day that is not over yet', () => {
    // Nothing today, but yesterday counts: the day has not finished.
    expect(streakFrom(['2026-09-05', '2026-09-04'], TODAY, YESTERDAY)).toBe(2);
  });

  it('breaks once the last active day is older than yesterday', () => {
    expect(streakFrom(['2026-09-04', '2026-09-03'], TODAY, YESTERDAY)).toBe(0);
  });

  it('stops at the first gap rather than counting every active day', () => {
    expect(streakFrom(['2026-09-06', '2026-09-05', '2026-09-02'], TODAY, YESTERDAY)).toBe(2);
  });

  it('is zero for a student who has never done anything', () => {
    expect(streakFrom([], TODAY, YESTERDAY)).toBe(0);
  });

  /**
   * This is the test the unit tests could not have produced, because they
   * inserted learning events directly. Running a real quiz through the server
   * showed a streak of zero for a student who had just sat one: quizzes write
   * no learning event, only an attempt.
   */
  it('counts a day the student only sat a quiz', async () => {
    const studentId = await createUser('student');
    await executeSql(
      `INSERT INTO assessment_attempts (student_id, subject, concept_id, kind, started_at)
       VALUES ($1, 'math', 'math-fractions-intro', 'mastery', datetime('now'))`,
      [studentId]
    );

    // learning_events is written by the browser calling progress/events.ts.
    // An attempt is written by the server, so it survives a browser that
    // never reported.
    expect((await statsFor(studentId)).streak).toBe(1);
  });

  it('does not count the same day twice when both sources record it', async () => {
    const studentId = await createUser('student');
    await activeOn(studentId, 0);
    await executeSql(
      `INSERT INTO assessment_attempts (student_id, subject, concept_id, kind, started_at)
       VALUES ($1, 'math', 'math-fractions-intro', 'mastery', datetime('now'))`,
      [studentId]
    );

    expect((await statsFor(studentId)).streak).toBe(1);
  });

  it('counts days of showing up, not days of scoring', async () => {
    const studentId = await createUser('student');
    // Three days of lessons and no quiz finished: a streak that only counted
    // XP would punish exactly the student who is struggling.
    await activeOn(studentId, 0);
    await activeOn(studentId, 1);
    await activeOn(studentId, 2);

    const stats = await statsFor(studentId);
    expect(stats.streak).toBe(3);
    expect(stats.xp).toBe(0);
  });
});
