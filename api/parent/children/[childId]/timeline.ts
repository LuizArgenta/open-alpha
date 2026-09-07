/**
 * GET /api/parent/children/{childId}/timeline
 *
 * What happened, in order: what the child was asked, how they answered, and
 * what the engine decided about it. This is the first consumer of the
 * evidence layer — before it, all of that was written and never read.
 *
 * Interventions appear as two entries, not one. "On Tuesday the system
 * offered a review of equivalent fractions, expecting her to reach 80" and
 * "on Thursday it concluded that did not work" are two things that happened,
 * and collapsing them into a single row with an outcome would hide the gap in
 * between — which is exactly the part a parent asking "what is it doing about
 * this?" wants to see.
 *
 * Read from `intervention_runs` rather than from the event stream, which the
 * PRD's own non-goal calls for: the operational tables stay the source of
 * truth, and the run row is where the prediction and the verdict actually
 * live.
 */

import { executeSql } from '../../../_lib/db.js';
import { parseDbTimestamp } from '../../../_lib/time.js';
import { getConcept } from '../../../_lib/curriculum.js';
import { childIdFromPath, isDenied, requireLinkedChild } from '../../../_lib/guardian.js';

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

interface AttemptRow {
  id: number;
  subject: string;
  kind: string;
  concept_id: string;
  score: number | null;
  finished_at: string | null;
  started_at: string;
  answered: number;
  correct: number;
}

interface InterventionRunRow {
  run_id: string;
  intervention_key: string;
  intervention_type: string;
  source: string;
  subject: string;
  concept_id: string;
  target_concept_id: string | null;
  reason: string;
  expected_outcome: string;
  started_at: string;
  completed_at: string | null;
  outcome: string | null;
  evidence_summary: string | null;
}

interface DecisionRow {
  subject: string | null;
  concept_id: string | null;
  kind: string;
  decision: string;
  reason: string;
  inputs: string;
  created_at: string;
}

type TimelineEvent =
  | {
      type: 'attempt';
      at: string;
      subject: string;
      kind: 'mastery' | 'placement';
      conceptId: string;
      conceptName: string;
      score: number | null;
      answered: number;
      correct: number;
      attemptId: number;
    }
  | {
      type: 'decision';
      at: string;
      subject: string | null;
      conceptId: string | null;
      conceptName: string | null;
      kind: string;
      decision: string;
      reason: string;
      inputs: Record<string, unknown>;
    }
  | {
      type: 'intervention';
      at: string;
      /** `started` and `completed` are separate moments and separate rows. */
      phase: 'started' | 'completed';
      subject: string;
      /** The concept the run is judged on. */
      conceptId: string;
      conceptName: string;
      /** Where the student was actually sent, which is not always the same. */
      targetConceptId: string;
      targetConceptName: string;
      runId: string;
      interventionKey: string;
      interventionType: string;
      /** Engine, teacher, AI, external or peer — the same table holds all. */
      source: string;
      reason: string;
      /** What it was supposed to achieve, recorded before it did or did not. */
      expected: { baseline: number; target: number } | null;
      outcome: string | null;
      observed: number | null;
    };

