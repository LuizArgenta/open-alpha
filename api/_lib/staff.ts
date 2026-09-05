/**
 * Staff authorization.
 *
 * The role is read from the database on every request rather than from the
 * token: a token lives seven days, and revoking someone's ability to rewrite
 * the curriculum should take effect when it is revoked, not a week later.
 */

import { executeSql } from './db.js';
import { type AuthPayload, forbidden, getAuthFromRequest, unauthorized } from './auth.js';

export type StaffRole = 'teacher' | 'admin';

export interface StaffAccess {
  auth: AuthPayload;
  roles: StaffRole[];
}

export async function staffRolesOf(userId: number): Promise<StaffRole[]> {
  const rows = await executeSql<{ role: StaffRole }>(
    'SELECT role FROM staff_roles WHERE user_id = $1',
    [userId]
  );
  return rows.rows.map(row => row.role);
}

/**
 * Returns the access, or the Response to send back — so a caller cannot
 * forget to stop.
 */
export async function requireStaff(
  request: Request,
  required: StaffRole
): Promise<StaffAccess | Response> {
  const auth = getAuthFromRequest(request);
  if (!auth) return unauthorized();

  const roles = await staffRolesOf(auth.userId);

  // An admin can do anything a teacher can.
  const allowed = roles.includes(required) || roles.includes('admin');
  if (!allowed) return forbidden();

  return { auth, roles };
}

export function isDenied(result: StaffAccess | Response): result is Response {
  return result instanceof Response;
}
