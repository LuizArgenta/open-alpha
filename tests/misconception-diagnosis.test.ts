/**
 * Telling "three wrong" apart from "three wrong for one reason".
 *
 * Until now `diagnoseAttempt` received exactly {correct, responseTimeMs, at}.
 * A student who missed three questions because they compare numerators without
 * looking at denominators, and a student who missed three unrelated questions,
 * produced the identical diagnosis — and therefore the identical response.
 *
 * The second student needs practice. The first needs one idea corrected, and
 * saying so is the difference between a score and a teachable observation.
 */

import { describe, expect, it } from 'vitest';
import { type AnswerEvent, diagnoseAttempt } from '../api/_lib/diagnosis.js';

const RAPID_MS = 5_000;
const CONSIDERED = 30_000;

function answer(overrides: Partial<AnswerEvent> = {}): AnswerEvent {
  return {
    correct: false,
    responseTimeMs: CONSIDERED,
    at: '2026-09-06 10:00:00',
    ...overrides,
  };
}

function diagnose(answers: AnswerEvent[], priorAttempts = 0) {
  return diagnoseAttempt({ answers, priorAttempts, rapidThresholdMs: RAPID_MS });
}

describe('a misunderstanding that repeats', () => {
  it('is named, with the cause and how often it appeared', () => {
    const diagnosis = diagnose([
      answer({ correct: true }),
      answer({ errorCode: 'compares_numerator_only' }),
      answer({ errorCode: 'compares_numerator_only' }),
      answer({ errorCode: 'compares_numerator_only' }),
      answer({ correct: true }),
    ]);

    expect(diagnosis.pattern).toBe('recurring_misconception');
    expect(diagnosis.misconception).toEqual({ code: 'compares_numerator_only', count: 3 });
    // A knowledge signal, so remediation is the right response — unlike the
    // attention patterns, where sending someone to a prerequisite answers a
    // question they were not asking.
    expect(diagnosis.isAttention).toBe(false);
  });

  it('is not claimed for three unrelated mistakes', () => {
    const diagnosis = diagnose([
      answer({ errorCode: 'compares_numerator_only' }),
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'misreads_place_value' }),
      answer({ correct: true }),
      answer({ correct: true }),
    ]);

    // The case this whole item exists to distinguish. Same score, same
    // response times, different diagnosis.
    expect(diagnosis.pattern).not.toBe('recurring_misconception');
    expect(diagnosis.misconception).toBeUndefined();
  });

  it('needs two, because one mistake is an accident', () => {
    const diagnosis = diagnose([
      answer({ errorCode: 'compares_numerator_only' }),
      answer({ correct: true }),
      answer({ correct: true }),
      answer({ correct: true }),
      answer({ correct: true }),
    ]);
    expect(diagnosis.misconception).toBeUndefined();
  });

  it('is found even when most of the quiz went right', () => {
    // Three of five correct would otherwise be "inconclusive" — the ratio gate
    // would hide a cause worth naming.
    const diagnosis = diagnose([
      answer({ correct: true }),
      answer({ correct: true }),
      answer({ correct: true }),
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'ignores_remainder' }),
    ]);

    expect(diagnosis.pattern).toBe('recurring_misconception');
    expect(diagnosis.misconception?.count).toBe(2);
  });

  it('reports the dominant cause when two repeat', () => {
    const diagnosis = diagnose([
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'misreads_place_value' }),
      answer({ errorCode: 'misreads_place_value' }),
    ]);
    expect(diagnosis.misconception).toEqual({ code: 'ignores_remainder', count: 3 });
  });
});

describe('what a guess is worth as evidence', () => {
  it('ignores codes from answers given too fast to be beliefs', () => {
    // Someone clicking through in two seconds picked an option; they did not
    // hold a misconception. Counting it would manufacture one out of a guess,
    // and prescribe a lesson for inattention.
    const diagnosis = diagnose([
      answer({ errorCode: 'compares_numerator_only', responseTimeMs: 900 }),
      answer({ errorCode: 'compares_numerator_only', responseTimeMs: 800 }),
      answer({ errorCode: 'compares_numerator_only', responseTimeMs: 700 }),
      answer({ correct: true, responseTimeMs: 600 }),
      answer({ correct: true, responseTimeMs: 500 }),
    ]);

    expect(diagnosis.pattern).toBe('rapid_guessing');
    expect(diagnosis.misconception).toBeUndefined();
  });

  it('still counts considered answers when only some were rushed', () => {
    const diagnosis = diagnose([
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'ignores_remainder' }),
      answer({ errorCode: 'ignores_remainder', responseTimeMs: 400 }),
      answer({ correct: true }),
      answer({ correct: true }),
    ]);

    // Two considered, one rushed: the rushed one does not inflate the count.
    expect(diagnosis.misconception).toEqual({ code: 'ignores_remainder', count: 2 });
  });
});

describe('items with no metadata, which is most of them', () => {
  it('diagnoses exactly as before', () => {
    const answers = [
      answer(), answer(), answer(), answer(), answer({ correct: true }),
    ];
    const diagnosis = diagnose(answers, 1);

    // No error codes recorded: absence means "not recorded", never "no shared
    // cause", so the old conclusion stands untouched.
    expect(diagnosis.pattern).toBe('conceptual_gap');
    expect(diagnosis.misconception).toBeUndefined();
  });
});
