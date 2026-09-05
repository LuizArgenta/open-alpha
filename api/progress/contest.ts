import { executeSql } from '../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';

const CONTESTABLE_PATTERNS = ['rapid_guessing', 'walked_away'];

// POST — the student disputes a focus signal counted against them today.
// A meter that judges without a right of reply is surveillance, not feedback.
export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const body = await request.json() as { pattern: string };
    const { pattern } = body;

    if (!CONTESTABLE_PATTERNS.includes(pattern)) {
      return Response.json({ error: `Invalid pattern: ${pattern}` }, { status: 400 });
    }

    const existing = await executeSql<{ id: number }>(
      `SELECT id FROM focus_contests
       WHERE student_id = $1 AND pattern = $2 AND created_at >= date('now')`,
      [auth.userId, pattern]
    );

    if (existing.rows.length === 0) {
      await executeSql(
        'INSERT INTO focus_contests (student_id, pattern) VALUES ($1, $2)',
        [auth.userId, pattern]
      );
    }

    return Response.json({ success: true, pattern });
  } catch (error) {
    console.error('Focus contest error:', error);
    return Response.json({ error: 'Failed to record contest' }, { status: 500 });
  }
}
