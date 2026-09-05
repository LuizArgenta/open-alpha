/**
 * POST /api/db/import-curriculum
 *
 * Seeds the database from the JSON files. Run once after deploying the
 * database-backed curriculum, and again whenever the files change — the
 * import is idempotent and overwrites what the files define.
 *
 * Guarded by the same admin key as the schema initialisation: it rewrites
 * what every student is taught.
 */

import { importCurriculumFromFiles } from '../_lib/curriculum.js';

export async function POST(request: Request) {
  const adminKey = process.env.ADMIN_INIT_KEY;
  const authHeader = request.headers.get('authorization');

  if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const imported = await importCurriculumFromFiles();
    return Response.json({ success: true, ...imported });
  } catch (error) {
    console.error('Curriculum import error:', error);
    return Response.json({ error: 'Failed to import curriculum' }, { status: 500 });
  }
}
