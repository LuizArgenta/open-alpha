/**
 * GET /api/parent/children/{childId}/timeline
 *
 * What happened, in order: what the child was asked, how they answered, and
 * what the engine decided about it. This is the first consumer of the
 * evidence layer — before it, all of that was written and never read.
 */

import { executeSql } from '../../../_lib/db.js';
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
    };

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
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return Response.json({ events: events.slice(0, limit) });
  } catch (error) {
    console.error('Get child timeline error:', error);
    return Response.json({ error: 'Failed to get timeline' }, { status: 500 });
  }
}
