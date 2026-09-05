import jwt from 'jsonwebtoken';

// No fallback on purpose: a default secret in production lets anyone mint a valid
// token for any user, including another family's child account.
const configuredSecret = process.env.JWT_SECRET;
if (!configuredSecret) {
  throw new Error('JWT_SECRET is not set. Set it in the environment before serving requests.');
}
const JWT_SECRET: string = configuredSecret;

export interface AuthPayload {
  userId: number;
  role: 'student' | 'parent';
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

export function getAuthFromRequest(request: Request): AuthPayload | null {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.substring(7);
  return verifyToken(token);
}

export function unauthorized(): Response {
  return Response.json({ error: 'Not authenticated' }, { status: 401 });
}

export function forbidden(): Response {
  return Response.json({ error: 'Not authorized' }, { status: 403 });
}
