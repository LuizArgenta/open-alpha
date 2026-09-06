/**
 * Producing the evidence a diagnosis needs, before anything consumes it.
 *
 * The engine stores `distractor_error_code`, `skill_tag` and `reasoning_type`
 * on every item, with a column, a validation rule and an index. Nothing ever
 * wrote a value into them: all 45 authored questions omit them, and the
 * generation prompt asked only for question, options, answer and explanation.
 * The pipe was empty at both ends, and a diagnosis reading those columns would
 * have distinguished nothing.
 *
 * Two guarantees here, and they belong together.
 *
 * The first is coverage: metadata that names *some* distractors is worse than
 * none, because a consumer reads "no code" as "no shared cause" and three
 * mistakes from one misunderstanding look like three unrelated ones.
 *
 * The second is that generated questions are checked at all. They reached the
 * student straight from JSON.parse, so the unanswerable-item rule — a
 * correctAnswer matching no option, failed by every student forever while the
 * engine reads it as a knowledge gap — only ever guarded the authored 6%.
 */

import { describe, expect, it } from 'vitest';
import { questionProblem } from '../api/_lib/curriculum-record.js';

const OPTIONS = ['A) 3/8', 'B) 1/2', 'C) 5/8', 'D) 2/3'];

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    question: 'Which fraction is greater than one half?',
    options: OPTIONS,
    correctAnswer: 'C',
    explanation: '5/8 is greater than 4/8.',
    ...overrides,
  };
}

describe('a question the engine would serve', () => {
  it('accepts one with no metadata at all, which is most of what exists', () => {
    // Absence is honest. Every authored question today looks like this.
    expect(questionProblem(question(), 'q')).toBeUndefined();
  });

  it('refuses one nobody can pass', () => {
    // The failure this validation was written for, now reachable from the
    // generated path as well as the authored one.
    const problem = questionProblem(question({ correctAnswer: 'E' }), 'q');
    expect(problem).toMatch(/matches none of its options/);
  });

  it('refuses a blank question or a single option', () => {
    expect(questionProblem(question({ question: '' }), 'q')).toMatch(/question is missing/);
    expect(questionProblem(question({ options: ['A) only'] }), 'q')).toMatch(/at least two/);
  });
});

describe('distractor metadata', () => {
  it('accepts codes that name every wrong option', () => {
    const problem = questionProblem(question({
      distractorErrorCode: {
        'A': 'compares_numerator_only',
        'B': 'reads_equal_as_greater',
        'D': 'compares_denominator_only',
      },
    }), 'q');
    expect(problem).toBeUndefined();
  });

  it('refuses codes that cover only some distractors', () => {
    // The case that matters: a consumer cannot tell "this distractor has no
    // recorded cause" from "this distractor shares no cause with the others".
    const problem = questionProblem(question({
      distractorErrorCode: { 'A': 'compares_numerator_only' },
    }), 'q');
    expect(problem).toMatch(/covers 1 of 3 distractors/);
  });

  it('refuses a code attached to the correct answer', () => {
    const problem = questionProblem(question({
      distractorErrorCode: {
        'A': 'compares_numerator_only',
        'B': 'reads_equal_as_greater',
        'C': 'this_one_is_right',
      },
    }), 'q');
    expect(problem).toMatch(/names the correct answer/);
  });

  it('refuses a code naming an option that does not exist', () => {
    const problem = questionProblem(question({
      distractorErrorCode: {
        'A': 'compares_numerator_only',
        'B': 'reads_equal_as_greater',
        'Z': 'no_such_option',
      },
    }), 'q');
    expect(problem).toMatch(/matches no option/);
  });

  it('holds rationales to the same coverage rule', () => {
    const problem = questionProblem(question({
      distractorRationale: { 'A': 'They compared only the top numbers.' },
    }), 'q');
    expect(problem).toMatch(/covers 1 of 3 distractors/);
  });
});

describe('what the generation prompt asks for', () => {
  it('names every field the validation will hold it to', async () => {
    const llm = await import('fs/promises');
    const source = await llm.readFile('api/_lib/llm.ts', 'utf-8');
    const prompt = source.slice(source.indexOf('Generate ${count} multiple-choice'));

    // A prompt that does not ask cannot receive, and the validation above
    // would then be enforcing a rule on data nobody produces.
    for (const field of ['distractorErrorCode', 'distractorRationale', 'skillTag', 'reasoningType']) {
      expect(prompt, `the prompt must ask for ${field}`).toContain(field);
    }
    expect(prompt).toMatch(/must name every wrong option/);
  });
});