/** One unreadable row costs that row's detail, never the whole timeline. */
function readJson(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function conceptName(subject: string | null, conceptId: string | null): string | null {
  if (!subject || !conceptId) return null;
  return getConcept(subject, conceptId)?.name ?? conceptId;
}

export async function GET(request: Request) {
  try {
    const access = await requireLinkedChild(request, childIdFromPath(request));
    if (isDenied(access)) return access;

    const url = new URL(request.url);
    const limit = Math.min(
      Number(url.searchParams.get('limit')) || DEFAULT_LIMIT,
      MAX_LIMIT
    );

    const attempts = await executeSql<AttemptRow>(
      `SELECT a.id, a.subject, a.kind, a.concept_id, a.score, a.finished_at, a.started_at,
              COUNT(r.id) as answered,
              COALESCE(SUM(r.correct), 0) as correct
       FROM assessment_attempts a
       LEFT JOIN assessment_responses r ON r.attempt_id = a.id
       WHERE a.student_id = $1
       GROUP BY a.id
       ORDER BY COALESCE(a.finished_at, a.started_at) DESC
       LIMIT $2`,
      [access.childId, limit]
    );

    const decisions = await executeSql<DecisionRow>(
      `SELECT subject, concept_id, kind, decision, reason, inputs, created_at
       FROM learning_decisions
       WHERE student_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [access.childId, limit]
    );

    const runs = await executeSql<InterventionRunRow>(
      `SELECT r.run_id, i.key AS intervention_key, i.type AS intervention_type, i.source,
              r.subject, r.concept_id, r.target_concept_id, r.reason, r.expected_outcome,
              r.started_at, r.completed_at, r.outcome, r.evidence_summary
       FROM intervention_runs r JOIN interventions i ON i.id = r.intervention_id
       WHERE r.student_id = $1
       -- By the run's most recent moment, not by when it started. A run opened
       -- months ago and concluded this morning produces one of the newest
       -- entries on this timeline, and ordering by started_at alone would drop
       -- it below the limit and lose that entry entirely.
       ORDER BY MAX(r.started_at, COALESCE(r.completed_at, r.started_at)) DESC, r.id DESC
       LIMIT $2`,
      [access.childId, limit]
    );

    const events: TimelineEvent[] = [
      ...attempts.rows.map((row): TimelineEvent => ({
        type: 'attempt',
        at: row.finished_at ?? row.started_at,
        subject: row.subject,
        // A placement spans the subject, so it has no concept to name.
        kind: row.kind === 'placement' ? 'placement' : 'mastery',
        conceptId: row.concept_id,
        conceptName: conceptName(row.subject, row.concept_id) ?? row.concept_id,
        score: row.score,
        answered: Number(row.answered),
        correct: Number(row.correct),
        attemptId: row.id,
      })),
      ...decisions.rows.map((row): TimelineEvent => ({
        type: 'decision',
        at: row.created_at,
        subject: row.subject,
        conceptId: row.concept_id,
        conceptName: conceptName(row.subject, row.concept_id),
        kind: row.kind,
        decision: row.decision,
        reason: row.reason,
        inputs: JSON.parse(row.inputs || '{}'),
      })),
      ...runs.rows.flatMap((row): TimelineEvent[] => {
        const expected = readJson(row.expected_outcome);
        const summary = readJson(row.evidence_summary);
        const base = {
          type: 'intervention' as const,
          subject: row.subject,
          conceptId: row.concept_id,
          conceptName: conceptName(row.subject, row.concept_id) ?? row.concept_id,
          // Null means the offer and the measurement are the same concept.
          targetConceptId: row.target_concept_id ?? row.concept_id,
          targetConceptName:
            conceptName(row.subject, row.target_concept_id ?? row.concept_id)
            ?? (row.target_concept_id ?? row.concept_id),
          runId: row.run_id,
          interventionKey: row.intervention_key,
          interventionType: row.intervention_type,
          source: row.source,
          reason: row.reason,
          expected: typeof expected.baseline === 'number' && typeof expected.target === 'number'
            ? { baseline: expected.baseline, target: expected.target }
            : null,
        };

        const entries: TimelineEvent[] = [
          { ...base, at: row.started_at, phase: 'started', outcome: null, observed: null },
        ];

        if (row.completed_at) {
          entries.push({
            ...base,
            at: row.completed_at,
            phase: 'completed',
            outcome: row.outcome,
            observed: typeof summary.observed === 'number' ? summary.observed : null,
          });
        }

        return entries;
      }),
    ].sort((a, b) => parseDbTimestamp(b.at).getTime() - parseDbTimestamp(a.at).getTime());

    return Response.json({ events: events.slice(0, limit) });
  } catch (error) {
    console.error('Get child timeline error:', error);
    return Response.json({ error: 'Failed to get timeline' }, { status: 500 });
  }
}
