/**
 * The engine answers with an *action*, not a place.
 *
 * `GET /api/tutor/next/{subject}` returned a concept and
 * `POST /api/tutor/quiz/submit` returned a remediation, and the client had to
 * work out what to do with each. That is backwards: deciding what a student
 * should do next is the engine's job, and leaving it half-done meant the
 * interface guessed.
 *
 * The guess was visible. The results screen showed a "review X" button
 * whenever the remediation happened to carry a `conceptId` — so
 * `review_prerequisites` and `sub_skill` got one, while `simpler_explanation`
 * told the student "let's try explaining this differently" and gave them
 * nothing to click. Nobody decided that. It fell out of which fields a shape
 * happened to have.
 *
 * ## Every type here has a producer
 *
 * Five actions, because five are what the engine can currently decide. Not the
 * ten that a richer engine might: an action nothing produces is an action
 * nothing handles, and this project has found five instances of exactly that
 * shape already.
 *
 * ## Why `policyVersion`
 *
 * The rules that choose these will change — that is the point of measuring
 * them. When they do, every decision recorded before the change becomes
 * uninterpretable unless it says which rulebook was in force. Same argument as
 * `schema_version` on the event stream: a thing nobody can version is a thing
 * nobody can change.
 */

/** Bump when the rules that choose an action change, not when the code moves. */
export const POLICY_VERSION = 1;

export const NEXT_ACTION_TYPES = [
  /** Move forward: learn the next concept in sequence. */
  'study_concept',
  /** Step back: something this rests on is not solid. */
  'review_prerequisite',
  /** A smaller piece of the same concept. */
  'micro_lesson',
  /** The same concept, explained another way. */
  'simpler_explanation',
  /** More reps on the same concept. */
  'practice',
] as const;

export type NextActionType = typeof NEXT_ACTION_TYPES[number];

export interface NextAction {
  type: NextActionType;
  /** Machine-readable grounds: why this and not something else. */
  reason: string;
  /** What to act on. Absent only if the action needs no target. */
  conceptId?: string;
  /** The name to show, when the target is a concept the curriculum knows. */
  conceptName?: string;
  /**
   * This student's instance of an intervention, when the action started one.
   *
   * The run, not the catalogue entry — the PRD writes `interventionId`, which
   * is ambiguous between "which kind of thing" and "this student's instance",
   * and the client needs the second: it is what a later "did it work" refers
   * to.
   */
  interventionRunId?: string;
  policyVersion: number;
}

/** The remediation actions the engine produces, as next actions. */
const FROM_REMEDIATION: Record<string, NextActionType> = {
  review_prerequisites: 'review_prerequisite',
  sub_skill: 'micro_lesson',
  simpler_explanation: 'simpler_explanation',
  extra_practice: 'practice',
};

export function actionForRemediation(
  remediation: { action: string; conceptId?: string; conceptName?: string } | undefined,
  context: { reason: string; conceptId: string; interventionRunId?: string }
): NextAction | null {
  if (!remediation) return null;
  const type = FROM_REMEDIATION[remediation.action];
  if (!type) return null;

  return {
    type,
    reason: context.reason,
    // A remediation that names another concept sends them there; one that does
    // not is about the concept they just sat.
    conceptId: remediation.conceptId ?? context.conceptId,
    ...(remediation.conceptName ? { conceptName: remediation.conceptName } : {}),
    ...(context.interventionRunId ? { interventionRunId: context.interventionRunId } : {}),
    policyVersion: POLICY_VERSION,
  };
}

export function actionForNextConcept(
  concept: { id: string; name: string },
  steppedBack: boolean
): NextAction {
  return {
    // Stepping back to a prerequisite is not the same instruction as moving
    // forward, and the old contract said "concept" for both.
    type: steppedBack ? 'review_prerequisite' : 'study_concept',
    reason: steppedBack ? 'prerequisite_gap' : 'next_in_sequence',
    conceptId: concept.id,
    conceptName: concept.name,
    policyVersion: POLICY_VERSION,
  };
}
