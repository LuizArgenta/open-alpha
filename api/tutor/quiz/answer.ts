/**
 * POST /api/tutor/quiz/answer
 *
 * Grades one answer, on the server, against the item as it was stored when
 * the attempt was opened.
 *
 * The browser used to be told the correct answer up front and then trusted to
 * report how it did. Everything downstream — mastery, XP, spaced review, the
 * diagnosis, the decision log, what a parent is shown — was therefore
 * downstream of a number the student's own device chose.
 *
 * The correct answer is returned only *after* the student commits to one, for
 * that item alone. That is the teaching moment, and by then knowing it cannot
 * change the outcome.
 */

import { executeSql, withTransaction } from '../../_lib/db.js';
import { getAuthFromRequest, forbidden, unauthorized } from '../../_lib/auth.js';
import { ATTEMPT_DEADLINE_MODIFIER, attemptExpired, expireAttempt } from '../../_lib/attempts.js';

interface AttemptRow {
  student_id: number;
  finished_at: string | null;
  expired_at: string | null;
  stale: number;
}

interface ItemRow {
  correct_answer: string;
  explanation: string | null;
}

interface ExistingResponseRow {
  chosen: string | null;
  correct: number;
}

export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const body = await request.json() as {
      attemptId?: number;
      itemId?: number;
      chosen?: string;
      responseTimeMs?: number;
    };
    const { attemptId, itemId, chosen, responseTimeMs } = body;

    if (!Number.isInteger(attemptId) || !Number.isInteger(itemId) || typeof chosen !== 'string') {
      return Response.json({ error: 'Missing or invalid fields' }, { status: 400 });
    }

    const attempt = await executeSql<AttemptRow>(
      `SELECT student_id, finished_at, expired_at,
              started_at < datetime('now', $1) as stale
       FROM assessment_attempts WHERE id = $2`,
      [ATTEMPT_DEADLINE_MODIFIER, attemptId]
    );
    if (attempt.rows.length === 0) {
      return Response.json({ error: 'Attempt not found' }, { status: 404 });
    }

    // Someone else's attempt is not yours to answer.
    if (attempt.rows[0].student_id !== auth.userId) return forbidden();

    if (attempt.rows[0].expired_at !== null) return attemptExpired();

    if (attempt.rows[0].finished_at !== null) {
      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
    }

    // Answering a quiz opened hours ago is not the same activity the pace
    // signals and the mastery decision assume it is.
    if (Number(attempt.rows[0].stale) === 1) {
      await expireAttempt(attemptId as number);
      return attemptExpired();
    }

    // The item has to be part of this attempt, not merely a real item.
    const belongs = await executeSql<{ item_id: number }>(
      'SELECT item_id FROM assessment_attempt_items WHERE attempt_id = $1 AND item_id = $2',
      [attemptId, itemId]
    );
    if (belongs.rows.length === 0) {
      return Response.json({ error: 'Item does not belong to this attempt' }, { status: 400 });
    }

    const item = await executeSql<ItemRow>(
      'SELECT correct_answer, explanation FROM assessment_items WHERE id = $1',
      [itemId]
    );
    if (item.rows.length === 0) {
      return Response.json({ error: 'Item not found' }, { status: 404 });
    }

    const correct = chosen === item.rows[0].correct_answer;

    /**
     * The checks above ran three round trips ago, and two other writers can
     * act in that window.
     *
     * `submit` closes the attempt: an answer that passed the open check before
     * the submission read the responses used to land *after* the score, the
     * mastery decision and the XP were written from a set that did not include
     * it. The row stayed in the table, uncounted — a stored score its own
     * stored evidence could not explain, which is the one thing this whole
     * assessment path exists to guarantee.
     *
     * Another `answer` for the same item does the same to the "already
     * answered?" read: both requests saw nothing and both inserted. The unique
     * index kept the database honest and turned the loser into a 500 for a
     * request that had, in every sense the student cares about, succeeded.
     *
     * So the condition travels with the write instead of preceding it. One
     * statement: insert only while the attempt is still open, and only if this
     * item has no answer yet. Nothing between the test and the act.
     */
    const inserted = await withTransaction(scope => scope.run<{ id: number }>(
      `INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct, response_ms)
       SELECT $1, $2, $3, $4, $5
       WHERE EXISTS (
         SELECT 1 FROM assessment_attempts
         WHERE id = $1 AND finished_at IS NULL AND expired_at IS NULL
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        attemptId,
        itemId,
        chosen,
        correct ? 1 : 0,
        // Client-measured and therefore untrusted for anything that gates
        // progress; it feeds the focus signals only.
        Number.isFinite(responseTimeMs) ? responseTimeMs : null,
      ]
    ));

    // Nothing written. Either this item was answered while we were deciding,
    // or the attempt closed underneath us — and the student is owed different
    // answers, so read back which it was rather than guessing.
    if (inserted.rows.length === 0) {
      const existing = await executeSql<ExistingResponseRow>(
        'SELECT chosen, correct FROM assessment_responses WHERE attempt_id = $1 AND item_id = $2',
        [attemptId, itemId]
      );

      // Answering the same item twice returns the first answer rather than
      // replacing it: otherwise a student could keep trying until it is right.
      if (existing.rows.length > 0) {
        return Response.json({
          correct: existing.rows[0].correct === 1,
          chosen: existing.rows[0].chosen,
          correctAnswer: item.rows[0].correct_answer,
          explanation: item.rows[0].explanation,
          alreadyAnswered: true,
        });
      }

      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
    }

    return Response.json({
      correct,
      chosen,
      correctAnswer: item.rows[0].correct_answer,
      explanation: item.rows[0].explanation,
    });
  } catch (error) {
    console.error('Quiz answer error:', error);
    return Response.json({ error: 'Failed to record answer' }, { status: 500 });
  }
}
