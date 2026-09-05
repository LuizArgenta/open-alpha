import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { validateGeneratedLesson } from '../api/_lib/lesson-validation.js';

const CURRICULUM_DIR = join(process.cwd(), 'curriculum');

function validLesson() {
  return {
    objective: 'Identify the place value of each digit in numbers up to 1,000.',
    explanation: { text: 'x'.repeat(250) },
    alternateExplanations: [{ type: 'visual', text: 'Draw three columns.' }],
    workedExamples: [
      { problem: 'What is the value of 6 in 263?', steps: ['Find the place.', 'Multiply.'], answer: '60' },
      { problem: 'Write 347 in expanded form.', steps: ['Split the digits.', 'Add them.'], answer: '300 + 40 + 7' },
    ],
    whyItMatters: 'Place value underpins every later arithmetic skill.',
  };
}

describe('validateGeneratedLesson', () => {
  it('accepts every hand-authored lesson in the curriculum', () => {
    // The control: if the rules reject content a human wrote and shipped, they
    // are too strict and would send every generation into a retry loop.
    const files = readdirSync(CURRICULUM_DIR).filter(
      file => file.endsWith('.json') && !file.includes('schema')
    );

    const rejected: string[] = [];
    let checked = 0;

    for (const file of files) {
      const subject = JSON.parse(readFileSync(join(CURRICULUM_DIR, file), 'utf-8'));
      for (const concept of subject.concepts ?? []) {
        if (!concept.explanation || !concept.workedExamples) continue;
        checked++;
        const result = validateGeneratedLesson(concept);
        if (!result.valid) rejected.push(`${concept.id}: ${result.problems.join(', ')}`);
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(rejected).toEqual([]);
  });

  it('accepts a well-formed generated bundle', () => {
    expect(validateGeneratedLesson(validLesson()).valid).toBe(true);
  });

  it('rejects a truncated explanation', () => {
    const lesson = { ...validLesson(), explanation: { text: 'Too short.' } };
    const result = validateGeneratedLesson(lesson);

    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toContain('explanation.text');
  });

  it('rejects a bundle with a single worked example', () => {
    const lesson = validLesson();
    lesson.workedExamples = [lesson.workedExamples[0]];

    expect(validateGeneratedLesson(lesson).valid).toBe(false);
  });

  it('rejects worked examples that skip the reasoning steps', () => {
    const lesson = validLesson();
    lesson.workedExamples[0] = { problem: 'p', steps: ['just the answer'], answer: 'a' };

    const result = validateGeneratedLesson(lesson);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toContain('steps');
  });

  it('names every missing field so the retry prompt can fix them', () => {
    const result = validateGeneratedLesson({});

    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(3);
  });

  it('does not require fields the generation prompt never asks for', () => {
    // guidedPractice, masteryCheck and remediationPath are declared on
    // GeneratedLessonContent but are not part of the lesson prompt.
    expect(validateGeneratedLesson(validLesson()).valid).toBe(true);
  });

  it('handles values that are not objects at all', () => {
    expect(validateGeneratedLesson(null).valid).toBe(false);
    expect(validateGeneratedLesson('a lesson').valid).toBe(false);
  });
});
