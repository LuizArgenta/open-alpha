/**
 * Intervention, as a first-class thing rather than a branch in an endpoint.
 *
 * Today the engine decides *what concept comes next* and, when a student
 * fails, *what to offer them* — and that second decision exists only as a
 * shape returned from `submit.ts` and a row in `learning_decisions` saying
 * which action was chosen. There is nowhere to say what the offer was
 * supposed to achieve, and therefore nowhere to find out whether it did.
 *
 * ## The field that is the point
 *
 * `expected_outcome`, recorded **before** the result. Without it, the only
 * measurable thing is what happened. With it, what becomes measurable is
 * whether the decision was right — which is the difference between telemetry
 * and a testable claim, and the only way to answer the question the whole
 * design is for:
 *
 * > For students with misconception X in context Y, which intervention
 * > produces the larger gain *and* the better retention?
 *
 * Compare outcomes without a prediction written down first and the comparison
 * is retrospective: an explanation is always available for something that has
 * already happened.
 *
 * ## The guardrail
 *
 * From the PRD, and it is the reason this file has no `lesson` in it: if
 * `Intervention` cannot represent a human action, an external resource and an
 * AI action with equal naturalness, the design has failed. It is not a second
 * lessons table. `intervention-guardrail.test.ts` runs a teacher's action, an
 * outside video and a tutoring session through exactly the same path as the
 * engine's own remediation, because a guardrail nobody tests is a sentence in
 * a document.
 *
 * ## What is not here
 *
 * No scheduling, no delivery, no content. An intervention names *what should
 * be done, to whom, why, and what it is supposed to achieve*. How it reaches
 * the student is the surface's problem — which is what lets a teacher action
 * and a model call be the same kind of thing.
 */


/**
 * What kind of thing is being done.
 *
 * Deliberately wider than what the engine can currently produce. A vocabulary
 * that only covers today's four remediation actions would have to be widened
 * by migration the first time a teacher assigns anything, and the guardrail
 * above is precisely that this must not be a table for engine output.
 */
export const INTERVENTION_TYPES = [
  'micro_lesson',
  'practice',
  'retrieval',
  'diagnostic_probe',
  'ai_tutoring',
  'worked_example',
  'explanation',
  'teacher_action',
  'external_resource',
  'peer_activity',
] as const;
export type InterventionType = typeof INTERVENTION_TYPES[number];

/** Who or what delivers it. The engine is one source among several. */
export const INTERVENTION_SOURCES = ['engine', 'teacher', 'ai', 'external', 'peer'] as const;
export type InterventionSource = typeof INTERVENTION_SOURCES[number];

/** What it acts on. A misconception is as legitimate a target as a concept. */
export const INTERVENTION_TARGETS = [
  'concept',
  'prerequisite',
  'skill',
  'misconception',
  'none',
] as const;
export type InterventionTarget = typeof INTERVENTION_TARGETS[number];

export const INTERVENTION_STATUSES = ['draft', 'active', 'retired'] as const;

/**
 * How a run ended, judged against what was predicted when it started.
 *
 * `inconclusive` is not a hedge. A follow-up attempt that the diagnosis reads
 * as rushing or walking away says nothing about whether the student learned
 * anything, and scoring the intervention on it would attribute a lapse in
 * attention to the material.
 */
export const INTERVENTION_OUTCOMES = ['met', 'not_met', 'inconclusive', 'abandoned'] as const;
export type InterventionOutcome = typeof INTERVENTION_OUTCOMES[number];

function quoted(values: readonly string[]): string {
  return values.map(value => `'${value}'`).join(', ');
}

export const INTERVENTION_TYPE_LIST = quoted(INTERVENTION_TYPES);
export const INTERVENTION_SOURCE_LIST = quoted(INTERVENTION_SOURCES);
export const INTERVENTION_TARGET_LIST = quoted(INTERVENTION_TARGETS);
export const INTERVENTION_STATUS_LIST = quoted(INTERVENTION_STATUSES);
export const INTERVENTION_OUTCOME_LIST = quoted(INTERVENTION_OUTCOMES);

export interface Intervention {
  id: number;
  key: string;
  type: InterventionType;
  targetKind: InterventionTarget;
  targetId: string | null;
  source: InterventionSource;
  contentRef: string | null;
  estimatedMinutes: number | null;
  version: number;
  status: string;
}

/**
 * What this run is supposed to achieve, written down before it does or does
 * not happen.
 *
 * Narrow on purpose. A free-form "we hope they improve" cannot be scored, and
 * a prediction that cannot be scored is a prediction that will be reinterpreted
 * after the fact.
 */
