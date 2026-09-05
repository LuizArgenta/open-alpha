/**
 * One place that answers "is this adult allowed to see this child's data".
 *
 * The check was copied into every parent endpoint. An authorization rule with
 * four copies is a rule that eventually has three copies and one mistake.
 */

import { executeSql } from './db.js';
import { type AuthPayload, forbidden, getAuthFromRequest, unauthorized } from './auth.js';

export interface GuardianAccess {
  auth: AuthPayload;
  childId: number;
}

/** Reads the child id out of /api/parent/children/{childId}/... */
export function childIdFromPath(request: Request): number {
  const segments = new URL(request.url).pathname.split('/');
  return parseInt(segments[segments.indexOf('children') + 1], 10);
}

/**
 * Returns the access on success, or the Response to send back on failure —
 * so a caller cannot forget to stop, the way an exception-free boolean check
 * lets you.
 */
export async function requireLinkedChild(
  request: Request,
  childId: number
): Promise<GuardianAccess | Response> {
  const auth = getAuthFromRequest(request);
  if (!auth || auth.role !== 'parent') return unauthorized();

  if (!Number.isInteger(childId)) {
    return Response.json({ error: 'Invalid child id' }, { status: 400 });
  }

  const link = await executeSql<{ id: number }>(
    `SELECT id FROM parent_links
     WHERE parent_id = $1 AND student_id = $2 AND linked_at IS NOT NULL`,
    [auth.userId, childId]
  );

  if (link.rows.length === 0) return forbidden();

  return { auth, childId };
}

export function isDenied(result: GuardianAccess | Response): result is Response {
  return result instanceof Response;
}
