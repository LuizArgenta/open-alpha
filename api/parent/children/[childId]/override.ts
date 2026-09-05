/**
 * POST /api/parent/children/{childId}/override
 *
 * Lets the adult overrule the engine about a concept, with their reason on
 * the record. A system that decides a child's path and cannot be contradicted
 * by the people who know them is not a tool, it is an authority.
 *
 * Every override is written to the decision log the same way the engine's own
 * decisions are, so the timeline shows who changed what and why.
 */

import { executeSql } from '../../../_lib/db.js';
import { MASTERY_THRESHOLD, getConcept } from '../../../_lib/curriculum.js';
import { recordDecision } from '../../../_lib/decisions.js';
import { scheduleAfterMastery } from '../../../_lib/review.js';
import { childIdFromPath, isDenied, requireLinkedChild } from '../../../_lib/guardian.js';

const ACTIONS = ['mark_mastered', 'reset_concept'] as const;
type OverrideAction = (typeof ACTIONS)[number];

const MIN_REASON_LENGTH = 3;

export async function POST(request: Request) {
  try {
    const access = await requireLinkedChild(request, childIdFromPath(request));
    if (isDenied(access)) return access;

    const body = await request.json() as {
      action: OverrideAction;
      subject: string;
      conceptId: string;
      reason?: string;
    };
    const { action, subject, conceptId, reason } = body;

    if (!ACTIONS.includes(action) || !subject || !conceptId) {
      return Response.json({ error: 'Missing or invalid fields' }, { status: 400 });
    }

    // An override without a stated reason is indistinguishable from a mistake
    // when someone reads the log six months later.
    if (!reason || reason.trim().length < MIN_REASON_LENGTH) {
      return Response.json({ error: 'A reason is required' }, { status: 400 });
    }

    if (!getConcept(subject, conceptId)) {
      return Response.json({ error: 'Concept not found' }, { status: 404 });
    }

    if (action === 'mark_mastered') {
      const schedule = scheduleAfterMastery(null);

      await executeSql(
        `INSERT INTO progress
           (student_id, subject, concept_id, mastery_score, attempts, last_attempt_at,
            completed_at, next_review_at, review_interval_days, mastery_source, mastery_confidence)
         VALUES ($1, $2, $3, $4, 0, datetime('now'), datetime('now'), datetime('now', $5), $6, 'override', 1.0)
         ON CONFLICT(student_id, subject, concept_id) DO UPDATE SET
           mastery_score = MAX(progress.mastery_score, EXCLUDED.mastery_score),
           completed_at = datetime('now'),
           next_review_at = EXCLUDED.next_review_at,
           review_interval_days = EXCLUDED.review_interval_days,
           mastery_source = 'override',
           mastery_confidence = 1.0`,
        [access.childId, subject, conceptId, MASTERY_THRESHOLD, schedule.modifier, schedule.intervalDays]
      );
    } else {
      // Clears the record so the concept is met fresh: the child's failures
      // were about something other than the concept.
      await executeSql(
        'DELETE FROM progress WHERE student_id = $1 AND subject = $2 AND concept_id = $3',
        [access.childId, subject, conceptId]
      );
    }

    await recordDecision({
      studentId: access.childId,
      subject,
      conceptId,
      kind: 'override',
      decision: action,
      reason: 'human_override',
      inputs: { byUserId: access.auth.userId, byRole: access.auth.role, note: reason.trim() },
    });

    return Response.json({ success: true, action });
  } catch (error) {
    console.error('Override error:', error);
    return Response.json({ error: 'Failed to apply override' }, { status: 500 });
  }
}
