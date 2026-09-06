import { createHash } from 'crypto';

export const ITEMS_PER_MASTERY_ATTEMPT = 5;

export type ItemDifficulty = 'easy' | 'medium' | 'hard';
export type ItemPurpose = 'practice' | 'check' | 'mastery' | 'review';

export interface ItemBankQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  difficultyTag?: ItemDifficulty;
  purpose?: ItemPurpose;
  skillTag?: string;
  reasoningType?: string;
  distractorRationale?: Record<string, string>;
  distractorErrorCode?: Record<string, string>;
  pedagogicalRationale?: string;
}

export interface ItemSnapshot {
  difficultyTag: ItemDifficulty;
  purpose: ItemPurpose;
  skillTag: string | null;
  reasoningType: string | null;
  distractorRationale: Record<string, string>;
  distractorErrorCode: Record<string, string>;
  pedagogicalRationale: string | null;
  contentHash: string;
}

/**
 * The canonical immutable identity of an item. Metadata that changes how an
 * educator interprets an answer belongs in the hash just as much as the stem.
 */
export function snapshotItem(question: ItemBankQuestion): ItemSnapshot {
  const distractorRationale = Object.fromEntries(
    Object.entries(question.distractorRationale ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  const distractorErrorCode = Object.fromEntries(
    Object.entries(question.distractorErrorCode ?? {}).sort(([left], [right]) => left.localeCompare(right))
  );
  const content = {
    question: question.question,
    options: question.options,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation ?? null,
    difficultyTag: question.difficultyTag ?? 'medium',
    purpose: question.purpose ?? 'mastery',
    skillTag: question.skillTag ?? null,
    reasoningType: question.reasoningType ?? null,
    distractorRationale,
    distractorErrorCode,
    pedagogicalRationale: question.pedagogicalRationale ?? null,
  };

  return {
    difficultyTag: content.difficultyTag,
    purpose: content.purpose,
    skillTag: content.skillTag,
    reasoningType: content.reasoningType,
    distractorRationale: content.distractorRationale,
    distractorErrorCode: content.distractorErrorCode,
    pedagogicalRationale: content.pedagogicalRationale,
    contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [result[index], result[swapWith]] = [result[swapWith], result[index]];
  }
  return result;
}

/**
 * Baseline item-bank draw: a uniform sample of exactly five mastery items.
 * Difficulty targeting, recency and exposure limits deliberately belong to
 * item 20 of the execution plan.
 */
export function selectMasteryItems<T extends { question: ItemBankQuestion }>(
  pool: T[],
  random: () => number = Math.random,
  /**
   * How many to draw. Defaults to a whole attempt, but a caller topping up a
   * small authored pool with generated items asks for fewer — which is what
   * lets a teacher's first contribution reach a learner instead of waiting for
   * the pool to reach five.
   */
  count: number = ITEMS_PER_MASTERY_ATTEMPT
): T[] {
  const eligible = pool.filter(item => (item.question.purpose ?? 'mastery') === 'mastery');
  if (eligible.length < count) {
    throw new Error(`Item bank needs at least ${count} mastery items, has ${eligible.length}`);
  }

  return shuffled(eligible, random).slice(0, count);
}
