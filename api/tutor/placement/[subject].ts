/**
 * GET  /api/tutor/placement/{subject} — opens the probe to sit
 * POST /api/tutor/placement/{subject} — closes it, and turns it into a start
 *
 * Replaces "you are in 7th grade, so you must know everything below it" with
 * "show me".
 *
 * The probe is an assessment attempt, the same as a mastery check: the items
 * are stored when it opens, answered one at a time through the shared grading
 * endpoint, and read back from what the server recorded.
 *
 * It used to rebuild the probe from the curriculum on submission and match
 * answers to it by position, while taking the concept each answer counted for
 * from the client. So a student could answer the easiest item, label it with
 * the hardest concept, and be placed above the gap they still had — and no
 * record survived of which questions had actually been asked.
 */

import { type SqlStatement, executeSql, executeTransaction } from '../../_lib/db.js';
import { forbidden, getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import { MASTERY_THRESHOLD } from '../../_lib/curriculum.js';
import {
  PLACEMENT_CONFIDENCE,
  type ProbeAnswer,
  buildProbe,
  chooseProbeConcepts,
  estimateFromProbe,
} from '../../_lib/placement.js';
import { openAttempt, withoutAnswerKey } from '../../_lib/assessment.js';
import { ATTEMPT_DEADLINE_MODIFIER, attemptExpired, expireAttempt, expireStaleAttempts } from '../../_lib/attempts.js';
import { decisionStatement } from '../../_lib/decisions.js';
import { scheduleAfterMastery } from '../../_lib/review.js';

/** A placement spans a subject, so no single concept is the one assessed. */
const NO_SINGLE_CONCEPT = '*';

function subjectFromPath(request: Request): string {
  const segments = new URL(request.url).pathname.split('/');
  return segments[segments.length - 1];
}

async function loadStudent(userId: number) {
  const result = await executeSql<{ grade_level: number | null }>(
    'SELECT grade_level FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0];
}

async function conceptsAlreadyRecorded(studentId: number, subject: string): Promise<Set<string>> {
  const rows = await executeSql<{ concept_id: string }>(
    'SELECT concept_id FROM progress WHERE student_id = $1 AND subject = $2',
    [studentId, subject]
  );
  return new Set(rows.rows.map(row => row.concept_id));
}

export async function GET(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const subject = subjectFromPath(request);
    const student = await loadStudent(auth.userId);

    if (!student || student.grade_level === null) {
      return Response.json({ error: 'Grade level not set' }, { status: 400 });
    }

    await expireStaleAttempts(auth.userId);

    const concepts = chooseProbeConcepts(
      subject,
      student.grade_level,
      await conceptsAlreadyRecorded(auth.userId, subject)
    );

    // Nothing to ask about: either the subject has no authored checks yet, or
    // the student has already been placed.
    if (concepts.length === 0) {
      return Response.json({ available: false, items: [] });
    }

    const probe = buildProbe(concepts);

    const { attemptId, items } = await openAttempt({
      studentId: auth.userId,
      subject,
      conceptId: NO_SINGLE_CONCEPT,
      language: 'en',
      kind: 'placement',
      source: 'authored',
      items: probe.items.map(item => ({
        conceptId: item.conceptId,
        // The answer stays on the server: a placement the student can see
        // through measures nothing.
        question: item.question,
        authoredId: item.question.id,
      })),
    });

    return Response.json({ available: true, attemptId, items: items.map(withoutAnswerKey) });
  } catch (error) {
    console.error('Placement probe error:', error);
    return Response.json({ error: 'Failed to build placement' }, { status: 500 });
  }
}

interface PlacementAttemptRow {
  student_id: number;
  subject: string;
  kind: string;
  finished_at: string | null;
  expired_at: string | null;
  stale: number;
}

/**
 * The probe as the server graded it: which concept, and whether it was right.
 *
 * Every item the attempt was opened with counts, answered or not. A concept is
 * demonstrated only on a clean sweep, so counting only the answered items
 * would let a student skip the one they cannot do and be placed above it.
 */
async function gradedAnswers(attemptId: number): Promise<{ answers: ProbeAnswer[]; answered: number }> {
  const rows = await executeSql<{ concept_id: string; correct: number | null }>(
    `SELECT i.concept_id, r.correct
     FROM assessment_attempt_items ai
     JOIN assessment_items i ON i.id = ai.item_id
     LEFT JOIN assessment_responses r ON r.attempt_id = ai.attempt_id AND r.item_id = ai.item_id
     WHERE ai.attempt_id = $1
     ORDER BY ai.position`,
    [attemptId]
  );

  return {
    answers: rows.rows.map(row => ({ conceptId: row.concept_id, correct: row.correct === 1 })),
    answered: rows.rows.filter(row => row.correct !== null).length,
  };
}

export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const subject = subjectFromPath(request);
    const student = await loadStudent(auth.userId);

    if (!student || student.grade_level === null) {
      return Response.json({ error: 'Grade level not set' }, { status: 400 });
    }

    const body = await request.json() as { attemptId?: number };
    if (!Number.isInteger(body.attemptId)) {
      return Response.json({ error: 'attemptId is required' }, { status: 400 });
    }
    const attemptId = body.attemptId as number;

    const attemptRow = await executeSql<PlacementAttemptRow>(
      `SELECT student_id, subject, kind, finished_at, expired_at,
              started_at < datetime('now', $1) as stale
       FROM assessment_attempts WHERE id = $2`,
      [ATTEMPT_DEADLINE_MODIFIER, attemptId]
    );
    if (attemptRow.rows.length === 0) {
      return Response.json({ error: 'Attempt not found' }, { status: 404 });
    }

    const attempt = attemptRow.rows[0];
    if (attempt.student_id !== auth.userId) return forbidden();
    if (attempt.kind !== 'placement' || attempt.subject !== subject) {
      // A mastery attempt submitted here would place a student off one
      // concept, at a confidence the placement writes for a whole probe.
      return Response.json({ error: 'Not a placement attempt for this subject' }, { status: 400 });
    }
    if (attempt.expired_at !== null) return attemptExpired();

    // Placing twice would write a second set of progress rows over the first.
    if (attempt.finished_at !== null) {
      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
    }

    if (Number(attempt.stale) === 1) {
      await expireAttempt(attemptId);
      return attemptExpired();
    }

    const { answers: graded, answered } = await gradedAnswers(attemptId);
    if (answered === 0) {
      return Response.json({ error: 'No answers recorded for this attempt' }, { status: 400 });
    }

    const estimates = estimateFromProbe(graded);
    const placed = estimates.filter(estimate => estimate.demonstrated).map(estimate => estimate.conceptId);
    const answeredCorrectly = graded.filter(answer => answer.correct).length;

    // Decided first, written once: a placement that lands half-written would
    // start a student mid-way up a subject with no record of why.
    const writes: SqlStatement[] = [
      {
        sql: `UPDATE assessment_attempts SET score = $1, finished_at = datetime('now') WHERE id = $2`,
        params: [Math.round((answeredCorrectly / graded.length) * 100), attemptId],
      },
    ];

    for (const conceptId of placed) {
      const schedule = scheduleAfterMastery(null);
      writes.push({
        sql: `INSERT INTO progress
           (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at,
            completed_at, next_review_at, review_interval_days, mastery_source, mastery_confidence)
         VALUES ($1, $2, $3, $4, 0, datetime('now'), datetime('now'), datetime('now', $5), $6, 'placement', $7)
         ON CONFLICT(student_id, subject, concept_id) DO NOTHING`,
        params: [
          auth.userId,
          subject,
          conceptId,
          MASTERY_THRESHOLD,
          schedule.modifier,
          schedule.intervalDays,
          PLACEMENT_CONFIDENCE,
        ],
      });
    }

    writes.push(
      decisionStatement({
        studentId: auth.userId,
        subject,
        kind: 'placement',
        decision: placed.join(',') || 'none',
        reason: 'probe_completed',
        inputs: {
          gradeLevel: student.grade_level,
          attemptId,
          probed: estimates.length,
          asked: graded.length,
          answered,
          demonstrated: placed.length,
        },
      })
    );

    await executeTransaction(writes);

    return Response.json({
      placed,
      probed: estimates.map(({ conceptId, correct, asked, demonstrated }) => ({
        conceptId,
        correct,
        asked,
        demonstrated,
      })),
    });
  } catch (error) {
    console.error('Placement submit error:', error);
    return Response.json({ error: 'Failed to record placement' }, { status: 500 });
  }
}
