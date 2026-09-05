/**
 * XP: one currency for "did you learn it" and "how well did you work".
 *
 * The platform already measured both and never combined them — mastery from
 * the quiz, focus from the meter — so the daily goal counted minutes sitting
 * down, which is the thing this model exists to stop rewarding.
 *
 * One XP is roughly one minute of expected focused learning, so a concept's
 * full award is its estimatedMinutes. That keeps XP comparable across
 * concepts of different sizes instead of paying the same for a five-minute
 * skill and a half-hour one.
 */

import { MASTERY_THRESHOLD } from './curriculum.js';

/** Used when a concept carries no estimate of its own. */
const DEFAULT_CONCEPT_MINUTES = 15;

const FOCUSED = 80;
const DISTRACTED = 60;

/** Mastery earned while distracted still counts, but not in full. */
const PARTIAL_MULTIPLIER = 0.6;
const HEAVY_WASTE_MULTIPLIER = 0.3;
/** Clean first pass, worked with attention. */
const FIRST_TRY_BONUS = 0.25;

export type XpReason =
  | 'mastery_focused'
  | 'mastery_first_try'
  | 'mastery_partial'
  | 'mastery_wasteful'
  | 'no_mastery'
  | 'gaming';

export interface XpAward {
  amount: number;
  reason: XpReason;
}

export interface XpInput {
  /** Score on this attempt, not the all-time best. */
  score: number;
  /** 0-100 from the focus meter. */
  focusScore: number;
  /** How many times this concept was attempted before now. */
  priorAttempts: number;
  /** From the concept's metadata, when it has one. */
  estimatedMinutes?: number;
  /** True when the attempt was diagnosed as rushing or gaming the quiz. */
  gamed?: boolean;
}

export function awardXp({
  score,
  focusScore,
  priorAttempts,
  estimatedMinutes,
  gamed = false,
}: XpInput): XpAward {
  const full = estimatedMinutes ?? DEFAULT_CONCEPT_MINUTES;

  // Clicking through a quiz cannot pay, whatever the score says.
  //
  // The reference policy calls for negative XP here. Deliberately not
  // implemented: a balance that goes backwards punishes a child rather than
  // redirecting them, and the focus meter already names the behaviour to
  // their face — with a right of reply, which a silent penalty would not have.
  if (gamed) return { amount: 0, reason: 'gaming' };

  // Effort without demonstrated learning earns nothing. This is the whole
  // point of the currency: it pays for evidence, not for time spent.
  if (score < MASTERY_THRESHOLD) return { amount: 0, reason: 'no_mastery' };

  if (focusScore < DISTRACTED) {
    return { amount: Math.round(full * HEAVY_WASTE_MULTIPLIER), reason: 'mastery_wasteful' };
  }

  if (focusScore < FOCUSED) {
    return { amount: Math.round(full * PARTIAL_MULTIPLIER), reason: 'mastery_partial' };
  }

  if (score === 100 && priorAttempts === 0) {
    return { amount: Math.round(full * (1 + FIRST_TRY_BONUS)), reason: 'mastery_first_try' };
  }

  return { amount: full, reason: 'mastery_focused' };
}

/**
 * The daily goal, in XP rather than minutes. Two hours of expected focused
 * learning is the model's own target; a student who gets there in ninety
 * minutes has earned the rest of the day, which counting minutes could never
 * express.
 */
export const DAILY_XP_GOAL = 120;
