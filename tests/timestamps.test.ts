/**
 * The database writes UTC; JavaScript was reading local.
 *
 * SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS`, a form with no
 * timezone marker, and `new Date()` reads that shape as local time. On a
 * server in Brazil that is a three-hour error on every stored timestamp.
 *
 * It hid because two stored timestamps compared against each other are shifted
 * by the same amount and the offset cancels — so the diagnosis, which measures
 * gaps between answers, was never wrong. It surfaces only where a stored
 * timestamp meets real time, and there it changes what the system decides: a
 * review comes due early, an inactivity alert counts a day short.
 *
 * These tests run the arithmetic under a non-UTC timezone on purpose. Run in
 * UTC only, the bug is invisible — which is exactly how it survived.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daysSince, parseDbTimestamp } from '../api/_lib/time.js';
import { buildAlerts } from '../api/_lib/alerts.js';

const ORIGINAL_TZ = process.env.TZ;

// UTC-3, the timezone of the server this is being deployed to.
beforeAll(() => { process.env.TZ = 'America/Recife'; });
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

describe('parsing what the database stored', () => {
  it('reads a bare SQLite timestamp as UTC, not as local time', () => {
    expect(parseDbTimestamp('2026-08-26 10:00:00').toISOString())
      .toBe('2026-08-26T10:00:00.000Z');
  });

  it('trusts a string that carries its own offset', () => {
    // A caller that went to the trouble of writing one means it.
    expect(parseDbTimestamp('2026-08-26T10:00:00Z').toISOString())
      .toBe('2026-08-26T10:00:00.000Z');
    expect(parseDbTimestamp('2026-08-26T07:00:00-03:00').toISOString())
      .toBe('2026-08-26T10:00:00.000Z');
  });

  it('counts whole days without losing one to the offset', () => {
    const now = new Date('2026-09-05T10:00:00Z');
    // Ten days to the minute. Read as local time this came out as nine, and
    // the learner was told they had been away a day less than they had.
    expect(daysSince('2026-08-26 10:00:00', now)).toBe(10);
  });
});

describe('decisions that compare stored time against real time', () => {
  function rowDueAt(nextReviewAt: string) {
    return [{
      subject: 'math',
      subjectName: 'Mathematics',
      conceptId: 'math-fractions-intro',
      conceptName: 'Fractions',
      masteryScore: 90,
      attempts: 1,
      nextReviewAt,
      reviewIntervalDays: 7,
    }];
  }

  const ACTIVE_TODAY = '2026-09-05 00:00:00';

  it('does not bring a review due before it is due', () => {
    // Due three hours from now. Read as local time on a UTC-3 server, this
    // looked like it had been due for three hours already.
    const alerts = buildAlerts(
      rowDueAt('2026-09-05 03:00:00'),
      ACTIVE_TODAY,
      new Date('2026-09-05T00:00:00Z')
    );

    expect(alerts.find(alert => alert.code === 'reviews_overdue')).toBeUndefined();
  });

  it('does bring it due once it actually is', () => {
    const alerts = buildAlerts(
      rowDueAt('2026-09-05 03:00:00'),
      ACTIVE_TODAY,
      new Date('2026-09-05T04:00:00Z')
    );

    expect(alerts.find(alert => alert.code === 'reviews_overdue')).toBeDefined();
  });

  it('counts the days a learner has been away without losing one', () => {
    const alerts = buildAlerts(
      [],
      '2026-08-26 10:00:00',
      new Date('2026-09-05T10:00:00Z')
    );

    const inactive = alerts.find(alert => alert.code === 'inactive');
    // Ten days to the minute. The local-time read reported nine.
    expect(inactive?.titleParams).toMatchObject({ days: 10 });
  });
});
