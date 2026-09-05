/**
 * Spaced review scheduling.
 *
 * Mastering a concept once says the student could do it today, not that they
 * will still be able to next month. A Leitner-style ladder brings each concept
 * back at a widening interval, and a lapse drops it back to the first rung.
 */

export const REVIEW_INTERVALS_DAYS = [1, 3, 7, 16, 35];

export interface ReviewSchedule {
  intervalDays: number;
  /** SQLite datetime modifier, e.g. '+3 days'. */
  modifier: string;
}

function toSchedule(intervalDays: number): ReviewSchedule {
  return { intervalDays, modifier: `+${intervalDays} days` };
}

/** The rung after the one the concept is currently on. */
export function scheduleAfterMastery(currentIntervalDays: number | null): ReviewSchedule {
  if (!currentIntervalDays) return toSchedule(REVIEW_INTERVALS_DAYS[0]);

  const currentRung = REVIEW_INTERVALS_DAYS.findIndex(days => days >= currentIntervalDays);
  const nextRung = currentRung === -1
    ? REVIEW_INTERVALS_DAYS.length - 1
    : Math.min(currentRung + 1, REVIEW_INTERVALS_DAYS.length - 1);

  return toSchedule(REVIEW_INTERVALS_DAYS[nextRung]);
}

/** Back to the first rung: a concept that decayed needs to be seen again soon. */
export function scheduleAfterLapse(): ReviewSchedule {
  return toSchedule(REVIEW_INTERVALS_DAYS[0]);
}