export interface ExpectedOutcome {
  metric: 'mastery_score';
  subject: string;
  conceptId: string;
  /** Where the student stood when the intervention was chosen. */
  baseline: number;
  /** What would count as this having worked. */
  target: number;
  within: 'next_attempt';
}

export interface StartRun {
  interventionKey: string;
  studentId: number;
  subject: string;
  conceptId: string;
  /** Machine-readable grounds, stable enough to group and count on. */
  reason: string;
  /** The signals it was chosen from. */
  evidence: Record<string, unknown>;
  expectedOutcome: ExpectedOutcome;
  decisionId?: number;
}

export interface RunResult {
  outcome: InterventionOutcome;
  evidenceSummary: Record<string, unknown>;
}

/**
 * Scores a run against the prediction it started with.
 *
 * Pure, and separate from the writing, because this is the judgement — the
 * part that has to be arguable. `inconclusive` when the follow-up attempt
 * shows rushing or walking away: that attempt is evidence about attention, not
 * about whether the intervention taught anything, and counting it against the
 * material would be attributing the wrong cause.
 */
export function judgeRun(
  expected: ExpectedOutcome,
  observed: { score: number; attention: boolean }
): RunResult {
  const delta = observed.score - expected.baseline;

  if (observed.attention) {
    return {
      outcome: 'inconclusive',
      evidenceSummary: {
        reason: 'attention_pattern',
        baseline: expected.baseline,
        observed: observed.score,
      },
    };
  }

  return {
    outcome: observed.score >= expected.target ? 'met' : 'not_met',
    evidenceSummary: {
      baseline: expected.baseline,
      target: expected.target,
      observed: observed.score,
      // Kept even when the target was missed: "improved by 20 and still
      // failed" and "went backwards" are different facts about the same
      // not_met, and the comparison this table exists for needs both.
      delta,
    },
  };
}

/**
 * The engine's own catalogue: the four remediation actions it already chooses,
 * now named as interventions.
 *
 * Seeding rather than inventing. Item 1.3's whole criterion is that the
 * current flow is encapsulated and *nothing changes for the student*, so these
 * are the actions `resolveRemediation` already returns, mapped one to one.
 * Anything richer belongs to a later wave and to content, not to this table.
 */
export const ENGINE_INTERVENTIONS: Array<Omit<Intervention, 'id'>> = [
  {
    key: 'engine.review_prerequisites',
    type: 'practice',
    targetKind: 'prerequisite',
    targetId: null,
    source: 'engine',
    contentRef: null,
    estimatedMinutes: 10,
    version: 1,
    status: 'active',
  },
  {
    key: 'engine.sub_skill',
    type: 'micro_lesson',
    targetKind: 'concept',
    targetId: null,
    source: 'engine',
    contentRef: null,
    estimatedMinutes: 10,
    version: 1,
    status: 'active',
  },
  {
    key: 'engine.simpler_explanation',
    type: 'explanation',
    targetKind: 'concept',
    targetId: null,
    source: 'engine',
    contentRef: null,
    estimatedMinutes: 5,
    version: 1,
    status: 'active',
  },
  {
    key: 'engine.extra_practice',
    type: 'practice',
    targetKind: 'concept',
    targetId: null,
    source: 'engine',
    contentRef: null,
    estimatedMinutes: 10,
    version: 1,
    status: 'active',
  },
];

/** The remediation actions the engine returns, mapped to catalogue keys. */
const REMEDIATION_KEYS: Record<string, string> = {
  review_prerequisites: 'engine.review_prerequisites',
  sub_skill: 'engine.sub_skill',
  simpler_explanation: 'engine.simpler_explanation',
  extra_practice: 'engine.extra_practice',
};

export function interventionKeyForRemediation(action: string): string | undefined {
  return REMEDIATION_KEYS[action];
}

/**
 * Writes the engine's catalogue if it is not already there.
 *
 * Idempotent on `(key, version)`: a new deployment gets the rows, an existing
 * one gets nothing. Changing what one of these *is* means a new version, not
 * an edit — a run recorded against version 1 must keep meaning what it meant.
 */
/** How long a run waits for a follow-up before it is treated as abandoned. */
export const RUN_ABANDONED_AFTER_DAYS = 14;

/**
 * Closes runs the student never came back to.
 *
 * Left open they would quietly inflate every "met" rate, because the runs that
 * never got a follow-up are exactly the ones most likely to have failed. This
 * rides on the next quiz the student opens, for the same reason
 * `expireStaleAttempts` does: serverless has nowhere to run a sweep. A student
 * who never returns leaves their runs open, which is a real limit and not a
 * hidden one — the abandonment is knowable only from a visit.
 */
