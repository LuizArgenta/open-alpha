import { executeSql } from '../../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../../_lib/auth.js';
import { selectNextConcept } from '../../_lib/curriculum.js';
import { recordDecision } from '../../_lib/decisions.js';
import { POLICY_VERSION, actionForNextConcept } from '../../_lib/next-action.js';

interface User {
  grade_level: number | null;
}

interface Progress {
  concept_id: string;
  mastery_score: number;
  attempts: number;
}

export async function GET(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth) return unauthorized();

    // Extract subject from URL path: /api/tutor/next/[subject]
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const subject = pathParts[pathParts.length - 1];

    const userResult = await executeSql<User>(
      'SELECT grade_level FROM users WHERE id = $1',
      [auth.userId]
    );

    if (userResult.rows.length === 0 || userResult.rows[0].grade_level === null) {
      return Response.json({ error: 'Grade level not set' }, { status: 400 });
    }

    // Every row, not just mastered ones: attempts and score on failed concepts
    // are what let the engine step back to a prerequisite instead of looping.
    const progressResult = await executeSql<Progress>(
      'SELECT concept_id, mastery_score, attempts FROM progress WHERE student_id = $1 AND subject = $2',
      [auth.userId, subject]
    );

    const progress = progressResult.rows.map(row => ({
      conceptId: row.concept_id,
      masteryScore: row.mastery_score,
      attempts: row.attempts,
    }));
    const selection = selectNextConcept(subject, progress, userResult.rows[0].grade_level);
    const nextConcept = selection?.concept;

    /**
     * Whether the engine moved forward or stepped back is the single most
     * useful thing an adult can know about this decision — and under the
     * action contract they are different instructions, not one "concept".
     *
     * The selector is asked rather than guessed at. Inferring it from "no
     * progress row for this concept and progress elsewhere" is wrong in the
     * ordinary case: a student who masters one concept moves to the next
     * *unseen* one, which by definition has no row. Every normal advancement
     * was labelled `prerequisite_gap`, and once 1.4 made the reason drive the
     * action, mastering something told the learner to go back and review it.
     */
    const nextAction = selection
      ? actionForNextConcept(selection.concept, selection.reason === 'prerequisite_gap')
      : null;

    if (nextConcept && nextAction) {
      await recordDecision({
        studentId: auth.userId,
        subject,
        conceptId: nextConcept.id,
        kind: 'next_concept',
        decision: nextConcept.id,
        reason: nextAction.reason,
        inputs: {
          gradeLevel: userResult.rows[0].grade_level,
          conceptsWithProgress: progress.length,
          // Which rulebook was in force. Without it, a decision recorded
          // before the rules changed cannot be told from one after, and
          // comparing outcomes across the change is comparing two things.
          policyVersion: POLICY_VERSION,
        },
      });
    }

    // `concept` stays for compatibility, as the PRD says it should: the
    // action is the contract, the concept is what the current client reads.
    return Response.json({ concept: nextConcept || null, nextAction });
  } catch (error) {
    console.error('Get next concept error:', error);
    return Response.json({ error: 'Failed to get next concept' }, { status: 500 });
  }
}
