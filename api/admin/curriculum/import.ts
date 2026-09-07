/**
 * POST /api/admin/curriculum/import
 *
 * Brings a corpus bundle in as drafts. Item 1.7.
 *
 * Drafts, never published: publishing is where the provenance gate lives, and
 * an import that walked straight past it would defeat the item that had to
 * land first. Someone has to look at four hundred imported concepts before
 * children see them, and the two-step is what makes that possible rather than
 * polite.
 *
 * All or nothing, because a partial import of a graph leaves prerequisites
 * pointing at concepts that were rejected — a curriculum measurably worse than
 * the one before the import ran.
 */

import { executeSql, executeTransaction } from '../../_lib/db.js';
import { isDenied, requireStaff } from '../../_lib/staff.js';
import { prepareBundle } from '../../_lib/corpus-import.js';

interface ExistingRow {
  concept_id: string;
  name: string;
  level: number;
  prerequisites: string;
}

export async function POST(request: Request) {
  const access = await requireStaff(request, 'admin');
  if (isDenied(access)) return access;

  try {
    const bundle = await request.json() as { subjectId?: string };

    if (typeof bundle?.subjectId !== 'string' || bundle.subjectId.trim() === '') {
      return Response.json({ error: 'The bundle names no subject' }, { status: 400 });
    }

    const subject = await executeSql<{ id: string }>(
      'SELECT id FROM curriculum_subjects WHERE id = $1',
      [bundle.subjectId]
    );
    if (subject.rows.length === 0) {
      return Response.json({ error: 'Subject not found' }, { status: 404 });
    }

    const existing = await executeSql<ExistingRow>(
      'SELECT concept_id, name, level, prerequisites FROM curriculum_concepts WHERE subject_id = $1',
      [bundle.subjectId]
    );

    const prepared = prepareBundle(bundle, existing.rows.map(row => ({
      id: row.concept_id,
      name: row.name,
      level: row.level,
      prerequisites: JSON.parse(row.prerequisites || '[]'),
    })));

    if ('problems' in prepared) {
      return Response.json(
        { error: 'The bundle was not imported', problems: prepared.problems },
        { status: 422 }
      );
    }

    await executeTransaction(prepared.concepts.map(concept => ({
      sql: `INSERT INTO curriculum_concepts
              (subject_id, concept_id, name, description, level, prerequisites, content, status,
               content_source, content_source_url, content_source_version,
               content_license, content_attribution)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11, $12)
            ON CONFLICT(subject_id, concept_id) DO UPDATE SET
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              level = EXCLUDED.level,
              prerequisites = EXCLUDED.prerequisites,
              content = EXCLUDED.content,
              content_source = EXCLUDED.content_source,
              content_source_url = EXCLUDED.content_source_url,
              content_source_version = EXCLUDED.content_source_version,
              content_license = EXCLUDED.content_license,
              content_attribution = EXCLUDED.content_attribution,
              version = curriculum_concepts.version + 1,
              updated_at = datetime('now')`,
      params: [
        bundle.subjectId,
        concept.conceptId,
        concept.name.trim(),
        concept.description?.trim() ?? '',
        concept.level,
        JSON.stringify(concept.prerequisites ?? []),
        JSON.stringify(concept.content ?? {}),
        concept.provenance.source,
        concept.provenance.sourceUrl ?? null,
        concept.provenance.sourceVersion ?? null,
        concept.provenance.license ?? null,
        concept.provenance.attribution ?? null,
      ],
    })));

    return Response.json({
      success: true,
      subjectId: bundle.subjectId,
      imported: prepared.concepts.length,
      // Said out loud: an admin who reads "imported 400" and assumes children
      // can see them has been misled by the word.
      status: 'draft',
    });
  } catch (error) {
    console.error('Corpus import error:', error);
    return Response.json({ error: 'Failed to import corpus' }, { status: 500 });
  }
}
