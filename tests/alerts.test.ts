import { describe, expect, it } from 'vitest';
import { type AlertProgressRow, buildAlerts } from '../api/_lib/alerts.js';

const NOW = new Date('2026-09-05T12:00:00Z');
const ACTIVE_TODAY = '2026-09-05T11:00:00Z';

function row(overrides: Partial<AlertProgressRow> = {}): AlertProgressRow {
  return {
    subject: 'math',
    subjectName: 'Mathematics',
    conceptId: 'math-fractions-intro',
    conceptName: 'Introduction to Fractions',
    masteryScore: 100,
    attempts: 1,
    nextReviewAt: null,
    reviewIntervalDays: null,
    ...overrides,
  };
}

function codes(alerts: ReturnType<typeof buildAlerts>) {
  return alerts.map(alert => alert.code);
}

describe('buildAlerts', () => {
  it('says nothing about a student who is on track', () => {
    // A dashboard that always shows something red stops being read.
    const alerts = buildAlerts(
      [row({ nextReviewAt: '2026-09-20 10:00:00', reviewIntervalDays: 16 })],
      ACTIVE_TODAY,
      NOW
    );

    expect(alerts).toEqual([]);
  });

  it('flags a concept the student is stuck on', () => {
    const alerts = buildAlerts(
      [row({ conceptName: 'Decimals', masteryScore: 40, attempts: 4 })],
      ACTIVE_TODAY,
      NOW
    );

    expect(codes(alerts)).toEqual(['stuck']);
    expect(alerts[0].severity).toBe('high');
    expect(alerts[0].detailKey).toBe('alert.stuck.detail');
    expect(alerts[0].detailParams).toMatchObject({ attempts: 4, score: 40 });
    expect(alerts[0].conceptName).toBe('Decimals');
  });

  it('does not flag a concept that has only been attempted twice', () => {
    const alerts = buildAlerts([row({ masteryScore: 40, attempts: 2 })], ACTIVE_TODAY, NOW);
    expect(codes(alerts)).not.toContain('stuck');
  });

  it('flags a mastered concept knocked back to the first review rung', () => {
    // mastery_score never regresses, so the reset ladder is the only trace a
    // forgotten concept leaves.
    const alerts = buildAlerts(
      [row({ masteryScore: 100, attempts: 3, reviewIntervalDays: 1, nextReviewAt: '2026-09-06 10:00:00' })],
      ACTIVE_TODAY,
      NOW
    );

    expect(codes(alerts)).toEqual(['retention_drop']);
  });

  it('groups overdue reviews into one alert naming the oldest', () => {
    const alerts = buildAlerts(
      [
        row({ conceptId: 'a', conceptName: 'Place Value', nextReviewAt: '2026-08-30 10:00:00' }),
        row({ conceptId: 'b', conceptName: 'Division', nextReviewAt: '2026-09-04 10:00:00' }),
        row({ conceptId: 'c', conceptName: 'Ratios', nextReviewAt: '2026-09-05 09:00:00' }),
      ],
      ACTIVE_TODAY,
      NOW
    );

    const overdue = alerts.find(alert => alert.code === 'reviews_overdue');
    // The server picks the plural variant; the client only fills the values.
    expect(overdue?.titleKey).toBe('alert.reviewsOverdue.title_plural');
    expect(overdue?.titleParams).toMatchObject({ count: 3 });
    expect(overdue?.detailParams).toMatchObject({ concept: 'Place Value' });
  });

  it('leaves reviews that are not due yet alone', () => {
    const alerts = buildAlerts(
      [row({ nextReviewAt: '2026-09-09 10:00:00', reviewIntervalDays: 7 })],
      ACTIVE_TODAY,
      NOW
    );

    expect(codes(alerts)).not.toContain('reviews_overdue');
  });

  it('flags a week without activity', () => {
    const alerts = buildAlerts([row()], '2026-08-26 10:00:00', NOW);

    const inactive = alerts.find(alert => alert.code === 'inactive');
    expect(inactive?.titleKey).toBe('alert.inactive.title');
    expect(inactive?.titleParams).toMatchObject({ days: 10 });
  });

  it('distinguishes never started from gone quiet', () => {
    const alerts = buildAlerts([], null, NOW);

    expect(codes(alerts)).toEqual(['inactive']);
    expect(alerts[0].titleKey).toBe('alert.neverStarted.title');
  });

  it('puts the most severe alert first', () => {
    const alerts = buildAlerts(
      [
        row({ conceptId: 'stuck-one', masteryScore: 30, attempts: 5 }),
        row({ conceptId: 'overdue-one', nextReviewAt: '2026-09-01 10:00:00' }),
      ],
      ACTIVE_TODAY,
      NOW
    );

    expect(alerts[0].code).toBe('stuck');
  });
});
