import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { executeSql } from './db.js';

// ── Enriched content types ────────────────────────────────────────────────────

export interface ConceptExplanation {
  text: string;
  childVersion?: string;
  adultVersion?: string;
}

export interface AlternateExplanation {
  type: 'visual' | 'analogy' | 'realWorld' | 'stepByStep' | 'formal';
  text: string;
}

export interface WorkedExample {
  problem: string;
  steps: string[];
  answer: string;
}

export interface GuidedPracticeItem {
  id: string;
  prompt: string;
  answer: string;
  hint: string;
  feedback: {
    correct: string;
    incorrect: string;
  };
}

export interface MasteryQuestion {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
}

export interface MasteryCheck {
  passingScore: number;
  questions: MasteryQuestion[];
}

export interface RemediationPath {
  action: 'review_prerequisites' | 'simpler_explanation' | 'sub_skill' | 'extra_practice';
  conceptId?: string;
  message: string;
}

export interface ConceptMetadata {
  tags?: string[];
  estimatedMinutes?: number;
  gradeBand?: string;
  difficulty?: 'foundational' | 'standard' | 'advanced';
}

// ── Core types ────────────────────────────────────────────────────────────────

export interface Concept {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  gradeLevel: number;
  // Enriched fields — present only on fully-built concept bundles
  objective?: string;
  explanation?: ConceptExplanation;
  alternateExplanations?: AlternateExplanation[];
  workedExamples?: WorkedExample[];
  guidedPractice?: GuidedPracticeItem[];
  masteryCheck?: MasteryCheck;
  remediationPath?: RemediationPath;
  whyItMatters?: string;
  metadata?: ConceptMetadata;
}

export interface Subject {
  id: string;
  name: string;
  description: string;
  concepts: Concept[];
}

// ── Loader ────────────────────────────────────────────────────────────────────

function loadSubjects(): Subject[] {
  const curriculumDir = join(process.cwd(), 'curriculum');
  // Only load files that are subject definitions (have a concepts array).
  // Exclude any *schema*.json files (schema.json, contribution-schema.json, etc.)
  const files = readdirSync(curriculumDir).filter(
    f => f.endsWith('.json') && !f.includes('schema')
  );

  const result: Subject[] = [];
  for (const file of files) {
    const raw = readFileSync(join(curriculumDir, file), 'utf-8');
    const data = JSON.parse(raw);
    // Skip files that aren't subject definitions
    if (!data.id || !Array.isArray(data.concepts)) continue;
    result.push({
      id: data.id,
      name: data.name,
      description: data.description,
      concepts: data.concepts.map((c: Record<string, unknown>) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        prerequisites: c.prerequisites,
        gradeLevel: c.level,
        // Pass enriched fields through when present
        ...(c.objective !== undefined && { objective: c.objective }),
        ...(c.explanation !== undefined && { explanation: c.explanation }),
        ...(c.alternateExplanations !== undefined && { alternateExplanations: c.alternateExplanations }),
        ...(c.workedExamples !== undefined && { workedExamples: c.workedExamples }),
        ...(c.guidedPractice !== undefined && { guidedPractice: c.guidedPractice }),
        ...(c.masteryCheck !== undefined && { masteryCheck: c.masteryCheck }),
        ...(c.remediationPath !== undefined && { remediationPath: c.remediationPath }),
        ...(c.whyItMatters !== undefined && { whyItMatters: c.whyItMatters }),
        ...(c.metadata !== undefined && { metadata: c.metadata }),
      })),
    });
  }
  return result;
}

// Load once at startup
export const subjects: Subject[] = loadSubjects();

export function getSubject(subjectId: string): Subject | undefined {
  return subjects.find(s => s.id === subjectId);
}

export function getConcept(subjectId: string, conceptId: string): Concept | undefined {
  const subject = getSubject(subjectId);
  return subject?.concepts.find(c => c.id === conceptId);
}

