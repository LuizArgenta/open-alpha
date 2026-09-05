/**
 * Where to start a student, decided by asking rather than by their birthday.
 *
 * Until now the entry point was the student's grade, and every concept below
 * it was *assumed* mastered without a single question asked. That assumption
 * is the thing this whole model exists to remove: a 7th grader with a gap in
 * division was silently marked as knowing division, and only three failures
 * later did the engine step back to find it.
 *
 * The probe walks down from the student's grade, sampling a couple of items
 * per concept, and stops once they show a floor. What they demonstrate is
 * recorded as evidence with its own confidence; what they never saw stays
 * unknown, which is honest and is what the engine should reason over.
 */

import { type Concept, type MasteryQuestion, getConceptsForGrade } from './curriculum.js';

/** How many concepts a placement probe covers. Long enough to find a floor,
 *  short enough that a child will finish it. */
export const MAX_PROBED_CONCEPTS = 6;
export const ITEMS_PER_CONCEPT = 2;

/**
 * A placement estimate is worth less than a mastery check the student sat
 * and passed: fewer items, no lesson beforehand.
 */
export const PLACEMENT_CONFIDENCE = 0.6;

export interface ProbeItem {
  conceptId: string;
  question: MasteryQuestion;
}

export interface Probe {
  concepts: Concept[];
  items: ProbeItem[];
}

/**
 * Concepts to probe: the student's grade first, then downwards, one concept
 * per level so the probe spans the range instead of clustering.
 */
export function chooseProbeConcepts(
  subjectId: string,
  gradeLevel: number,
  alreadyKnown: Set<string> = new Set()
): Concept[] {
  const available = getConceptsForGrade(subjectId, gradeLevel)
    .filter(concept => !alreadyKnown.has(concept.id))
    .filter(concept => (concept.masteryCheck?.questions?.length ?? 0) > 0);

  const byLevel = new Map<number, Concept[]>();
  for (const concept of available) {
    byLevel.set(concept.gradeLevel, [...(byLevel.get(concept.gradeLevel) ?? []), concept]);
  }

  const levelsDescending = [...byLevel.keys()].sort((a, b) => b - a);
  const chosen: Concept[] = [];

  // One per level on the way down, then fill from the remaining pool.
  for (const level of levelsDescending) {
    if (chosen.length >= MAX_PROBED_CONCEPTS) break;
    chosen.push(byLevel.get(level)![0]);
  }

  for (const level of levelsDescending) {
    for (const concept of byLevel.get(level)!.slice(1)) {
      if (chosen.length >= MAX_PROBED_CONCEPTS) break;
      chosen.push(concept);
    }
  }

  return chosen.sort((a, b) => a.gradeLevel - b.gradeLevel);
}

export function buildProbe(concepts: Concept[]): Probe {
  const items: ProbeItem[] = [];

  for (const concept of concepts) {
    for (const question of concept.masteryCheck?.questions?.slice(0, ITEMS_PER_CONCEPT) ?? []) {
      items.push({ conceptId: concept.id, question });
    }
  }

  return { concepts, items };
}

export interface ProbeAnswer {
  conceptId: string;
  correct: boolean;
}

export interface PlacementEstimate {
  conceptId: string;
  /** True only when every probed item for the concept was answered correctly. */
  demonstrated: boolean;
  correct: number;
  asked: number;
}

/**
 * A concept counts as demonstrated only on a clean sweep. Two items are too
 * few to read a partial score as anything: one lucky guess out of two would
 * otherwise place a student above a gap they still have.
 */
export function estimateFromProbe(answers: ProbeAnswer[]): PlacementEstimate[] {
  const byConcept = new Map<string, { correct: number; asked: number }>();

  for (const answer of answers) {
    const tally = byConcept.get(answer.conceptId) ?? { correct: 0, asked: 0 };
    tally.asked += 1;
    if (answer.correct) tally.correct += 1;
    byConcept.set(answer.conceptId, tally);
  }

  return [...byConcept.entries()].map(([conceptId, tally]) => ({
    conceptId,
    demonstrated: tally.asked > 0 && tally.correct === tally.asked,
    correct: tally.correct,
    asked: tally.asked,
  }));
}
