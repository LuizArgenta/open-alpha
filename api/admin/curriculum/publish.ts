/**
 * POST /api/admin/curriculum/publish
 *
 * Moves a subject and its concepts from draft to published. This is the point
 * where authored content reaches students, so the graph is validated again
 * here — the check on save can be bypassed by editing neighbours afterwards.
 *
 * Publishing forces this instance to reload its curriculum, so the admin who
 * just published is not shown a stale graph. Other instances notice on their
 * own next check.
 *
 * It is also where provenance is enforced, and that placement is the point of
 * item 1.6. Publishing is the moment content reaches learners, so it is the
 * last moment at which "where did this come from, and under what licence" can
 * still be asked cheaply. After it, the answer has to be reconstructed, and
 * for a licence it cannot be reconstructed at all.
 */

import { executeSql } from '../../_lib/db.js';
import { isDenied, requireStaff } from '../../_lib/staff.js';
import { validateConceptGraph } from '../../_lib/curriculum-validation.js';
import { provenanceFromRow, provenanceProblem } from '../../_lib/provenance.js';
import { refreshCurriculum } from '../../_lib/curriculum.js';

interface ConceptRow {
  concept_id: string;
  name: string;
  level: number;
  prerequisites: string;
  content_source: string | null;
  content_source_url: string | null;
  content_source_version: string | null;
  content_license: string | null;
  content_attribution: string | null;
}

export async function POST(request: Request) {
  const access = await requireStaff(request, 'admin');
  if (isDenied(access)) return access;

  try {
    const body = await request.json() as { subjectId: string; unpublish?: boolean };
    const { subjectId, unpublish = false } = body;

    if (!subjectId) {
      return Response.json({ error: 'subjectId is required' }, { status: 400 });
    }

    const rows = await executeSql<ConceptRow>(
      `SELECT concept_id, name, level, prerequisites,
              content_source, content_source_url, content_source_version,
              content_license, content_attribution
       FROM curriculum_concepts WHERE subject_id = $1`,
      [subjectId]
    );

    if (!unpublish) {
      if (rows.rows.length === 0) {
        return Response.json(
          { error: 'A subject with no concepts has nothing to teach' },
          { status: 422 }
        );
      }

      const problems = validateConceptGraph(
        rows.rows.map(row => ({
          id: row.concept_id,
          name: row.name,
          level: row.level,
          prerequisites: JSON.parse(row.prerequisites || '[]'),
        }))
      );

      if (problems.length > 0) {
        return Response.json({ error: 'Graph is invalid', problems }, { status: 422 });
      }

      /**
       * Nothing publishes without an account of where it came from.
       *
       * Refused as a list rather than at the first failure: an admin fixing a
       * bulk import wants to know about all of them, and being told one at a
       * time turns a single correction into twenty round trips.
       */
      const unaccounted = rows.rows
        .map(row => {
          const problem = provenanceProblem(provenanceFromRow(row));
          return problem ? { conceptId: row.concept_id, problem } : undefined;
        })
        .filter((entry): entry is { conceptId: string; problem: string } => entry !== undefined);

      if (unaccounted.length > 0) {
        return Response.json(
          {
            error: 'Some concepts cannot be published without provenance',
            provenance: unaccounted,
          },
          { status: 422 }
        );
      }
    }

    const status = unpublish ? 'draft' : 'published';

    await executeSql(
      `UPDATE curriculum_subjects SET status = $1, updated_at = datetime('now') WHERE id = $2`,
      [status, subjectId]
    );
    await executeSql(
      `UPDATE curriculum_concepts SET status = $1, updated_at = datetime('now') WHERE subject_id = $2`,
      [status, subjectId]
    );

    // This instance is the one the admin is looking at: it should not tell
    // them the subject is published and then keep serving the old graph.
    // Other instances pick the change up on their own next check.
    await refreshCurriculum({ force: true });

    return Response.json({ success: true, subjectId, status, concepts: rows.rows.length });
  } catch (error) {
    console.error('Publish error:', error);
    return Response.json({ error: 'Failed to publish' }, { status: 500 });
  }
}