export function getConceptsForGrade(subjectId: string, gradeLevel: number): Concept[] {
  const subject = getSubject(subjectId);
  if (!subject) return [];
  const filtered = subject.concepts.filter(c => c.gradeLevel <= gradeLevel);
  // If grade-based filtering returns nothing (e.g., a K-12 student browsing
  // an adult subject), return all concepts so the subject isn't empty
  if (filtered.length === 0) return subject.concepts;
  return filtered;
}

export const MASTERY_THRESHOLD = 80;

// Three failed attempts is where "try again" stops being useful and the gap is
// more likely to be in a prerequisite than in this concept.
const STRUGGLE_ATTEMPTS = 3;

export interface ProgressRecord {
  conceptId: string;
  masteryScore: number;
  attempts: number;
}

export function toProgressMap(progress: ProgressRecord[]): Map<string, ProgressRecord> {
  return new Map(progress.map(record => [record.conceptId, record]));
}

/**
 * Walks up the prerequisite chain and returns the nearest concept the student
 * has never demonstrated. Nearest rather than deepest on purpose: sending a
 * 7th grader straight back to counting on the first stumble is worse than
 * stepping back one link at a time.
 */
function findUnverifiedPrerequisite(
  subjectId: string,
  concept: Concept,
  progressById: Map<string, ProgressRecord>
): Concept | undefined {
  const queue = [...concept.prerequisites];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const prerequisiteId = queue.shift()!;
    if (seen.has(prerequisiteId)) continue;
    seen.add(prerequisiteId);

    const prerequisite = getConcept(subjectId, prerequisiteId);
    if (!prerequisite) continue;
    if (!progressById.has(prerequisiteId)) return prerequisite;

    queue.push(...prerequisite.prerequisites);
  }

  return undefined;
}

/**
 * The prerequisite most likely to be the actual blocker: one never attempted,
 * otherwise the one with the lowest mastery.
 */
function findWeakestPrerequisite(
  subjectId: string,
  concept: Concept,
  progressById: Map<string, ProgressRecord>
): Concept | undefined {
  const unverified = findUnverifiedPrerequisite(subjectId, concept, progressById);
  if (unverified) return unverified;

  let weakest: Concept | undefined;
  let weakestScore = Infinity;
  for (const prerequisiteId of concept.prerequisites) {
    const prerequisite = getConcept(subjectId, prerequisiteId);
    const record = progressById.get(prerequisiteId);
    if (!prerequisite || !record) continue;
    if (record.masteryScore < weakestScore) {
      weakest = prerequisite;
      weakestScore = record.masteryScore;
    }
  }
  return weakest;
}

export function getNextConcept(
  subjectId: string,
  progress: ProgressRecord[],
  gradeLevel: number
): Concept | undefined {
  const availableConcepts = getConceptsForGrade(subjectId, gradeLevel);
  const progressById = toProgressMap(progress);
  const completedConceptIds = progress
    .filter(record => record.masteryScore >= MASTERY_THRESHOLD)
    .map(record => record.conceptId);

  const candidate = selectCandidate(availableConcepts, completedConceptIds, gradeLevel);
  if (!candidate) return undefined;

  // Repeated failures on the same concept usually mean a missing prerequisite,
  // not a need to see the same material a fourth time.
  const record = progressById.get(candidate.id);
  if (record && record.attempts >= STRUGGLE_ATTEMPTS && record.masteryScore < MASTERY_THRESHOLD) {
    const gap = findUnverifiedPrerequisite(subjectId, candidate, progressById);
    if (gap) return gap;
  }

  return candidate;
}

