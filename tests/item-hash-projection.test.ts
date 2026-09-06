/**
 * `snapshotItem` decides an authored item's identity by hashing a hand-written
 * projection of its fields. That projection is what keeps a student from being
 * graded against a stale answer key: change a question's wording and the hash
 * changes, so a new immutable snapshot is stored instead of the old one being
 * silently reused.
 *
 * The projection is maintained by hand, which is the weak point. A field added
 * to `ItemBankQuestion` and not mirrored into the hash makes two genuinely
 * different items collide on one identity — reviving exactly the bug the item
 * bank fixed, and this time without a symptom to notice. Types are erased at
 * runtime, so the structural half of this is read from the source, the way
 * `i18n-keys.test.ts` reads the API's translation keys.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { type ItemBankQuestion, snapshotItem } from '../api/_lib/item-bank.js';

const SOURCE = readFileSync(join(process.cwd(), 'api/_lib/item-bank.ts'), 'utf-8');

/**
 * Field names declared between a block's opening line and its closing token.
 * The closer is explicit because `snapshotItem` immediately follows its
 * `content` literal with a `return {}` that repeats the same names.
 */
function fieldsInBlock(opening: RegExp, closer: string): string[] {
  const start = SOURCE.search(opening);
  if (start === -1) throw new Error(`Could not find ${opening} in item-bank.ts`);
  const body = SOURCE.slice(start);
  const end = body.indexOf(closer);
  if (end === -1) throw new Error(`Could not find ${JSON.stringify(closer)} after ${opening}`);

  // Matches both `name: value` and the shorthand `name,`.
  return [...body.slice(0, end).matchAll(/^\s+(\w+)\??[,:]/gm)].map(match => match[1]);
}

const declaredFields = () => fieldsInBlock(/export interface ItemBankQuestion \{/, '\n}');
const hashedFields = () => fieldsInBlock(/const content = \{/, '\n  };');

const base: ItemBankQuestion = {
  question: 'What is 1/2 + 1/4?',
  options: ['1/4', '2/6', '3/4', '1'],
  correctAnswer: 'C',
  explanation: 'Give them a common denominator first.',
  difficultyTag: 'medium',
  purpose: 'mastery',
  skillTag: 'fraction-addition',
  reasoningType: 'procedural',
  distractorRationale: { A: 'Added only the numerators.' },
  distractorErrorCode: { A: 'numerator-only-addition' },
  pedagogicalRationale: 'Checks common denominators before arithmetic.',
};

/** A different value for each field, to prove the hash actually reads it. */
const mutations: Record<keyof ItemBankQuestion, ItemBankQuestion> = {
  question: { ...base, question: 'What is 1/2 + 1/3?' },
  options: { ...base, options: ['1/4', '2/6', '3/4', '2'] },
  correctAnswer: { ...base, correctAnswer: 'D' },
  explanation: { ...base, explanation: 'Something else entirely.' },
  difficultyTag: { ...base, difficultyTag: 'hard' },
  purpose: { ...base, purpose: 'practice' },
  skillTag: { ...base, skillTag: 'fraction-subtraction' },
  reasoningType: { ...base, reasoningType: 'conceptual' },
  distractorRationale: { ...base, distractorRationale: { A: 'Different reasoning.' } },
  distractorErrorCode: { ...base, distractorErrorCode: { A: 'different-code' } },
  pedagogicalRationale: { ...base, pedagogicalRationale: 'A different purpose.' },
};

describe('the item hash covers every field of an item', () => {
  it('hashes exactly the fields ItemBankQuestion declares', () => {
    const declared = declaredFields();
    const hashed = hashedFields();

    expect(declared.length).toBeGreaterThan(0);
    // If this fails after adding a field to ItemBankQuestion, add it to the
    // `content` object in snapshotItem too. Leaving it out means two items
    // that differ only in that field share one identity, and a student can be
    // shown one and graded against the other.
    expect([...hashed].sort()).toEqual([...declared].sort());
  });

  it('covers every declared field in this test, so the checks below stay honest', () => {
    const declared = declaredFields();
    expect(Object.keys(mutations).sort()).toEqual([...declared].sort());
  });

  it.each(Object.keys(mutations))('changes the hash when %s changes', field => {
    const changed = mutations[field as keyof ItemBankQuestion];
    expect(snapshotItem(changed).contentHash).not.toBe(snapshotItem(base).contentHash);
  });

  it('gives the same hash to the same content, so unchanged items are reused', () => {
    expect(snapshotItem({ ...base }).contentHash).toBe(snapshotItem(base).contentHash);
  });

  it('does not depend on the order keys were written in', () => {
    // Reordering an object's keys is not an edit to the question, and must not
    // orphan every attempt linked to the previous snapshot.
    const reordered: ItemBankQuestion = {
      pedagogicalRationale: base.pedagogicalRationale,
      distractorErrorCode: base.distractorErrorCode,
      correctAnswer: base.correctAnswer,
      options: base.options,
      question: base.question,
      explanation: base.explanation,
      purpose: base.purpose,
      difficultyTag: base.difficultyTag,
      reasoningType: base.reasoningType,
      skillTag: base.skillTag,
      distractorRationale: base.distractorRationale,
    };
    expect(snapshotItem(reordered).contentHash).toBe(snapshotItem(base).contentHash);
  });

  it('treats an omitted optional field as its default, not as a separate item', () => {
    const withDefaults: ItemBankQuestion = {
      question: base.question,
      options: base.options,
      correctAnswer: base.correctAnswer,
    };
    const spelledOut: ItemBankQuestion = {
      ...withDefaults,
      difficultyTag: 'medium',
      purpose: 'mastery',
    };
    expect(snapshotItem(spelledOut).contentHash).toBe(snapshotItem(withDefaults).contentHash);
  });
});
