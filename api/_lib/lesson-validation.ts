/**
 * Structural checks on an LLM-generated lesson before it is cached.
 *
 * A generated lesson is written once and then served to every student who
 * reaches that concept, so a truncated or half-empty bundle is not a bad
 * response to one person — it is the lesson, until someone notices.
 *
 * The checks match what the generation prompt actually asks for. The
 * GeneratedLessonContent type also declares guidedPractice, masteryCheck and
 * remediationPath, but the prompt never requests them (quiz questions come
 * from a separate call), so requiring them here would fail every generation.
 */

/** Short enough to catch truncation without rejecting a terse-but-complete explanation. */
const MIN_EXPLANATION_CHARS = 200;
const MIN_WORKED_EXAMPLES = 2;
const MIN_STEPS_PER_EXAMPLE = 2;

export interface LessonValidationResult {
  valid: boolean;
  problems: string[];
}

function isNonEmptyString(value: unknown, minLength = 1): boolean {
  return typeof value === 'string' && value.trim().length >= minLength;
}

export function validateGeneratedLesson(lesson: unknown): LessonValidationResult {
  const problems: string[] = [];

  if (typeof lesson !== 'object' || lesson === null) {
    return { valid: false, problems: ['lesson is not an object'] };
  }

  const candidate = lesson as Record<string, any>;

  if (!isNonEmptyString(candidate.objective)) {
    problems.push('objective is missing or empty');
  }

  if (!isNonEmptyString(candidate.explanation?.text, MIN_EXPLANATION_CHARS)) {
    problems.push(`explanation.text is missing or shorter than ${MIN_EXPLANATION_CHARS} characters`);
  }

  if (!Array.isArray(candidate.alternateExplanations) || candidate.alternateExplanations.length === 0) {
    problems.push('alternateExplanations is missing or empty');
  } else {
    const broken = candidate.alternateExplanations.filter(
      (item: any) => !isNonEmptyString(item?.type) || !isNonEmptyString(item?.text)
    ).length;
    if (broken > 0) problems.push(`${broken} alternateExplanations entries are missing type or text`);
  }

  if (!Array.isArray(candidate.workedExamples) || candidate.workedExamples.length < MIN_WORKED_EXAMPLES) {
    problems.push(`workedExamples must have at least ${MIN_WORKED_EXAMPLES} entries`);
  } else {
    for (const [index, example] of candidate.workedExamples.entries()) {
      if (!isNonEmptyString(example?.problem)) {
        problems.push(`workedExamples[${index}] has no problem statement`);
      }
      if (!Array.isArray(example?.steps) || example.steps.length < MIN_STEPS_PER_EXAMPLE) {
        problems.push(`workedExamples[${index}] must have at least ${MIN_STEPS_PER_EXAMPLE} steps`);
      }
      if (!isNonEmptyString(example?.answer)) {
        problems.push(`workedExamples[${index}] has no answer`);
      }
    }
  }

  if (!isNonEmptyString(candidate.whyItMatters)) {
    problems.push('whyItMatters is missing or empty');
  }

  return { valid: problems.length === 0, problems };
}
