import { executeSql } from '../../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import {
  MASTERY_THRESHOLD,
  getConceptWithLesson,
  resolveRemediation,
  toProgressMap,
} from '../../_lib/curriculum.js';

interface Progress {
  mastery_score: number;
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
      'SELECT mastery_score FROM progress WHERE student_id = $1 AND subject = $2 AND concept_id = $3',
      [auth.userId, subject, conceptId]
    );

    let newScore = score;

    if (existingProgress.rows.length > 0) {
      newScore = Math.max(existingProgress.rows[0].mastery_score, score);
      const completed = newScore >= MASTERY_THRESHOLD;

      await executeSql(
        `UPDATE progress SET mastery_score = $1, attempts = attempts + 1, last_attempt_at = datetime('now')${completed ? ", completed_at = datetime('now')" : ''}
         WHERE student_id = $2 AND subject = $3 AND concept_id = $4`,
        [newScore, auth.userId, subject, conceptId]
      );
    } else {
      const completed = score >= MASTERY_THRESHOLD;

      await executeSql(
        `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at${completed ? ', completed_at' : ''})
         VALUES ($1, $2, $3, $4, 1, datetime('now')${completed ? ", datetime('now')" : ''})`,
        [auth.userId, subject, conceptId, score]
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
