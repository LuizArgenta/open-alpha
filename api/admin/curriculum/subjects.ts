/**
 * GET  /api/admin/curriculum/subjects — every subject, drafts included
 * POST /api/admin/curriculum/subjects — create or rename one
 *
 * The public curriculum endpoints only ever show published content; this is
 * the view that authoring works against.
 */

import { executeSql } from '../../_lib/db.js';
import { isDenied, requireStaff } from '../../_lib/staff.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

interface SubjectRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  concepts: number;
  published_concepts: number;
}

export async function GET(request: Request) {
  const access = await requireStaff(request, 'teacher');
  if (isDenied(access)) return access;

  try {
    const rows = await executeSql<SubjectRow>(
      `SELECT s.id, s.name, s.description, s.status,
              COUNT(c.concept_id) as concepts,
              COALESCE(SUM(CASE WHEN c.status = 'published' THEN 1 ELSE 0 END), 0) as published_concepts
       FROM curriculum_subjects s
       LEFT JOIN curriculum_concepts c ON c.subject_id = s.id
       GROUP BY s.id
       ORDER BY s.name`
    );

    return Response.json({
      subjects: rows.rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description ?? '',
        status: row.status,
        concepts: Number(row.concepts),
        publishedConcepts: Number(row.published_concepts),
      })),
    });
  } catch (error) {
    console.error('List subjects error:', error);
    return Response.json({ error: 'Failed to list subjects' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await requireStaff(request, 'admin');
  if (isDenied(access)) return access;

  try {
    const body = await request.json() as { id: string; name: string; description?: string };
    const { id, name, description } = body;

    if (!id || !ID_PATTERN.test(id)) {
      return Response.json(
        { error: 'Subject id must be lowercase letters, digits and hyphens' },
        { status: 400 }
      );
    }
    if (!name?.trim()) {
      return Response.json({ error: 'Name is required' }, { status: 400 });
    }

    // New subjects start as drafts: an empty subject on a student's dashboard
    // is worse than no subject.
    await executeSql(
      `INSERT INTO curriculum_subjects (id, name, description, status)
       VALUES ($1, $2, $3, 'draft')
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         updated_at = datetime('now')`,
      [id, name.trim(), description?.trim() ?? '']
    );

    return Response.json({ success: true, id });
  } catch (error) {
    console.error('Upsert subject error:', error);
    return Response.json({ error: 'Failed to save subject' }, { status: 500 });
  }
}
