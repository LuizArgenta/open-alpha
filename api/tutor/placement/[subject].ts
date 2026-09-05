/**
 * GET  /api/tutor/placement/{subject} — the probe to sit
 * POST /api/tutor/placement/{subject} — its answers, turned into a starting point
 *
 * Replaces "you are in 7th grade, so you must know everything below it" with
 * "show me".
 */

import { executeSql } from '../../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import { MASTERY_THRESHOLD } from '../../_lib/curriculum.js';
import {
  PLACEMENT_CONFIDENCE,
  type ProbeAnswer,
  buildProbe,
  chooseProbeConcepts,
  estimateFromProbe,
} from '../../_lib/placement.js';
import { recordDecision } from '../../_lib/decisions.js';
import { scheduleAfterMastery } from '../../_lib/review.js';

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

    return Response.json({
      available: true,
      items: probe.items.map(item => ({
        conceptId: item.conceptId,
        question: item.question.question,
        options: item.question.options,
        // The answer stays on the server: a placement the student can see
        // through measures nothing.
      })),
    });
  } catch (error) {
    console.error('Placement probe error:', error);
    return Response.json({ error: 'Failed to build placement' }, { status: 500 });
  }
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

    const body = await request.json() as { answers?: { conceptId: string; chosen: string }[] };
    const submitted = body.answers ?? [];

    if (submitted.length === 0) {
      return Response.json({ error: 'No answers submitted' }, { status: 400 });
    }

    // Graded against the curriculum, not against what the client claims: a
    // client that reports its own correctness can place itself anywhere.
    const concepts = chooseProbeConcepts(
      subject,
      student.grade_level,
      await conceptsAlreadyRecorded(auth.userId, subject)
    );
    const probe = buildProbe(concepts);

    const graded: ProbeAnswer[] = submitted.map((answer, index) => ({
      conceptId: answer.conceptId,
      correct: probe.items[index]?.question.correctAnswer === answer.chosen,
    }));

    const estimates = estimateFromProbe(graded);
    const placed: string[] = [];

    for (const estimate of estimates) {
      if (!estimate.demonstrated) continue;

      const schedule = scheduleAfterMastery(null);
      await executeSql(
        `INSERT INTO progress
           (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at,
            completed_at, next_review_at, review_interval_days, mastery_source, mastery_confidence)
         VALUES ($1, $2, $3, $4, 0, datetime('now'), datetime('now'), datetime('now', $5), $6, 'placement', $7)
         ON CONFLICT(student_id, subject, concept_id) DO NOTHING`,
        [
          auth.userId,
          subject,
          estimate.conceptId,
          MASTERY_THRESHOLD,
          schedule.modifier,
          schedule.intervalDays,
          PLACEMENT_CONFIDENCE,
        ]
      );
      placed.push(estimate.conceptId);
    }

    await recordDecision({
      studentId: auth.userId,
      subject,
      kind: 'placement',
      decision: placed.join(',') || 'none',
      reason: 'probe_completed',
      inputs: {
        gradeLevel: student.grade_level,
        probed: estimates.length,
        demonstrated: placed.length,
      },
    });

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
