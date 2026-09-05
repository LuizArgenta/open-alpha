/**
 * Record-level validation for stored curriculum.
 *
 * curriculum-validation.ts checks the *graph*: missing prerequisites, cycles,
 * level inversions. This checks one stored record on its own — that the JSON
 * parses, that the fields the engine reads are the types it assumes, and that
 * a mastery check is actually answerable.
 *
 * It exists because a single bad row used to take everything down. `content`
 * and `prerequisites` are JSON blobs, and JSON.parse throws: one corrupted
 * record made the whole database read fail, which sent the entire application
 * to the fallback files. One damaged concept should cost one concept.
 *
 * A malformed mastery check is the subtler half. `masteryCheck.questions` with
 * five entries is what makes the quiz endpoint serve authored items instead of
 * generating them, and the grader compares the student's choice against
 * `correctAnswer`. A question whose correctAnswer is not among its options is
 * unanswerable: every student fails it, forever, and the engine reads that as
 * a knowledge gap and sends them back to a prerequisite they already know.
 */

export interface RecordProblem {
  subjectId: string;
  conceptId: string;
  code:
    | 'invalid_json'
    | 'invalid_field'
    | 'invalid_mastery_check';
  detail: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface RawConceptRecord {
  subject_id: string;
  concept_id: string;
  name: string;
  description: string | null;
  level: number;
  prerequisites: string;
  content: string;
}

export interface ParsedConceptRecord {
  prerequisites: string[];
  content: Record<string, unknown>;
}

/**
 * Checks a mastery check the engine would actually serve.
 *
 * Deliberately not a check that every concept *has* one: most do not, and the
 * quiz endpoint generates questions when there is none. The failure being
 * caught is a mastery check that exists and cannot be passed.
 */
function masteryCheckProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return 'masteryCheck is not an object';

  const questions = value.questions;
  if (!Array.isArray(questions)) return 'masteryCheck.questions is not an array';

  for (const [index, question] of questions.entries()) {
    const where = `masteryCheck.questions[${index}]`;
    if (!isObject(question)) return `${where} is not an object`;
    if (!isNonEmptyString(question.question)) return `${where}.question is missing`;

    const options = question.options;
    if (!Array.isArray(options) || options.length < 2) {
      return `${where}.options needs at least two choices`;
    }
    if (!options.every(isNonEmptyString)) return `${where}.options contains a blank choice`;

    if (!isNonEmptyString(question.correctAnswer)) return `${where}.correctAnswer is missing`;
    if (!identifiesOneOption(question.correctAnswer, options)) {
      // The one that would otherwise be invisible: a question nobody can pass.
      return `${where}.correctAnswer "${question.correctAnswer}" matches none of its options`;
    }
  }

  return undefined;
}

/**
 * Authored items label their options ("A) 3/8") and store the label as the
 * answer ("C"); generated ones sometimes repeat the option text in full. Both
 * are fine. What is not fine is an answer that matches nothing — or matches
 * two things, which makes the grading arbitrary.
 */
function identifiesOneOption(correctAnswer: string, options: string[]): boolean {
  const answer = correctAnswer.trim();
  if (options.some(option => option.trim() === answer)) return true;

  const label = (option: string) => option.trim().split(/[).:\-]/, 1)[0].trim();
  return options.filter(option => label(option) === answer).length === 1;
}

function remediationProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) return 'remediationPath is not an object';

  const actions = ['review_prerequisites', 'simpler_explanation', 'sub_skill', 'extra_practice'];
  if (typeof value.action !== 'string' || !actions.includes(value.action)) {
    return `remediationPath.action "${String(value.action)}" is not a known action`;
  }
  if (value.action === 'sub_skill' && !isNonEmptyString(value.conceptId)) {
    return 'remediationPath sends the student to a sub-skill but names no concept';
  }
  return undefined;
}

/**
 * Returns the parsed record, or the problem that makes it unusable. Never
 * throws: the caller is reading a whole curriculum and has to keep going.
 */
export function parseConceptRecord(
  row: RawConceptRecord
): { record: ParsedConceptRecord } | { problem: RecordProblem } {
  const at = { subjectId: row.subject_id, conceptId: row.concept_id };
  const fail = (code: RecordProblem['code'], detail: string) => ({ problem: { ...at, code, detail } });

  if (!isNonEmptyString(row.concept_id)) return fail('invalid_field', 'concept id is blank');
  if (!isNonEmptyString(row.name)) return fail('invalid_field', 'name is blank');
  if (!Number.isInteger(Number(row.level))) return fail('invalid_field', `level "${row.level}" is not a whole number`);

  let prerequisites: unknown;
  let content: unknown;
  try {
    prerequisites = JSON.parse(row.prerequisites || '[]');
    content = JSON.parse(row.content || '{}');
  } catch (error) {
    return fail('invalid_json', `stored JSON does not parse: ${String(error)}`);
  }

  if (!Array.isArray(prerequisites) || !prerequisites.every(id => typeof id === 'string')) {
    return fail('invalid_field', 'prerequisites is not a list of concept ids');
  }
  if (!isObject(content)) return fail('invalid_field', 'content is not an object');

  const mastery = masteryCheckProblem(content.masteryCheck);
  if (mastery) return fail('invalid_mastery_check', mastery);

  const remediation = remediationProblem(content.remediationPath);
  if (remediation) return fail('invalid_field', remediation);

  return { record: { prerequisites: prerequisites as string[], content } };
}
