import { executeSql } from '../../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import {
  MASTERY_THRESHOLD,
  getConcept,
  getConceptWithLesson,
  resolveRemediation,
  toProgressMap,
} from '../../_lib/curriculum.js';
import { type ReviewSchedule, scheduleAfterLapse, scheduleAfterMastery } from '../../_lib/review.js';
import {
  type AnswerEvent,
  attemptFocusScore,
  diagnoseAttempt,
  rapidAnswerThresholdMs,
} from '../../_lib/diagnosis.js';
import { awardXp } from '../../_lib/xp.js';
import { recordDecision } from '../../_lib/decisions.js';

interface SubmittedResponse {
  itemId?: number;
  chosen?: string;
  correct: boolean;
  responseTimeMs?: number;
}

/**
 * Writes down which question the student answered and how, then closes the
 * attempt. Without this the score is the only surviving evidence, and no
 * adult can ever ask which item was missed.
 */
async function recordResponses(
  attemptId: number,
  score: number,
  responses: SubmittedResponse[]
): Promise<void> {
  for (const response of responses) {
    if (response.itemId === undefined) continue;
    await executeSql(
      `INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct, response_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attemptId,
        response.itemId,
        response.chosen ?? null,
        response.correct ? 1 : 0,
        response.responseTimeMs ?? null,
      ]
    );
  }

  await executeSql(
    `UPDATE assessment_attempts SET score = $1, finished_at = datetime('now') WHERE id = $2`,
    [score, attemptId]
  );
}

interface Progress {
  mastery_score: number;
  review_interval_days: number | null;
  attempts: number;
}

interface EventRow {
  event_type: string;
  payload: string;
  created_at: string;
}

/**
 * The answers from the quiz that was just submitted: everything logged since
 * the most recent quiz_start for this concept.
 */
async function loadAttemptAnswers(
  studentId: number,
  subject: string,
  conceptId: string
): Promise<AnswerEvent[]> {
  const events = await executeSql<EventRow>(
    `SELECT event_type, payload, created_at FROM learning_events
     WHERE student_id = $1 AND subject = $2 AND concept_id = $3
     ORDER BY created_at DESC, id DESC
     LIMIT 60`,
    [studentId, subject, conceptId]
  );

  const answers: AnswerEvent[] = [];
  for (const event of events.rows) {
    if (event.event_type === 'quiz_start') break;
    if (event.event_type !== 'quiz_answer') continue;

    const payload = JSON.parse(event.payload || '{}');
    answers.push({
      correct: payload.correct === true,
      responseTimeMs: payload.responseTimeMs,
      at: event.created_at,
    });
  }

  return answers.reverse();
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

    const body = await request.json() as {
      subject: string;
      conceptId: string;
      score: number;
      attemptId?: number;
      responses?: SubmittedResponse[];
    };
    const { subject, conceptId, score, attemptId, responses } = body;

    if (!subject || !conceptId || score === undefined) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const existingProgress = await executeSql<Progress>(
      'SELECT mastery_score, review_interval_days, attempts FROM progress WHERE student_id = $1 AND subject = $2 AND concept_id = $3',
      [auth.userId, subject, conceptId]
    );

    const priorAttempts = existingProgress.rows[0]?.attempts ?? 0;

    if (attemptId !== undefined) {
      await recordResponses(attemptId, score, responses ?? []);
    }

    // This attempt, not the all-time best: mastery_score never regresses, so it
    // is the raw score that tells us whether the concept held up today.
    const attemptPassed = score >= MASTERY_THRESHOLD;
    let newScore = score;
    let schedule: ReviewSchedule | null = null;
    let scheduleReason = '';

    if (existingProgress.rows.length > 0) {
      const existing = existingProgress.rows[0];
      const wasMastered = existing.mastery_score >= MASTERY_THRESHOLD;
      newScore = Math.max(existing.mastery_score, score);
      const completed = newScore >= MASTERY_THRESHOLD;

      schedule = attemptPassed
        ? scheduleAfterMastery(existing.review_interval_days)
        : wasMastered
          ? scheduleAfterLapse()
          : null;
      scheduleReason = attemptPassed ? 'passed' : 'lapsed';

      await executeSql(
        `UPDATE progress SET mastery_score = $1, attempts = attempts + 1, last_attempt_at = datetime('now')${completed ? ", completed_at = datetime('now')" : ''}${schedule ? ", next_review_at = datetime('now', $2), review_interval_days = $3" : ''}
         WHERE student_id = $4 AND subject = $5 AND concept_id = $6`,
        schedule
          ? [newScore, schedule.modifier, schedule.intervalDays, auth.userId, subject, conceptId]
          : [newScore, auth.userId, subject, conceptId]
      );
    } else {
      schedule = attemptPassed ? scheduleAfterMastery(null) : null;
      scheduleReason = 'first_pass';

      await executeSql(
        `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at${attemptPassed ? ', completed_at' : ''}${schedule ? ', next_review_at, review_interval_days' : ''})
         VALUES ($1, $2, $3, $4, 1, datetime('now')${attemptPassed ? ", datetime('now')" : ''}${schedule ? ", datetime('now', $5), $6" : ''})`,
        schedule
          ? [auth.userId, subject, conceptId, score, schedule.modifier, schedule.intervalDays]
          : [auth.userId, subject, conceptId, score]
      );
    }

    if (schedule) {
      await recordDecision({
        studentId: auth.userId,
        subject,
        conceptId,
        kind: 'review_schedule',
        decision: `+${schedule.intervalDays}d`,
        reason: scheduleReason,
        inputs: { score, priorAttempts },
      });
    }

    const passed = newScore >= MASTERY_THRESHOLD;

    // Read once: both the diagnosis and the XP award are about the quality of
    // this attempt, not of the day.
    const concept = getConcept(subject, conceptId);
    const answers = await loadAttemptAnswers(auth.userId, subject, conceptId);
    const rapidThresholdMs = rapidAnswerThresholdMs(concept?.metadata?.difficulty);

    const diagnosis = diagnoseAttempt({ answers, priorAttempts, rapidThresholdMs });

    const xp = awardXp({
      score,
      focusScore: attemptFocusScore(answers, rapidThresholdMs),
      priorAttempts,
      estimatedMinutes: concept?.metadata?.estimatedMinutes,
      gamed: diagnosis.pattern === 'rapid_guessing',
    });

    await recordDecision({
      studentId: auth.userId,
      subject,
      conceptId,
      kind: 'diagnosis',
      decision: diagnosis.pattern,
      reason: passed ? 'passed' : 'failed',
      inputs: { score, answers: answers.length, rapidThresholdMs },
    });

    await recordDecision({
      studentId: auth.userId,
      subject,
      conceptId,
      kind: 'xp_award',
      decision: String(xp.amount),
      reason: xp.reason,
      inputs: { score, estimatedMinutes: concept?.metadata?.estimatedMinutes },
    });

    if (xp.amount !== 0) {
      await executeSql(
        'INSERT INTO xp_awards (student_id, subject, concept_id, amount, reason) VALUES ($1, $2, $3, $4, $5)',
        [auth.userId, subject, conceptId, xp.amount, xp.reason]
      );
    }

    if (passed) {
      return Response.json({
        masteryScore: newScore,
        passed,
        message: "Congratulations! You've mastered this concept!",
        xp,
      });
    }

    // Why they failed decides what to offer: a student who rushed or walked
    // away hasn't shown a knowledge gap, so sending them to a prerequisite
    // would be answering the wrong question.
    const remediation = diagnosis.isAttention
      ? {
          action: 'extra_practice' as const,
          messageKey: diagnosis.messageKey,
          messageParams: diagnosis.messageParams,
        }
      : await buildRemediation(auth.userId, subject, conceptId);

    await recordDecision({
      studentId: auth.userId,
      subject,
      conceptId,
      kind: 'remediation',
      decision: remediation?.conceptId ?? remediation?.action ?? 'none',
      reason: diagnosis.pattern,
      inputs: { score, priorAttempts },
    });

    return Response.json({
      masteryScore: newScore,
      passed,
      message: 'Keep practicing to reach 80% mastery.',
      diagnosis: diagnosis.pattern,
      xp,
      remediation,
    });
  } catch (error) {
    console.error('Submit quiz error:', error);
    return Response.json({ error: 'Failed to submit quiz results' }, { status: 500 });
  }
}
