import { executeSql } from '../_lib/db.js';
import { parseDbTimestamp } from '../_lib/time.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { getConcept } from '../_lib/curriculum.js';

interface ProgressRow {
  subject: string;
  concept_id: string;
  mastery_score: number;
  last_attempt_at: string;
  next_review_at: string | null;
  review_interval_days: number | null;
}

export async function GET(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    // Rows mastered before scheduling existed have no next_review_at; the old
    // fixed 7-day window keeps them in the queue until their next pass puts
    // them on the ladder.
    const result = await executeSql<ProgressRow>(
      `SELECT subject, concept_id, mastery_score, last_attempt_at, next_review_at, review_interval_days
       FROM progress
       WHERE student_id = $1
         AND mastery_score >= 80
         AND (
           next_review_at <= datetime('now')
           OR (next_review_at IS NULL AND last_attempt_at < datetime('now', '-7 days'))
         )
       ORDER BY COALESCE(next_review_at, last_attempt_at) ASC
       LIMIT 5`,
      [auth.userId]
    );

    const review = result.rows.map(row => ({
      subject: row.subject,
      conceptId: row.concept_id,
      conceptName: getConcept(row.subject, row.concept_id)?.name ?? row.concept_id,
      masteryScore: row.mastery_score,
      lastAttemptAt: row.last_attempt_at,
      nextReviewAt: row.next_review_at,
      intervalDays: row.review_interval_days,
      daysSince: Math.floor(
        (Date.now() - parseDbTimestamp(row.last_attempt_at).getTime()) / (1000 * 60 * 60 * 24)
      ),
    }));

    return Response.json({ review });
  } catch (error) {
    console.error('Get review error:', error);
    return Response.json({ error: 'Failed to get review queue' }, { status: 500 });
  }
}
