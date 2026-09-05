import { describe, expect, it } from 'vitest';
import {
  REVIEW_INTERVALS_DAYS,
  scheduleAfterLapse,
  scheduleAfterMastery,
} from '../api/_lib/review.js';

describe('spaced review ladder', () => {
  it('starts a concept with no history on the first rung', () => {
    expect(scheduleAfterMastery(null).intervalDays).toBe(REVIEW_INTERVALS_DAYS[0]);
  });

  it('widens the interval on each successive pass', () => {
    const climbed: number[] = [];
    let interval: number | null = null;

    for (let pass = 0; pass < REVIEW_INTERVALS_DAYS.length + 2; pass++) {
      interval = scheduleAfterMastery(interval).intervalDays;
      climbed.push(interval);
    }

    expect(climbed.slice(0, REVIEW_INTERVALS_DAYS.length)).toEqual(REVIEW_INTERVALS_DAYS);
  });

  it('holds at the top rung instead of growing without bound', () => {
    const top = REVIEW_INTERVALS_DAYS[REVIEW_INTERVALS_DAYS.length - 1];
    expect(scheduleAfterMastery(top).intervalDays).toBe(top);
    expect(scheduleAfterMastery(999).intervalDays).toBe(top);
  });

  it('drops back to the first rung after a lapse', () => {
    expect(scheduleAfterLapse().intervalDays).toBe(REVIEW_INTERVALS_DAYS[0]);
  });

  it('emits a SQLite datetime modifier matching the interval', () => {
    expect(scheduleAfterMastery(null).modifier).toBe('+1 days');
    expect(scheduleAfterMastery(1).modifier).toBe('+3 days');
  });
});
