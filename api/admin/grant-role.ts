/**
 * POST /api/admin/grant-role
 *
 * Grants or revokes a staff role. Accepts either an existing admin's token
 * or the deployment's admin key — the key exists so the first admin can be
 * created at all, since otherwise nobody could ever grant the first one.
 */

import { executeSql } from '../_lib/db.js';
import { getAuthFromRequest } from '../_lib/auth.js';
import { type StaffRole, staffRolesOf } from '../_lib/staff.js';

const ROLES: StaffRole[] = ['teacher', 'admin'];

async function callerMayGrant(request: Request): Promise<boolean> {
  const adminKey = process.env.ADMIN_INIT_KEY;
  const authHeader = request.headers.get('authorization');

  if (adminKey && authHeader === `Bearer ${adminKey}`) return true;

  const auth = getAuthFromRequest(request);
  if (!auth) return false;

  return (await staffRolesOf(auth.userId)).includes('admin');
}

export async function POST(request: Request) {
  try {
    if (!(await callerMayGrant(request))) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }

    const body = await request.json() as { email: string; role: StaffRole; revoke?: boolean };
    const { email, role, revoke = false } = body;

    if (!email || !ROLES.includes(role)) {
      return Response.json({ error: 'Missing or invalid fields' }, { status: 400 });
    }

    const user = await executeSql<{ id: number }>(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    if (user.rows.length === 0) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const userId = user.rows[0].id;

    if (revoke) {
      await executeSql('DELETE FROM staff_roles WHERE user_id = $1 AND role = $2', [userId, role]);
    } else {
      await executeSql(
        `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT(user_id, role) DO NOTHING`,
        [userId, role, getAuthFromRequest(request)?.userId ?? null]
      );
    }

    return Response.json({ success: true, email, role, revoked: revoke });
  } catch (error) {
    console.error('Grant role error:', error);
    return Response.json({ error: 'Failed to change role' }, { status: 500 });
  }
}
