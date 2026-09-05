import { describe, expect, it } from 'vitest';
import {
  type ProgressRecord,
  getConcept,
  getNextConcept,
  resolveRemediation,
  toProgressMap,
} from '../api/_lib/curriculum.js';

const GRADE = 4;
const FRACTIONS = 'math-fractions-intro';
const DIVISION = 'math-division';
const DECIMALS = 'math-decimals';

function attempt(conceptId: string, masteryScore: number, attempts: number): ProgressRecord {
  return { conceptId, masteryScore, attempts };
}

describe('getNextConcept', () => {
  it('starts a new student at their grade level, not at the root of the graph', () => {
    const next = getNextConcept('math', [], GRADE);
    expect(next?.id).toBe(FRACTIONS);
    expect(next?.gradeLevel).toBe(GRADE);
  });

  it('offers the same concept again while attempts are still productive', () => {
    const next = getNextConcept('math', [attempt(FRACTIONS, 40, 2)], GRADE);
    expect(next?.id).toBe(FRACTIONS);
  });

  it('steps back to an unverified prerequisite after three failures', () => {
    const next = getNextConcept('math', [attempt(FRACTIONS, 40, 3)], GRADE);
    expect(next?.id).toBe(DIVISION);
    expect(getConcept('math', FRACTIONS)?.prerequisites).toContain(DIVISION);
  });

  it('does not step back to a prerequisite the student has already demonstrated', () => {
    const next = getNextConcept(
      'math',
      [attempt(FRACTIONS, 40, 3), attempt(DIVISION, 100, 1)],
      GRADE
    );
    expect(next?.id).not.toBe(DIVISION);
  });

  it('moves on once a concept is mastered', () => {
    const next = getNextConcept('math', [attempt(FRACTIONS, 100, 1)], GRADE);
    expect(next?.id).not.toBe(FRACTIONS);
  });
});

describe('resolveRemediation', () => {
  it('points review_prerequisites at a direct prerequisite, not a distant ancestor', () => {
    // Regression: walking the whole ancestor chain resolved failing Decimals to
    // Division, while the authored message tells the student to revisit
    // Fractions. The button and the text have to agree.
    const decimals = getConcept('math', DECIMALS)!;
    expect(decimals.remediationPath?.action).toBe('review_prerequisites');
    expect(decimals.prerequisites).toEqual([FRACTIONS]);

    const resolved = resolveRemediation(
      'math',
      decimals,
      toProgressMap([attempt(FRACTIONS, 100, 1), attempt(DECIMALS, 20, 1)])
    );

    expect(resolved?.conceptId).toBe(FRACTIONS);
    expect(resolved?.message).toBe(decimals.remediationPath?.message);
  });

  it('keeps an authored action that points nowhere without inventing a target', () => {
    const fractions = getConcept('math', FRACTIONS)!;
    expect(fractions.remediationPath?.action).toBe('simpler_explanation');

    const resolved = resolveRemediation('math', fractions, toProgressMap([]));

    expect(resolved?.action).toBe('simpler_explanation');
    expect(resolved?.conceptId).toBeUndefined();
  });

  it('falls back to the weakest prerequisite when no path is authored', () => {
    const concept = {
      ...getConcept('math', DECIMALS)!,
      remediationPath: undefined,
    };

    const resolved = resolveRemediation('math', concept, toProgressMap([]));

    expect(resolved?.action).toBe('review_prerequisites');
    expect(resolved?.conceptId).toBe(FRACTIONS);
  });

  it('returns nothing for a concept with no prerequisites and no authored path', () => {
    const root = { ...getConcept('math', 'math-counting')!, remediationPath: undefined };
    expect(root.prerequisites).toEqual([]);
    expect(resolveRemediation('math', root, toProgressMap([]))).toBeUndefined();
  });
});
