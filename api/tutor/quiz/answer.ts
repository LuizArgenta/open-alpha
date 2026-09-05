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

import { executeSql } from '../../_lib/db.js';
import { getAuthFromRequest, forbidden, unauthorized } from '../../_lib/auth.js';

interface AttemptRow {
  student_id: number;
  finished_at: string | null;
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
      'SELECT student_id, finished_at FROM assessment_attempts WHERE id = $1',
      [attemptId]
    );
    if (attempt.rows.length === 0) {
      return Response.json({ error: 'Attempt not found' }, { status: 404 });
    }

    // Someone else's attempt is not yours to answer.
    if (attempt.rows[0].student_id !== auth.userId) return forbidden();

    if (attempt.rows[0].finished_at !== null) {
      return Response.json({ error: 'Attempt already finished' }, { status: 409 });
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

    // Answering the same item twice returns the first answer rather than
    // replacing it: otherwise a student could keep trying until it is right.
    const existing = await executeSql<ExistingResponseRow>(
      'SELECT chosen, correct FROM assessment_responses WHERE attempt_id = $1 AND item_id = $2',
      [attemptId, itemId]
    );
    if (existing.rows.length > 0) {
      return Response.json({
        correct: existing.rows[0].correct === 1,
        chosen: existing.rows[0].chosen,
        correctAnswer: item.rows[0].correct_answer,
        explanation: item.rows[0].explanation,
        alreadyAnswered: true,
      });
    }

    const correct = chosen === item.rows[0].correct_answer;

    await executeSql(
      `INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct, response_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attemptId,
        itemId,
        chosen,
        correct ? 1 : 0,
        // Client-measured and therefore untrusted for anything that gates
        // progress; it feeds the focus signals only.
        Number.isFinite(responseTimeMs) ? responseTimeMs : null,
      ]
    );

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
