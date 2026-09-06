/**
 * Counting failed authentication attempts, so guessing has a cost.
 *
 * Login and signup had no limit at all: a password could be guessed as fast
 * as the network allowed, against bcrypt at cost 10. Serverless has no shared
 * memory to count in, so the counter lives in the database — the same shape
 * the demo endpoint already used for its per-IP session cap.
 *
 * Two limits, and they are not equally strong:
 *
 *   - **By email.** The primary defence. An attacker guessing one account's
 *     password cannot avoid naming that account, so this budget is one they
 *     have to spend.
 *   - **By IP.** Secondary, and honestly weaker: `x-forwarded-for` is a
 *     request header, so a client can set it. Behind a proxy that overwrites
 *     it (Vercel does) it is trustworthy; run directly, it is advisory. It
 *     raises the cost of spraying many accounts from one host without being
 *     the thing standing between an attacker and one account.
 */

import { createHash } from 'crypto';
import { executeSql } from './db.js';

/** Failures allowed before the door closes, and for how long. */
export const LOGIN_FAILURES_PER_EMAIL = 8;
export const LOGIN_FAILURES_PER_IP = 30;
export const SIGNUPS_PER_IP = 10;
export const WINDOW_MINUTES = 15;

const pepper = process.env.JWT_SECRET ?? '';

/**
 * What gets stored instead of the email or the IP.
 *
 * SHA-256 over the value with the deployment's own secret mixed in. Without
 * the pepper an IP hash is worthless as anonymisation — the whole IPv4 space
 * is four billion guesses, which is seconds of work — and an email hash is a
 * dictionary lookup. This is a rate-limit key, not a credential, but it is
 * still a record of who tried to log in and when, on a platform holding
 * children's data.
 */
export function rateLimitKey(value: string): string {
  return createHash('sha256').update(`${pepper}:${value.trim().toLowerCase()}`).digest('hex');
}

/**
 * The caller's address, as far as it can be known.
 *
 * `x-real-ip` is set by the proxy and cannot be spoofed past it;
 * `x-forwarded-for`'s leftmost entry is the conventional client address but
 * is client-supplied. Preferring the former means the limit holds wherever a
 * proxy sets it, and degrades to advisory rather than to nothing where none
 * does.
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get('x-real-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

export type AttemptScope = 'login' | 'signup';
export type AttemptKind = 'email' | 'ip';

export async function recordAttempt(
  scope: AttemptScope,
  kind: AttemptKind,
  value: string
): Promise<void> {
  await executeSql(
    'INSERT INTO auth_attempts (scope, kind, identifier) VALUES ($1, $2, $3)',
    [scope, kind, rateLimitKey(value)]
  );
}

/** How many failures this identifier has accumulated inside the window. */
export async function attemptsInWindow(
  scope: AttemptScope,
  kind: AttemptKind,
  value: string
): Promise<number> {
  const result = await executeSql<{ total: number }>(
    `SELECT COUNT(*) AS total FROM auth_attempts
     WHERE scope = $1 AND kind = $2 AND identifier = $3
       AND created_at > datetime('now', $4)`,
    [scope, kind, rateLimitKey(value), `-${WINDOW_MINUTES} minutes`]
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function isRateLimited(
  scope: AttemptScope,
  kind: AttemptKind,
  value: string,
  limit: number
): Promise<boolean> {
  return (await attemptsInWindow(scope, kind, value)) >= limit;
}

/**
 * Forgets an identifier's failures.
 *
 * Called when a login succeeds: a learner who mistypes a password four times
 * and then gets it right should not be four failures closer to a lockout for
 * the next quarter of an hour. Only failures are ever recorded, so a busy
 * account is never rate-limited for being busy.
 */
export async function clearAttempts(
  scope: AttemptScope,
  kind: AttemptKind,
  value: string
): Promise<void> {
  await executeSql(
    'DELETE FROM auth_attempts WHERE scope = $1 AND kind = $2 AND identifier = $3',
    [scope, kind, rateLimitKey(value)]
  );
}

/** 429 with how long to wait, which is what a well-behaved client needs. */
export function tooManyAttempts(): Response {
  return Response.json(
    {
      error: 'Too many attempts. Try again later.',
      retryAfterMinutes: WINDOW_MINUTES,
    },
    { status: 429, headers: { 'Retry-After': String(WINDOW_MINUTES * 60) } }
  );
}
