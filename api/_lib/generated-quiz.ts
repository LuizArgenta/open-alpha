/**
 * Turning a model's answer into questions we are willing to serve.
 *
 * Two failures come back from generation and they are not the same failure.
 *
 * An item whose `correctAnswer` matches none of its options is unanswerable:
 * every student fails it forever, and the engine reads that failure as a
 * knowledge gap and sends them back to a prerequisite they already know. There
 * is no repair for it and no version of it that belongs in front of a learner.
 * That one refuses the quiz.
 *
 * A missing `distractorErrorCode` costs a diagnosis, not a quiz. The student
 * can still sit it, still be graded, still be told what they got wrong — what
 * is lost is the engine's ability to say *three mistakes, one cause*. Refusing
 * the session to protect a telemetry field trades a learner's afternoon for a
 * column, which in a learning product is the wrong way round.
 *
 * So: generate, and if anything came back wrong, generate once more — a second
 * sample often comes back complete, and one retry is cheap next to a refused
 * session. If the second is no better, refuse only what is unanswerable, and
 * for the metadata serve the item with the untrustworthy map discarded.
 *
 * Discarded, not kept. A `distractorErrorCode` covering two of three
 * distractors is worse than none: the diagnosis reads "no code recorded" as
 * "no shared cause", so three mistakes from one misunderstanding look like
 * three unrelated ones. Absent is honest; half-filled lies.
 *
 * And counted. A silent fallback is the defect this project keeps finding in
 * itself — both ends built, the middle absent, nothing noticing. Degraded and
 * measured is a different thing: `quiz_start` carries how many items were
 * served without usable codes and how many of those had a map we threw away,
 * so "how often does generation omit metadata" is a query, not a guess.
 */

import type { AttemptQuestion } from './assessment.js';
import { answerabilityProblem, metadataProblems } from './curriculum-record.js';
import { type ContentLanguage, generateQuizQuestions } from './llm.js';

export interface GenerationRequest {
  subject: string;
  conceptName: string;
  gradeLevel: number;
  count: number;
  interests?: Array<{ category: string; value: string }>;
  recentAccuracy?: number;
  language: ContentLanguage;
}

/** What the model omitted, in numbers that can be summed across attempts. */
export interface GenerationQuality {
  /** How many times the model was called: 2 means the first draw was repaired or refused. */
  attempts: number;
  /** Items the model wrote — the denominator for everything below. */
  items: number;
  /** Items served with no usable error-code map — absent or discarded. */
  withoutErrorCodes: number;
  /** Maps discarded for being incomplete or wrong, across both distractor fields. */
  discarded: number;
}

export type GeneratedQuiz =
  | { questions: AttemptQuestion[]; quality: GenerationQuality }
  | { problems: string[]; quality: GenerationQuality };

interface Draw {
  questions: Record<string, unknown>[];
  /** Problems that make an item unservable. */
  blocking: string[];
  /** Problems that cost a diagnosis, per question and field. */
  metadata: Array<{ index: number; field: string; problem: string }>;
  /** Items that came back with no error-code map at all. */
  missing: number;
}

function parseQuestions(raw: string): Record<string, unknown>[] {
  // Models wrap JSON in a fence about as often as not.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const parsed = JSON.parse(fenced ? fenced[1].trim() : raw) as { questions?: unknown };
  return Array.isArray(parsed.questions) ? parsed.questions as Record<string, unknown>[] : [];
}

function inspect(raw: string): Draw {
  let questions: Record<string, unknown>[];
  try {
    questions = parseQuestions(raw);
  } catch {
    return { questions: [], blocking: ['the model did not return JSON'], metadata: [], missing: 0 };
  }

  if (questions.length === 0) {
    return { questions: [], blocking: ['the model returned no questions'], metadata: [], missing: 0 };
  }

  const blocking: string[] = [];
  const metadata: Draw['metadata'] = [];
  let missing = 0;
  for (const [index, question] of questions.entries()) {
    const where = `generated[${index}]`;
    const problem = answerabilityProblem(question, where);
    if (problem) {
      blocking.push(problem);
      continue;
    }
    for (const found of metadataProblems(question, where)) {
      metadata.push({ index, field: found.field, problem: found.problem });
    }
    // An absent map is not a validation problem — `curriculum-record.ts`
    // deliberately allows a stored question to have none. It is still the
    // omission this retry exists for, and the one the audit found: the field
    // the diagnosis reads was empty at both ends.
    if (question.distractorErrorCode === undefined) missing += 1;
  }

  return { questions, blocking, metadata, missing };
}

/** Lower is better. Nothing beats servable; complete beats degraded. */
function rank(draw: Draw): number {
  if (draw.blocking.length > 0) return 2;
  return draw.metadata.length > 0 || draw.missing > 0 ? 1 : 0;
}

export async function generateServableQuiz(request: GenerationRequest): Promise<GeneratedQuiz> {
  const draw = async () => inspect(await generateQuizQuestions(
    request.subject,
    request.conceptName,
    request.gradeLevel,
    request.count,
    request.interests,
    request.recentAccuracy,
    request.language
  ));

  let chosen = await draw();
  let attempts = 1;

  if (rank(chosen) > 0) {
    // One retry, never a loop. A second sample is a cheap way out of a bad
    // draw; a third is a way to spend a student's wait on a model that is
    // having a bad day.
    attempts = 2;
    const again = await draw();
    if (rank(again) < rank(chosen)) chosen = again;
  }

  if (chosen.blocking.length > 0) {
    return {
      problems: chosen.blocking,
      quality: { attempts, items: 0, withoutErrorCodes: 0, discarded: 0 },
    };
  }

  const discardedFrom = new Map<number, Set<string>>();
  for (const found of chosen.metadata) {
    const fields = discardedFrom.get(found.index) ?? new Set<string>();
    fields.add(found.field);
    discardedFrom.set(found.index, fields);
  }

  let discarded = 0;
  let withoutErrorCodes = 0;
  const questions = chosen.questions.map((question, index) => {
    const drop = discardedFrom.get(index);
    const kept = { ...question };
    for (const field of drop ?? []) {
      delete kept[field];
      discarded += 1;
    }
    if (kept.distractorErrorCode === undefined) withoutErrorCodes += 1;
    return kept as unknown as AttemptQuestion;
  });

  return { questions, quality: { attempts, items: questions.length, withoutErrorCodes, discarded } };
}
