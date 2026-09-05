/**
 * GET  /api/admin/curriculum/concepts?subject=x — the tree as authored
 * POST /api/admin/curriculum/concepts — create or edit a concept
 *
 * Every write validates the whole subject graph, not just the concept being
 * saved: a prerequisite edit is only ever wrong in relation to its
 * neighbours, and an authoring click has no pull request standing between it
 * and the students.
 */

import { executeSql } from '../../_lib/db.js';
import { isDenied, requireStaff } from '../../_lib/staff.js';
import { type ValidatableConcept, validateConceptGraph } from '../../_lib/curriculum-validation.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,60}$/;

interface ConceptRow {
  concept_id: string;
  name: string;
  description: string | null;
  level: number;
  prerequisites: string;
  content: string;
  status: string;
  version: number;
}

async function graphOf(subjectId: string): Promise<ValidatableConcept[]> {
  const rows = await executeSql<ConceptRow>(
    'SELECT concept_id, name, level, prerequisites FROM curriculum_concepts WHERE subject_id = $1',
    [subjectId]
  );
  return rows.rows.map(row => ({
    id: row.concept_id,
    name: row.name,
    level: row.level,
    prerequisites: JSON.parse(row.prerequisites || '[]'),
  }));
}

export async function GET(request: Request) {
  const access = await requireStaff(request, 'teacher');
  if (isDenied(access)) return access;

  try {
    const subjectId = new URL(request.url).searchParams.get('subject');
    if (!subjectId) {
      return Response.json({ error: 'subject is required' }, { status: 400 });
    }

    const rows = await executeSql<ConceptRow>(
      `SELECT concept_id, name, description, level, prerequisites, content, status, version
       FROM curriculum_concepts WHERE subject_id = $1 ORDER BY level, name`,
      [subjectId]
    );

    const concepts = rows.rows.map(row => ({
      id: row.concept_id,
      name: row.name,
      description: row.description ?? '',
      level: row.level,
      prerequisites: JSON.parse(row.prerequisites || '[]') as string[],
      status: row.status,
      version: row.version,
      hasLesson: Object.keys(JSON.parse(row.content || '{}')).length > 0,
    }));

    return Response.json({
      concepts,
      problems: validateConceptGraph(concepts.map(c => ({
        id: c.id,
        name: c.name,
        level: c.level,
        prerequisites: c.prerequisites,
      }))),
    });
  } catch (error) {
    console.error('List concepts error:', error);
    return Response.json({ error: 'Failed to list concepts' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await requireStaff(request, 'admin');
  if (isDenied(access)) return access;

  try {
    const body = await request.json() as {
      subjectId: string;
      conceptId: string;
      name: string;
      description?: string;
      level: number;
      prerequisites?: string[];
    };
    const { subjectId, conceptId, name, description, level, prerequisites = [] } = body;

    if (!subjectId || !conceptId || !ID_PATTERN.test(conceptId)) {
      return Response.json({ error: 'Missing or invalid concept id' }, { status: 400 });
    }
    if (!name?.trim()) {
      return Response.json({ error: 'Name is required' }, { status: 400 });
    }
    if (!Number.isInteger(level) || level < 0) {
      return Response.json({ error: 'Level must be a non-negative integer' }, { status: 400 });
    }

    const subject = await executeSql<{ id: string }>(
      'SELECT id FROM curriculum_subjects WHERE id = $1',
      [subjectId]
    );
    if (subject.rows.length === 0) {
      return Response.json({ error: 'Subject not found' }, { status: 404 });
    }

    // Validate the graph as it would be after this save, and refuse before
    // writing rather than leaving a broken tree behind.
    const proposed = [
      ...(await graphOf(subjectId)).filter(concept => concept.id !== conceptId),
      { id: conceptId, name: name.trim(), level, prerequisites },
    ];
    const problems = validateConceptGraph(proposed);

    if (problems.length > 0) {
      return Response.json({ error: 'Graph would be invalid', problems }, { status: 422 });
    }

    await executeSql(
      `INSERT INTO curriculum_concepts
         (subject_id, concept_id, name, description, level, prerequisites, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       ON CONFLICT(subject_id, concept_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         level = EXCLUDED.level,
         prerequisites = EXCLUDED.prerequisites,
         version = curriculum_concepts.version + 1,
         updated_at = datetime('now')`,
      [subjectId, conceptId, name.trim(), description?.trim() ?? '', level, JSON.stringify(prerequisites)]
    );

    return Response.json({ success: true, conceptId });
  } catch (error) {
    console.error('Upsert concept error:', error);
    return Response.json({ error: 'Failed to save concept' }, { status: 500 });
  }
}
