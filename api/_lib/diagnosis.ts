/**
 * Why a mastery check was failed.
 *
 * A wrong answer is not one thing. Guessing through five questions in twelve
 * seconds, walking away mid-quiz, and working carefully but hitting a real gap
 * all produce the same score, and each needs a different response. Sending a
 * student who was rushing back to a prerequisite teaches them that rushing
 * costs them progress, not that they misunderstood something.
 *
 * Deterministic on purpose: this runs on every quiz submission, so it stays a
 * pure function over events already collected.
 */

/** Same threshold the waste meter uses for a rushed answer. */
const RAPID_ANSWER_MS = 3000;
/** A gap this long between two answers means the student left the quiz. */
const WALKED_AWAY_MS = 5 * 60 * 1000;
const MOSTLY_WRONG = 0.5;
const MOSTLY_RAPID = 0.5;

export type ErrorPattern =
  | 'rapid_guessing'
  | 'distraction'
  | 'conceptual_gap'
  | 'high_difficulty'
  | 'inconclusive';

export interface AnswerEvent {
  correct: boolean;
  responseTimeMs?: number;
  /** SQLite timestamp of the answer. */
  at: string;
}

export interface QuizAttemptSignals {
  answers: AnswerEvent[];
  /** How many times this concept was attempted before this quiz. */
  priorAttempts: number;
}

export interface Diagnosis {
  pattern: ErrorPattern;
  /**
   * True when the failure is about attention rather than knowledge. Prerequisite
   * remediation is the wrong response to these — the score doesn't yet say
   * anything about what the student understands.
   */
  isAttention: boolean;
  /** Set only for attention patterns, where no remediation message applies. */
  message?: string;
}

function countLongGaps(answers: AnswerEvent[]): number {
  let gaps = 0;
  for (let i = 1; i < answers.length; i++) {
    const previous = new Date(answers[i - 1].at).getTime();
    const current = new Date(answers[i].at).getTime();
    if (current - previous >= WALKED_AWAY_MS) gaps++;
  }
  return gaps;
}

export function diagnoseAttempt({ answers, priorAttempts }: QuizAttemptSignals): Diagnosis {
  if (answers.length === 0) {
    return { pattern: 'inconclusive', isAttention: false };
  }

  const rapid = answers.filter(
    answer => answer.responseTimeMs !== undefined && answer.responseTimeMs < RAPID_ANSWER_MS
  ).length;
  const wrong = answers.filter(answer => !answer.correct).length;
  const wrongRatio = wrong / answers.length;

  if (rapid / answers.length >= MOSTLY_RAPID) {
    return {
      pattern: 'rapid_guessing',
      isAttention: true,
      message: `You answered ${rapid} of ${answers.length} questions in under ${RAPID_ANSWER_MS / 1000} seconds. Slow down and read each one — this score doesn't tell us what you actually know yet.`,
    };
  }

  if (countLongGaps(answers) > 0) {
    return {
      pattern: 'distraction',
      isAttention: true,
      message: "Looks like you stepped away in the middle of this quiz. Try it again in one sitting so the result reflects what you know.",
    };
  }

  if (wrongRatio < MOSTLY_WRONG) {
    return { pattern: 'inconclusive', isAttention: false };
  }

  // Worked at a deliberate pace and still missed most of it. A second failure
  // points at a gap underneath this concept; a first one may just be hard.
  return {
    pattern: priorAttempts >= 1 ? 'conceptual_gap' : 'high_difficulty',
    isAttention: false,
  };
}
