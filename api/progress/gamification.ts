/**
 * GET /api/progress/gamification
 *
 * The XP, level and streak the student dashboard has been asking for since
 * before this half of the codebase existed.
 *
 * `StudentDashboard.tsx` has always called this endpoint, and nothing has ever
 * answered it: the implementation lived only in the Express backend that was
 * never deployed and has since been deleted. The dashboard does not check the
 * response, so the whole XP and level panel has simply been absent, silently,
 * for every student who has used the deployed app.
 *
 * The deleted version read `users.xp_points`, `users.streak_days` and
 * `users.last_active_date`. Those columns do not exist in this schema and
 * nothing writes them, so porting it would have produced a panel that reads
 * zero forever — which is worse than no panel, because it looks like an answer.
 *
 * XP is summed from `xp_awards`, where it actually lives and where every award
 * names the attempt that earned it. The number a student sees is therefore the
 * same one a parent could trace back to the work.
 */

import { executeSql } from '../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';

/**
 * Kept from the deleted implementation on purpose: the dashboard's progress
 * bar and "Level N" badge were designed around these bands, and changing them
 * would silently move every existing student's level. Arbitrary, but theirs.
 */
const LEVEL_THRESHOLDS = [0, 200, 500, 1000, 2000, 3500, 5500, 8000, 11000, 15000];

export interface LevelStanding {
  level: number;
  xpForCurrent: number;
  xpForNext: number;
  levelProgress: number;
}

export function levelFor(xp: number): LevelStanding {
  let level = 1;
  for (let index = LEVEL_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    if (xp >= LEVEL_THRESHOLDS[index]) {
      level = index + 1;
      break;
    }
  }

  const xpForCurrent = LEVEL_THRESHOLDS[level - 1] ?? 0;
  // At the top band there is no next threshold; the bar reads full rather than
  // dividing by zero or inventing a level nobody can reach.
  const xpForNext = LEVEL_THRESHOLDS[level] ?? xpForCurrent;
  const levelProgress = xpForNext > xpForCurrent
    ? Math.round(((xp - xpForCurrent) / (xpForNext - xpForCurrent)) * 100)
    : 100;

  return { level, xpForCurrent, xpForNext, levelProgress };
}

/**
 * Consecutive days the student showed up, counting back from today.
 *
 * Days come from every trace of showing up, not from XP: a day spent on lessons
 * without finishing a quiz still counts, because a streak that only counted
 * scoring would punish exactly the student who is struggling.
 *
 * Both sources are needed, and that was learned the hard way. `learning_events`
 * is written only by `progress/events.ts`, which the browser calls for lesson
 * starts and hints — sitting a quiz writes nothing there. Counting events alone
 * gave a student who had just finished a quiz a streak of zero. Attempts are
 * recorded by the server itself whenever a quiz opens, so they are the half
 * that cannot be lost to a browser that failed to report.
 *
 * A streak that has not been extended *today* is not broken yet: the day is not
 * over. It breaks once the last active day is older than yesterday.
 *
 * Days are UTC, because every timestamp in this schema is. Someone studying at
 * 22:00 in UTC-3 has their work counted on the following UTC day, which can
 * cost a streak the learner believes they kept. Recording the learner's own
 * timezone is the honest fix and is not in this schema yet; this is written
 * down rather than left for someone to discover from a complaint.
 */
export function streakFrom(days: string[], today: string, yesterday: string): number {
  if (days.length === 0) return 0;
  if (days[0] !== today && days[0] !== yesterday) return 0;

  let streak = 1;
  for (let index = 1; index < days.length; index += 1) {
    const previous = new Date(`${days[index - 1]}T00:00:00Z`);
    const current = new Date(`${days[index]}T00:00:00Z`);
    const gapDays = Math.round((previous.getTime() - current.getTime()) / 86_400_000);
    if (gapDays !== 1) break;
    streak += 1;
  }
  return streak;
}

export async function GET(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth) return unauthorized();

    const earned = await executeSql<{ xp: number }>(
      'SELECT COALESCE(SUM(amount), 0) AS xp FROM xp_awards WHERE student_id = $1',
      [auth.userId]
    );
    const xp = Number(earned.rows[0]?.xp ?? 0);

    const active = await executeSql<{ day: string }>(
      `SELECT day FROM (
         SELECT DISTINCT date(created_at) AS day
         FROM learning_events WHERE student_id = $1
         UNION
         SELECT DISTINCT date(started_at) AS day
         FROM assessment_attempts WHERE student_id = $2
       ) ORDER BY day DESC`,
      [auth.userId, auth.userId]
    );

    const dates = await executeSql<{ today: string; yesterday: string }>(
      "SELECT date('now') AS today, date('now', '-1 day') AS yesterday"
    );

    return Response.json({
      xp,
      streak: streakFrom(
        active.rows.map(row => row.day),
        dates.rows[0].today,
        dates.rows[0].yesterday
      ),
      ...levelFor(xp),
    });
  } catch (error) {
    console.error('Gamification error:', error);
    return Response.json({ error: 'Failed to load gamification stats' }, { status: 500 });
  }
}
