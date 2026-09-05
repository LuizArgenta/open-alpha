import { type SqlStatement, executeSql, executeTransaction } from '../../_lib/db.js';
import { forbidden, getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
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
import { decisionStatement } from '../../_lib/decisions.js';
import { ATTEMPT_DEADLINE_MODIFIER, attemptExpired, expireAttempt } from '../../_lib/attempts.js';

interface AttemptRow {
  student_id: number;
  subject: string;
  concept_id: string;
  finished_at: string | null;
  expired_at: string | null;
  stale: number;
}

/**
 * The score, computed from what the server graded and stored — never from
 * what the client reports. Unanswered items count as wrong: skipping a
 * question must not be a way to raise a score.
 */
async function scoreFromStoredAnswers(attemptId: number): Promise<{ score: number; answered: number; total: number }> {
  const totals = await executeSql<{ total: number; answered: number; correct: number }>(
    `SELECT
       (SELECT COUNT(*) FROM assessment_attempt_items WHERE attempt_id = $1) as total,
       (SELECT COUNT(*) FROM assessment_responses WHERE attempt_id = $2) as answered,
       (SELECT COALESCE(SUM(correct), 0) FROM assessment_responses WHERE attempt_id = $3) as correct`,
    [attemptId, attemptId, attemptId]
  );

  const total = Number(totals.rows[0]?.total ?? 0);
  const correct = Number(totals.rows[0]?.correct ?? 0);

  return {
    score: total > 0 ? Math.round((correct / total) * 100) : 0,
    answered: Number(totals.rows[0]?.answered ?? 0),
    total,
  };
}

interface Progress {
  mastery_score: number;
  review_interval_days: number | null;
  attempts: number;
}

interface StoredAnswerRow {
  correct: number;
  response_ms: number | null;
  answered_at: string;
}

/**
 * The answers as the server graded them. This used to read learning_events,
 * whose `correct` flag was whatever the browser posted — so the diagnosis
 * that decides between "rushed" and "has a real gap" was reasoning over the
 * student's own claims.
 */
async function loadAttemptAnswers(attemptId: number): Promise<AnswerEvent[]> {
  const rows = await executeSql<StoredAnswerRow>(
    `SELECT r.correct, r.response_ms, r.answered_at
     FROM assessment_responses r
     JOIN assessment_attempt_items i ON i.attempt_id = r.attempt_id AND i.item_id = r.item_id
     WHERE r.attempt_id = $1
     ORDER BY i.position`,
    [attemptId]
  );

  return rows.rows.map(row => ({
    correct: row.correct === 1,
    responseTimeMs: row.response_ms ?? undefined,
    at: row.answered_at,
  }));
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

    // The attempt is the whole input. Subject, concept and score come from
    // the server's own record of it, so none of them can be asserted by the
    // client any more.
    const body = await request.json() as { attemptId?: number };

    if (!Number.isInteger(body.attemptId)) {
      return Response.json({ error: 'attemptId is required' }, { status: 400 });
    }
    const attemptId = body.attemptId as number;

    const attemptRow = await executeSql<AttemptRow>(
      `SELECT student_id, subject, concept_id, finished_at, expired_at,
              started_at < datetime('now', $1) as stale
       FROM assessment_attempts WHERE id = $2`,
      [ATTEMPT_DEADLINE_MODIFIER, attemptId]
    );
    if (attemptRow.rows.length === 0) {
      return Response.json({ error: 'Attempt not found' }, { status: 404 });
    }

    const attempt = attemptRow.rows[0];
    if (attempt.student_id !== auth.userId) return forbidden();

    if (attempt.expired_at !== null) return attemptExpired();

    // Finishing twice would award XP twice and re-run the schedule.
    if (attempt.finished_at !== null) {
      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
    }

    // A quiz opened hours ago and submitted now says nothing about whether the
    // student can do this today, which is what mastery claims. Expired rather
    // than graded: the answers stay as evidence, the decision is not made.
    if (Number(attempt.stale) === 1) {
      await expireAttempt(attemptId);
      return attemptExpired();
    }

    const subject = attempt.subject;
    const conceptId = attempt.concept_id;
    const { score } = await scoreFromStoredAnswers(attemptId);

    const existingProgress = await executeSql<Progress>(
      'SELECT mastery_score, review_interval_days, attempts FROM progress WHERE student_id = $1 AND subject = $2 AND concept_id = $3',
      [auth.userId, subject, conceptId]
    );

    const priorAttempts = existingProgress.rows[0]?.attempts ?? 0;

    // Everything below is decided from reads before anything is written, so the
    // writes can go in as one unit. Split writes used to be able to leave XP
    // awarded with no progress recorded, or an attempt closed with no mastery.
    const attemptPassed = score >= MASTERY_THRESHOLD;
    const hasProgress = existingProgress.rows.length > 0;
    const existing = existingProgress.rows[0];
    const wasMastered = hasProgress && existing.mastery_score >= MASTERY_THRESHOLD;

    // Mastery never regresses, so it is this attempt's raw score — not the
    // all-time best — that says whether the concept held up today.
    const newScore = hasProgress ? Math.max(existing.mastery_score, score) : score;
    const passed = newScore >= MASTERY_THRESHOLD;

    const schedule: ReviewSchedule | null = hasProgress
      ? attemptPassed
        ? scheduleAfterMastery(existing.review_interval_days)
        : wasMastered
          ? scheduleAfterLapse()
          : null
      : attemptPassed
        ? scheduleAfterMastery(null)
        : null;
    const scheduleReason = hasProgress ? (attemptPassed ? 'passed' : 'lapsed') : 'first_pass';

    // Read once: both the diagnosis and the XP award are about the quality of
    // this attempt, not of the day.
    const concept = getConcept(subject, conceptId);
    const answers = await loadAttemptAnswers(attemptId);
    const rapidThresholdMs = rapidAnswerThresholdMs(concept?.metadata?.difficulty);

    const diagnosis = diagnoseAttempt({ answers, priorAttempts, rapidThresholdMs });

    const xp = awardXp({
      score,
      focusScore: attemptFocusScore(answers, rapidThresholdMs),
      priorAttempts,
      estimatedMinutes: concept?.metadata?.estimatedMinutes,
      gamed: diagnosis.pattern === 'rapid_guessing',
    });

    // Why they failed decides what to offer: a student who rushed or walked
    // away hasn't shown a knowledge gap, so sending them to a prerequisite
    // would be answering the wrong question. Resolved before the write because
    // it reads the prerequisites' progress, which this attempt does not touch.
    const remediation = passed
      ? undefined
      : diagnosis.isAttention
        ? {
            action: 'extra_practice' as const,
            messageKey: diagnosis.messageKey,
            messageParams: diagnosis.messageParams,
          }
        : await buildRemediation(auth.userId, subject, conceptId);

    const writes: SqlStatement[] = [
      {
        sql: `UPDATE assessment_attempts SET score = $1, finished_at = datetime('now') WHERE id = $2`,
        params: [score, attemptId],
      },
    ];

    if (hasProgress) {
      writes.push({
        sql: `UPDATE progress SET mastery_score = $1, attempts = attempts + 1, last_attempt_at = datetime('now'), mastery_source = 'quiz', mastery_confidence = 1.0${passed ? ", completed_at = datetime('now')" : ''}${schedule ? ", next_review_at = datetime('now', $2), review_interval_days = $3" : ''}
         WHERE student_id = $4 AND subject = $5 AND concept_id = $6`,
        params: schedule
          ? [newScore, schedule.modifier, schedule.intervalDays, auth.userId, subject, conceptId]
          : [newScore, auth.userId, subject, conceptId],
      });
    } else {
      writes.push({
        sql: `INSERT INTO progress (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at, mastery_source, mastery_confidence${passed ? ', completed_at' : ''}${schedule ? ', next_review_at, review_interval_days' : ''})
         VALUES ($1, $2, $3, $4, 1, datetime('now'), 'quiz', 1.0${passed ? ", datetime('now')" : ''}${schedule ? ", datetime('now', $5), $6" : ''})`,
        params: schedule
          ? [auth.userId, subject, conceptId, score, schedule.modifier, schedule.intervalDays]
          : [auth.userId, subject, conceptId, score],
      });
    }

    if (xp.amount !== 0) {
      writes.push({
        sql: 'INSERT INTO xp_awards (student_id, subject, concept_id, amount, reason) VALUES ($1, $2, $3, $4, $5)',
        params: [auth.userId, subject, conceptId, xp.amount, xp.reason],
      });
    }

    // The decisions ride along in the same transaction rather than being
    // logged best-effort afterwards: they are the grounds for the rows above,
    // and a parent contesting a remediation is owed the record of it. A write
    // that lands without its justification is worse than one that fails.
    if (schedule) {
      writes.push(
        decisionStatement({
          studentId: auth.userId,
          subject,
          conceptId,
          kind: 'review_schedule',
          decision: `+${schedule.intervalDays}d`,
          reason: scheduleReason,
          inputs: { score, priorAttempts },
        })
      );
    }

    writes.push(
      decisionStatement({
        studentId: auth.userId,
        subject,
        conceptId,
        kind: 'diagnosis',
        decision: diagnosis.pattern,
        reason: passed ? 'passed' : 'failed',
        inputs: { score, answers: answers.length, rapidThresholdMs },
      })
    );

    writes.push(
      decisionStatement({
        studentId: auth.userId,
        subject,
        conceptId,
        kind: 'xp_award',
        decision: String(xp.amount),
        reason: xp.reason,
        inputs: { score, estimatedMinutes: concept?.metadata?.estimatedMinutes },
      })
    );

    if (!passed) {
      writes.push(
        decisionStatement({
          studentId: auth.userId,
          subject,
          conceptId,
          kind: 'remediation',
          decision: remediation?.conceptId ?? remediation?.action ?? 'none',
          reason: diagnosis.pattern,
          inputs: { score, priorAttempts },
        })
      );
    }

    await executeTransaction(writes);

    if (passed) {
      return Response.json({
        masteryScore: newScore,
        passed,
        message: "Congratulations! You've mastered this concept!",
        xp,
      });
    }

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
