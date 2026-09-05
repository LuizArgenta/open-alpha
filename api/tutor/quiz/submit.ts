import { executeSql } from '../../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import {
  MASTERY_THRESHOLD,
  getConceptWithLesson,
  resolveRemediation,
  toProgressMap,
} from '../../_lib/curriculum.js';
import { scheduleAfterLapse, scheduleAfterMastery } from '../../_lib/review.js';

interface Progress {
  mastery_score: number;
  review_interval_days: number | null;
}

interface SubjectProgressRow {
  concept_id: string;
  mastery_score: number;
  attempts: number;
}

/**
 * What the student should do next after failing a mastery check. Without this
 * the only answer the UI can give is "try again", which is the one thing a
 * student who just failed three times should not do.
 */
async function buildRemediation(studentId: number, subject: string, conceptId: string) {
  const concept = await getConceptWithLesson(subject, conceptId);
  if (!concept) return undefined;

  const progressRows = await executeSql<SubjectProgressRow>(
    'SELECT concept_id, mastery_score, attempts FROM progress WHERE student_id = $1 AND subject = $2',
    [studentId, subject]
  );

  const progressById = toProgressMap(
    progressRows.rows.map(row => ({
      conceptId: row.concept_id,
      masteryScore: row.mastery_score,
      attempts: row.attempts,
    }))
  );

  return resolveRemediation(subject, concept, progressById);
}

export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const body = await request.json() as { subject: string; conceptId: string; score: number };
    const { subject, conceptId, score } = body;

    if (!subject || !conceptId || score === undefined) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const existingProgress = await executeSql<Progress>(
      'SELECT mastery_score, review_interval_days FROM progress WHERE student_id = $1 AND subject = $2 AND concept_id = $3',
      [auth.userId, subject, conceptId]
    );

    // This attempt, not the all-time best: mastery_score never regresses, so it
    // is the raw score that tells us whether the concept held up today.
    const attemptPassed = score >= MASTERY_THRESHOLD;
    let newScore = score;

    if (existingProgress.rows.length > 0) {
      const existing = existingProgress.rows[0];
      const wasMastered = existing.mastery_score >= MASTERY_THRESHOLD;
      newScore = Math.max(existing.mastery_score, score);
      const completed = newScore >= MASTERY_THRESHOLD;

      const schedule = attemptPassed
        ? scheduleAfterMastery(existing.review_interval_days)
        : wasMastered
          ? scheduleAfterLapse()
          : null;

      await executeSql(
        `UPDATE progress SET mastery_score = $1, attempts = attempts + 1, last_attempt_at = datetime('now')${completed ? ", completed_at = datetime('now')" : ''}${schedule ? ", next_review_at = datetime('now', $2), review_interval_days = $3" : ''}
         WHERE student_id = $4 AND subject = $5 AND concept_id = $6`,
        schedule
          ? [newScore, schedule.modifier, schedule.intervalDays, auth.userId, subject, conceptId]
          : [newScore, auth.userId, subject, conceptId]
      );
    } else {
      const schedule = attemptPassed ? scheduleAfterMastery(null) : null;

      await executeSql(
        `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at${attemptPassed ? ', completed_at' : ''}${schedule ? ', next_review_at, review_interval_days' : ''})
         VALUES ($1, $2, $3, $4, 1, datetime('now')${attemptPassed ? ", datetime('now')" : ''}${schedule ? ", datetime('now', $5), $6" : ''})`,
        schedule
          ? [auth.userId, subject, conceptId, score, schedule.modifier, schedule.intervalDays]
          : [auth.userId, subject, conceptId, score]
      );
    }

    const passed = newScore >= MASTERY_THRESHOLD;

    return Response.json({
      masteryScore: newScore,
      passed,
      message: passed ? "Congratulations! You've mastered this concept!" : 'Keep practicing to reach 80% mastery.',
      remediation: passed ? undefined : await buildRemediation(auth.userId, subject, conceptId),
    });
  } catch (error) {
    console.error('Submit quiz error:', error);
    return Response.json({ error: 'Failed to submit quiz results' }, { status: 500 });
  }
}
