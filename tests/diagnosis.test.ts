import { describe, expect, it } from 'vitest';
import {
  type AnswerEvent,
  diagnoseAttempt,
  rapidAnswerThresholdMs,
} from '../api/_lib/diagnosis.js';

const STANDARD_THRESHOLD = rapidAnswerThresholdMs('standard');

/** Five answers, evenly spaced, at the given pace. */
function answers(
  count: number,
  { responseTimeMs, correct = false, gapSeconds = 20 }: {
    responseTimeMs: number;
    correct?: boolean;
    gapSeconds?: number;
  }
): AnswerEvent[] {
  const start = new Date('2026-09-05T10:00:00Z').getTime();
  return Array.from({ length: count }, (_, index) => ({
    correct,
    responseTimeMs,
    at: new Date(start + index * gapSeconds * 1000).toISOString(),
  }));
}

describe('rapidAnswerThresholdMs', () => {
  it('scales with difficulty so one pace does not judge every question', () => {
    expect(rapidAnswerThresholdMs('foundational')).toBeLessThan(STANDARD_THRESHOLD);
    expect(rapidAnswerThresholdMs('advanced')).toBeGreaterThan(STANDARD_THRESHOLD);
  });

  it('falls back to the standard threshold for concepts with no difficulty set', () => {
    expect(rapidAnswerThresholdMs(undefined)).toBe(STANDARD_THRESHOLD);
  });
});

describe('diagnoseAttempt', () => {
  it('calls rushing an attention problem, not a knowledge gap', () => {
    const diagnosis = diagnoseAttempt({
      answers: answers(5, { responseTimeMs: 1200 }),
      priorAttempts: 0,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });

    expect(diagnosis.pattern).toBe('rapid_guessing');
    expect(diagnosis.isAttention).toBe(true);
    expect(diagnosis.messageKey).toBe('diagnosis.rapidGuessing');
    expect(diagnosis.messageParams).toMatchObject({ rapid: 5, total: 5 });
  });

  it('reads a long break mid-quiz as distraction', () => {
    const walkedAway = answers(3, { responseTimeMs: 20000 });
    walkedAway[2] = {
      ...walkedAway[2],
      at: new Date(new Date(walkedAway[1].at).getTime() + 6 * 60 * 1000).toISOString(),
    };

    const diagnosis = diagnoseAttempt({
      answers: walkedAway,
      priorAttempts: 0,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });

    expect(diagnosis.pattern).toBe('distraction');
    expect(diagnosis.isAttention).toBe(true);
  });

  it('treats a careful first failure as a hard concept', () => {
    const diagnosis = diagnoseAttempt({
      answers: answers(5, { responseTimeMs: 25000 }),
      priorAttempts: 0,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });

    expect(diagnosis.pattern).toBe('high_difficulty');
    expect(diagnosis.isAttention).toBe(false);
  });

  it('treats the same attempt as a conceptual gap once it has failed before', () => {
    const sameAnswers = answers(5, { responseTimeMs: 25000 });

    const first = diagnoseAttempt({
      answers: sameAnswers,
      priorAttempts: 0,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });
    const second = diagnoseAttempt({
      answers: sameAnswers,
      priorAttempts: 1,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });

    expect(first.pattern).toBe('high_difficulty');
    expect(second.pattern).toBe('conceptual_gap');
  });

  it('stays inconclusive when most answers were right', () => {
    const diagnosis = diagnoseAttempt({
      answers: answers(5, { responseTimeMs: 25000, correct: true }),
      priorAttempts: 0,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });

    expect(diagnosis.pattern).toBe('inconclusive');
  });

  it('has nothing to say without answers', () => {
    const diagnosis = diagnoseAttempt({
      answers: [],
      priorAttempts: 3,
      rapidThresholdMs: STANDARD_THRESHOLD,
    });

    expect(diagnosis.pattern).toBe('inconclusive');
    expect(diagnosis.isAttention).toBe(false);
  });

  it('judges the same answers differently on a foundational concept', () => {
    const quick = answers(5, { responseTimeMs: 2500 });

    const onStandard = diagnoseAttempt({
      answers: quick,
      priorAttempts: 0,
      rapidThresholdMs: rapidAnswerThresholdMs('standard'),
    });
    const onFoundational = diagnoseAttempt({
      answers: quick,
      priorAttempts: 0,
      rapidThresholdMs: rapidAnswerThresholdMs('foundational'),
    });

    expect(onStandard.pattern).toBe('rapid_guessing');
    expect(onFoundational.pattern).not.toBe('rapid_guessing');
  });
});