function selectCandidate(
  availableConcepts: Concept[],
  completedConceptIds: string[],
  gradeLevel: number
): Concept | undefined {
  // If student has no progress, start them at their grade level (not kindergarten)
  if (completedConceptIds.length === 0) {
    // First, try to find a concept AT their grade level
    const gradeAppropriate = availableConcepts.find(concept => {
      if (concept.gradeLevel !== gradeLevel) return false;
      // Check if all prerequisites are below their grade (assumed mastered)
      return concept.prerequisites.every(prereqId => {
        const prereq = availableConcepts.find(c => c.id === prereqId);
        return prereq && prereq.gradeLevel < gradeLevel;
      });
    });

    if (gradeAppropriate) return gradeAppropriate;

    // If no concept at exact grade level, find the highest grade concept they can start
    const sortedByGrade = [...availableConcepts]
      .sort((a, b) => b.gradeLevel - a.gradeLevel);

    return sortedByGrade.find(concept => {
      return concept.prerequisites.every(prereqId => {
        const prereq = availableConcepts.find(c => c.id === prereqId);
        return prereq && prereq.gradeLevel < gradeLevel;
      });
    });
  }

  // If they have progress, use normal progression logic
  return availableConcepts.find(concept => {
    if (completedConceptIds.includes(concept.id)) return false;
    return concept.prerequisites.every(prereq => completedConceptIds.includes(prereq));
  });
}

export interface ResolvedRemediation {
  action: RemediationPath['action'];
  message: string;
  conceptId?: string;
  conceptName?: string;
}

/**
 * Turns the concept's authored remediationPath into something the UI can act
 * on: a message plus, where the action points somewhere, the concept to go to.
 * Concepts without an authored path still get a useful answer when the student
 * has a visibly weak prerequisite.
 */
export function resolveRemediation(
  subjectId: string,
  concept: Concept,
  progressById: Map<string, ProgressRecord>
): ResolvedRemediation | undefined {
  const path = concept.remediationPath;

  if (path?.action === 'sub_skill' && path.conceptId) {
    const target = getConcept(subjectId, path.conceptId);
    return {
      action: path.action,
      message: path.message,
      conceptId: path.conceptId,
      conceptName: target?.name,
    };
  }

  if (path?.action === 'review_prerequisites') {
    const target = findWeakestPrerequisite(subjectId, concept, progressById);
    return {
      action: path.action,
      message: path.message,
      conceptId: target?.id,
      conceptName: target?.name,
    };
  }

  if (path) {
    return { action: path.action, message: path.message };
  }

  const target = findWeakestPrerequisite(subjectId, concept, progressById);
  if (!target) return undefined;

  return {
    action: 'review_prerequisites',
    message: `Let's revisit ${target.name} first — it's what this concept builds on.`,
    conceptId: target.id,
    conceptName: target.name,
  };
}

// ── On-demand lesson resolution ──────────────────────────────────────────────

interface CachedLessonRow {
  content: string;
}

/**
 * Returns a concept enriched with lesson content from any available source:
 *   1. Pre-authored JSON (already on the concept object)
 *   2. Cached generated lesson from the DB
 *
 * Does NOT trigger generation — that's the job of the /api/curriculum/lesson endpoint.
 * This function is for internal use (e.g., the tutor chat) where we want the best
 * available content without blocking on LLM generation.
 */
export async function getConceptWithLesson(
  subjectId: string,
  conceptId: string
): Promise<Concept | undefined> {
  const concept = getConcept(subjectId, conceptId);
  if (!concept) return undefined;

  // If the concept already has full content from JSON, return as-is
  if (concept.explanation && concept.workedExamples?.length && concept.masteryCheck) {
    return concept;
  }

  // Check for cached generated lesson
  const cached = await executeSql<CachedLessonRow>(
    'SELECT content FROM generated_lessons WHERE subject_id = $1 AND concept_id = $2',
    [subjectId, conceptId]
  );

  if (cached.rows.length > 0) {
    const lesson = JSON.parse(cached.rows[0].content);
    return {
      ...concept,
      objective: lesson.objective ?? concept.objective,
      explanation: lesson.explanation ?? concept.explanation,
      alternateExplanations: lesson.alternateExplanations ?? concept.alternateExplanations,
      workedExamples: lesson.workedExamples ?? concept.workedExamples,
      guidedPractice: lesson.guidedPractice ?? concept.guidedPractice,
      masteryCheck: lesson.masteryCheck ?? concept.masteryCheck,
      remediationPath: lesson.remediationPath ?? concept.remediationPath,
      whyItMatters: lesson.whyItMatters ?? concept.whyItMatters,
    };
  }

  // No cached content — return the stub concept
  return concept;
}
