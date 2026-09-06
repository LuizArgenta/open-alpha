/**
 * Login and signup had no limit at all: a password could be guessed as fast
 * as the network allowed. Nothing in the suite touched either endpoint, so
 * this covers the boundary as well as the new limit.
 *
 * The enumeration half matters for the same reason the rest of this codebase
 * cares about identifiers: these accounts belong to children, and "does this
 * address have an account here" is not a question a stranger should be able
 * to answer by timing a response.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { executeSql } from '../api/_lib/db.js';
import { POST as login } from '../api/auth/login.js';
import { POST as signup } from '../api/auth/signup.js';
import {
  LOGIN_FAILURES_PER_EMAIL,
  SIGNUPS_PER_IP,
  rateLimitKey,
} from '../api/_lib/rate-limit.js';
import { resetDatabase } from './helpers/database.js';

const EMAIL = 'learner@example.test';
const PASSWORD = 'correct horse battery staple';

function post(body: unknown, ip = '203.0.113.10'): Request {
  return new Request('https://test.local/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify(body),
  });
}

async function createAccount(): Promise<number> {
  const result = await executeSql<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, grade_level)
     VALUES ($1, $2, 'student', 4) RETURNING id`,
    [EMAIL, await bcrypt.hash(PASSWORD, 10)]
  );
  return result.rows[0].id;
}

async function failLogin(times: number, ip?: string): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await login(post({ email: EMAIL, password: 'wrong' }, ip));
  }
}

beforeEach(async () => {
  await resetDatabase();
});

describe('login rate limiting', () => {
  it('lets a correct password through', async () => {
    await createAccount();
    const response = await login(post({ email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(200);
  });

  it('refuses further attempts once the per-email budget is spent', async () => {
    await createAccount();
    await failLogin(LOGIN_FAILURES_PER_EMAIL);

    const response = await login(post({ email: EMAIL, password: 'wrong' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
  });

  it('refuses the correct password too, once locked out', async () => {
    // Otherwise the lockout is trivially bypassed by the one guess that
    // matters, and it also stops the response from confirming a hit.
    await createAccount();
    await failLogin(LOGIN_FAILURES_PER_EMAIL);

    const response = await login(post({ email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(429);
  });

  it('follows the email, not the address it was tried from', async () => {
    await createAccount();
    await failLogin(LOGIN_FAILURES_PER_EMAIL, '198.51.100.1');

    const fromElsewhere = await login(post({ email: EMAIL, password: 'wrong' }, '198.51.100.99'));
    expect(fromElsewhere.status).toBe(429);
  });

  it('forgets the failures once the learner gets in', async () => {
    await createAccount();
    await failLogin(LOGIN_FAILURES_PER_EMAIL - 1);

    expect((await login(post({ email: EMAIL, password: PASSWORD }))).status).toBe(200);

    // Back to a full budget: mistyping and then remembering must not leave
    // someone one failure from a lockout.
    await failLogin(LOGIN_FAILURES_PER_EMAIL - 1);
    expect((await login(post({ email: EMAIL, password: PASSWORD }))).status).toBe(200);
  });

  it('does not spend one account\'s budget on another\'s failures', async () => {
    await createAccount();
    for (let attempt = 0; attempt < LOGIN_FAILURES_PER_EMAIL; attempt += 1) {
      await login(post({ email: 'someone-else@example.test', password: 'wrong' }));
    }

    const response = await login(post({ email: EMAIL, password: PASSWORD }));
    expect(response.status).toBe(200);
  });

  it('counts only failures, so a busy account is never locked out', async () => {
    await createAccount();
    for (let attempt = 0; attempt < LOGIN_FAILURES_PER_EMAIL * 2; attempt += 1) {
      expect((await login(post({ email: EMAIL, password: PASSWORD }))).status).toBe(200);
    }
  });
});

describe('login does not reveal which addresses have accounts', () => {
  it('answers the same for an unknown address and a wrong password', async () => {
    await createAccount();

    const unknown = await login(post({ email: 'nobody@example.test', password: 'wrong' }));
    const wrong = await login(post({ email: EMAIL, password: 'wrong' }));

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('does the same password work either way', async () => {
    // The message was already identical; the timing was not, because an
    // unknown address returned before any comparison. Both paths now compare
    // a real bcrypt hash, so neither answers in a millisecond while the other
    // spends a hundred.
    await createAccount();

    const timeOf = async (email: string): Promise<number> => {
      const started = performance.now();
      await login(post({ email, password: 'wrong' }));
      return performance.now() - started;
    };

    // Warm bcrypt so the first call's cost does not distort the comparison.
    await timeOf(EMAIL);

    const known = await timeOf(EMAIL);
    const unknown = await timeOf('nobody-here@example.test');

    // Generous on purpose: this asserts the same order of magnitude, which is
    // what closes the oracle. Anything tighter would be a flaky test about
    // the machine rather than about the code.
    expect(unknown).toBeGreaterThan(known / 4);
  });
});

describe('signup rate limiting', () => {
  const signupBody = (email: string) => ({
    email,
    password: PASSWORD,
    role: 'student' as const,
    gradeLevel: 4,
  });

  it('accepts a first signup', async () => {
    const response = await signup(post(signupBody('new@example.test')));
    expect(response.status).toBe(201);
  });

  it('caps how many addresses one host can test', async () => {
    for (let attempt = 0; attempt < SIGNUPS_PER_IP; attempt += 1) {
      await signup(post(signupBody(`probe-${attempt}@example.test`)));
    }

    const response = await signup(post(signupBody('one-more@example.test')));
    expect(response.status).toBe(429);
  });
});

describe('rate-limit keys', () => {
  it('never stores the email or the address itself', async () => {
    await createAccount();
    await failLogin(1, '203.0.113.77');

    const stored = await executeSql<{ identifier: string }>(
      'SELECT identifier FROM auth_attempts'
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) {
      expect(row.identifier).not.toContain(EMAIL);
      expect(row.identifier).not.toContain('203.0.113.77');
      expect(row.identifier).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is stable for one value and different across values', async () => {
    expect(rateLimitKey('a@example.test')).toBe(rateLimitKey('a@example.test'));
    expect(rateLimitKey('a@example.test')).not.toBe(rateLimitKey('b@example.test'));
  });

  it('ignores case and surrounding space, so one address is one budget', async () => {
    expect(rateLimitKey(' A@Example.test ')).toBe(rateLimitKey('a@example.test'));
  });
});
