/**
 * POST /api/admin/curriculum/publish
 *
 * Moves a subject and its concepts from draft to published. This is the point
 * where authored content reaches students, so the graph is validated again
 * here — the check on save can be bypassed by editing neighbours afterwards.
 *
 * Note that published content only reaches a running instance when it reloads
 * the curriculum, which happens per serverless instance at cold start.
 */

import { executeSql } from '../../_lib/db.js';
import { isDenied, requireStaff } from '../../_lib/staff.js';
import { validateConceptGraph } from '../../_lib/curriculum-validation.js';

interface ConceptRow {
  concept_id: string;
  name: string;
  level: number;
  prerequisites: string;
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
      'SELECT concept_id, name, level, prerequisites FROM curriculum_concepts WHERE subject_id = $1',
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

    return Response.json({ success: true, subjectId, status, concepts: rows.rows.length });
  } catch (error) {
    console.error('Publish error:', error);
    return Response.json({ error: 'Failed to publish' }, { status: 500 });
  }
}
