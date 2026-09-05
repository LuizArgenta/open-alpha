import { describe, expect, it } from 'vitest';
import { awardXp } from '../api/_lib/xp.js';

const CONCEPT_MINUTES = 20;

function attempt(overrides: Partial<Parameters<typeof awardXp>[0]> = {}) {
  return awardXp({
    score: 100,
    focusScore: 100,
    priorAttempts: 1,
    estimatedMinutes: CONCEPT_MINUTES,
    ...overrides,
  });
}

describe('XP policy', () => {
  it('pays a concept its own size, so a long one is worth more than a short one', () => {
    expect(attempt({ estimatedMinutes: 30 }).amount).toBeGreaterThan(
      attempt({ estimatedMinutes: 10 }).amount
    );
  });

  it('pays nothing for effort without demonstrated learning', () => {
    // The whole point of the currency: it buys evidence, not time spent.
    const award = attempt({ score: 60, focusScore: 100 });
    expect(award.amount).toBe(0);
    expect(award.reason).toBe('no_mastery');
  });

  it('pays in full for mastery reached with focus', () => {
    expect(attempt()).toEqual({ amount: CONCEPT_MINUTES, reason: 'mastery_focused' });
  });

  it('adds a bonus for a clean first pass', () => {
    const bonus = attempt({ score: 100, priorAttempts: 0 });
    expect(bonus.reason).toBe('mastery_first_try');
    expect(bonus.amount).toBeGreaterThan(CONCEPT_MINUTES);
  });

  it('does not pay the first-try bonus for a pass that was not perfect', () => {
    expect(attempt({ score: 80, priorAttempts: 0 }).reason).toBe('mastery_focused');
  });

  it('pays partially for mastery reached while distracted', () => {
    const award = attempt({ focusScore: 70 });
    expect(award.reason).toBe('mastery_partial');
    expect(award.amount).toBeLessThan(CONCEPT_MINUTES);
    expect(award.amount).toBeGreaterThan(0);
  });

  it('pays least for mastery reached amid heavy waste', () => {
    expect(attempt({ focusScore: 30 }).amount).toBeLessThan(attempt({ focusScore: 70 }).amount);
  });

  it('pays nothing for a quiz that was clicked through', () => {
    const award = attempt({ score: 100, gamed: true });
    expect(award).toEqual({ amount: 0, reason: 'gaming' });
  });

  it('never goes negative', () => {
    // Deliberate divergence from the reference policy: a balance that runs
    // backwards punishes a child instead of redirecting them.
    for (const focusScore of [0, 30, 60, 100]) {
      for (const score of [0, 50, 80, 100]) {
        expect(attempt({ score, focusScore }).amount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('falls back to a default size for concepts with no estimate', () => {
    expect(attempt({ estimatedMinutes: undefined }).amount).toBeGreaterThan(0);
  });
});
