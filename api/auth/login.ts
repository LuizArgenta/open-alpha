import bcrypt from 'bcryptjs';
import { executeSql } from '../_lib/db.js';
import { signToken } from '../_lib/auth.js';
import {
  LOGIN_FAILURES_PER_EMAIL,
  LOGIN_FAILURES_PER_IP,
  clearAttempts,
  clientIp,
  isRateLimited,
  recordAttempt,
  tooManyAttempts,
} from '../_lib/rate-limit.js';

interface User {
  id: number;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: 'student' | 'parent';
  grade_level: number | null;
}

/**
 * A real bcrypt hash at the same cost as a stored one, compared against when
 * no account matches.
 *
 * The message for an unknown email and a wrong password was already the same,
 * but the timing was not: returning before any comparison answered in a
 * millisecond, while a real account spent bcrypt's hundred. That difference
 * is a reliable oracle for whether an address has an account here — which,
 * for a platform whose accounts belong to children, is not a detail.
 *
 * Not a credential: it is the hash of a fixed sentence, and nothing accepts
 * it as a password because no user row holds it.
 */
const TIMING_EQUALISER = '$2a$10$JWGlQpxxb4zpeACkJnci0Ouwe3ZWJQS99YlxAtNk7XR2bFqPWP1tS';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email: string; password: string };
    const { email, password } = body;

    if (!email || !password) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const ip = clientIp(request);

    // Checked before the password is looked at, so a locked-out attacker
    // learns nothing from the answer either.
    if (
      await isRateLimited('login', 'email', email, LOGIN_FAILURES_PER_EMAIL) ||
      await isRateLimited('login', 'ip', ip, LOGIN_FAILURES_PER_IP)
    ) {
      return tooManyAttempts();
    }

    const result = await executeSql<User>(
      'SELECT id, email, password_hash, display_name, role, grade_level FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];
    // Always compare something, so the work done does not depend on whether
    // the account exists.
    const validPassword = await bcrypt.compare(
      password,
      user?.password_hash ?? TIMING_EQUALISER
    );

    if (!user || !validPassword) {
      await recordAttempt('login', 'email', email);
      await recordAttempt('login', 'ip', ip);
      return Response.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    // Getting in clears the account's budget: mistyping a password four times
    // and then remembering it should not leave a learner four failures from a
    // lockout for the rest of the window.
    await clearAttempts('login', 'email', email);

    const token = signToken({ userId: user.id, role: user.role });

    return Response.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        gradeLevel: user.grade_level,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return Response.json({ error: 'Failed to log in' }, { status: 500 });
  }
}
