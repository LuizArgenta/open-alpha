/**
 * The last metre of the collaborative graph.
 *
 * The contribution pipeline was real and complete except at the end: teachers
 * could submit, peers could review, reputation was tracked, and the schema had
 * a `deployed` state. Nothing ever wrote `deployed`. It was only ever read, as
 * a guard. No code path took an approved contribution and put it in front of a
 * student, so a contribution could be approved by two reviewers and sit at
 * `approved` forever.
 *
 * That made an open, collaborative curriculum aspirational — not for want of
 * contributors, but because the door was shut at the far end.
 *
 * Publication is deliberately not a rubber stamp on approval. The merged
 * result is validated with the same rule that guards authored and generated
 * items, because a contribution that produces an unanswerable question would
 * be failed by every student forever while the engine reads it as a knowledge
 * gap. Two reviewers approving does not make a broken item answerable.
 */

import { executeSql, executeTransaction } from './db.js';
import { questionProblem } from './curriculum-record.js';
import { conceptContentHash } from './curriculum.js';

export interface PublishOutcome {
  published: boolean;
  /** Why not, when not — recorded so a stuck contribution can be explained. */
  reason?: string;
  questionsAdded?: number;
}

interface ConceptRow {
  name: string;
  description: string | null;
  level: number;
  prerequisites: string;
  content: string;
}

/**
 * Puts an approved quiz contribution in front of students.
 *
 * Merges its questions into the concept's mastery check, by question id: a
 * contribution that revises an existing question replaces it rather than
 * duplicating it, which is what makes a second submission a correction instead
 * of a second copy.
 */
export async function publishContribution(contributionId: number): Promise<PublishOutcome> {
  const contribution = await executeSql<{
    subject_id: string;
    concept_id: string;
    content: string;
    status: string;
    contribution_type: string;
  }>(
    `SELECT subject_id, concept_id, content, status, contribution_type
     FROM contributions WHERE id = $1`,
    [contributionId]
  );

  const row = contribution.rows[0];
  if (!row) return { published: false, reason: 'contribution not found' };
  if (row.status !== 'approved') {
    return { published: false, reason: `status is ${row.status}, not approved` };
  }
  if (row.contribution_type !== 'quiz_item') {
    // Lessons and new concepts publish differently and are not handled yet.
    // Saying so beats pretending it worked.
    return { published: false, reason: `${row.contribution_type} publishing is not implemented` };
  }

  const concept = await executeSql<ConceptRow>(
    `SELECT name, description, level, prerequisites, content
     FROM curriculum_concepts WHERE subject_id = $1 AND concept_id = $2`,
    [row.subject_id, row.concept_id]
  );

  if (concept.rows.length === 0) {
    // The curriculum is being served from files, so there is no row to publish
    // into. Failing loudly is right: silently dropping a teacher's accepted
    // work is the worst outcome available.
    return { published: false, reason: 'concept is not in the database' };
  }

  let contributed: { questions?: unknown[] };
  let content: Record<string, unknown>;
  try {
    contributed = JSON.parse(row.content) as { questions?: unknown[] };
    content = JSON.parse(concept.rows[0].content) as Record<string, unknown>;
  } catch {
    return { published: false, reason: 'stored JSON could not be parsed' };
  }

  const incoming = Array.isArray(contributed.questions) ? contributed.questions : [];
  if (incoming.length === 0) return { published: false, reason: 'contribution has no questions' };

  for (const [index, question] of incoming.entries()) {
    if (typeof question !== 'object' || question === null) {
      return { published: false, reason: `question ${index} is not an object` };
    }
    const problem = questionProblem(question as Record<string, unknown>, `contributed[${index}]`);
    if (problem) return { published: false, reason: problem };
  }

  const mastery = (content.masteryCheck ?? {}) as { passingScore?: number; questions?: unknown[] };
  const existing = Array.isArray(mastery.questions) ? mastery.questions : [];

  // Merged by id, so a revised question replaces the one it revises.
  const byId = new Map<string, unknown>();
  for (const question of [...existing, ...incoming]) {
    const id = (question as { id?: unknown }).id;
    byId.set(typeof id === 'string' && id.length > 0 ? id : `anon-${byId.size}`, question);
  }

  const merged = {
    ...content,
    masteryCheck: {
      passingScore: mastery.passingScore ?? 80,
      questions: [...byId.values()],
    },
  };

  const hash = conceptContentHash({
    name: concept.rows[0].name,
    description: concept.rows[0].description ?? '',
    gradeLevel: concept.rows[0].level,
    prerequisites: JSON.parse(concept.rows[0].prerequisites) as string[],
    content: merged,
  });

  await executeTransaction([
    {
      sql: `UPDATE curriculum_concepts
            SET content = $1, content_hash = $2,
                version = version + 1, updated_at = datetime('now')
            WHERE subject_id = $3 AND concept_id = $4`,
      params: [JSON.stringify(merged), hash, row.subject_id, row.concept_id],
    },
    {
      sql: `UPDATE contributions SET status = 'deployed', updated_at = datetime('now')
            WHERE id = $1`,
      params: [contributionId],
    },
  ]);

  return { published: true, questionsAdded: incoming.length };
}
