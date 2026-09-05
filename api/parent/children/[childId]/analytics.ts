import { executeSql } from '../../../_lib/db.js';
import { childIdFromPath, isDenied, requireLinkedChild } from '../../../_lib/guardian.js';
import { subjects } from '../../../_lib/curriculum.js';
import { type AlertProgressRow, buildAlerts } from '../../../_lib/alerts.js';

export async function GET(request: Request) {
  try {
    const access = await requireLinkedChild(request, childIdFromPath(request));
    if (isDenied(access)) return access;
    const childId = access.childId;



    const activityResult = await executeSql<{
      session_type: string;
      subject: string | null;
      concept_id: string | null;
      updated_at: string;
    }>(
      `SELECT session_type, subject, concept_id, updated_at
       FROM sessions
       WHERE user_id = $1 AND updated_at >= datetime('now', '-7 days')
       ORDER BY updated_at DESC
       LIMIT 10`,
      [childId]
    );

    const strugglingResult = await executeSql<{
      subject: string;
      concept_id: string;
      mastery_score: number;
      attempts: number;
      last_attempt_at: string;
    }>(
      `SELECT subject, concept_id, mastery_score, attempts, last_attempt_at
       FROM progress
       WHERE student_id = $1 AND mastery_score < 80 AND attempts >= 2
       ORDER BY attempts DESC, mastery_score ASC
       LIMIT 5`,
      [childId]
    );

    const progressResult = await executeSql<{
      subject: string;
      concept_id: string;
      mastery_score: number;
      attempts: number;
      next_review_at: string | null;
      review_interval_days: number | null;
    }>(
      'SELECT subject, concept_id, mastery_score, attempts, next_review_at, review_interval_days FROM progress WHERE student_id = $1',
      [childId]
    );

    const recommendations: Array<{
      type: 'continue' | 'review' | 'start';
      subject: string;
      conceptId: string;
      conceptName: string;
      reason: string;
    }> = [];

    const inProgress = progressResult.rows.filter(p => p.mastery_score > 0 && p.mastery_score < 80);
    for (const p of inProgress.slice(0, 2)) {
      const subject = subjects.find(s => s.id === p.subject);
      const concept = subject?.concepts.find(c => c.id === p.concept_id);
      if (concept) {
        recommendations.push({
          type: 'continue',
          subject: p.subject,
          conceptId: p.concept_id,
          conceptName: concept.name,
          reason: `${p.mastery_score}% mastery - almost there!`,
        });
      }
    }

    const startedSubjects = new Set(progressResult.rows.map(p => p.subject));
    for (const subject of subjects) {
      if (!startedSubjects.has(subject.id) && recommendations.length < 3) {
        const firstConcept = subject.concepts[0];
        recommendations.push({
          type: 'start',
          subject: subject.id,
          conceptId: firstConcept.id,
          conceptName: firstConcept.name,
          reason: `Start learning ${subject.name}`,
        });
      }
    }

    const lastActiveResult = await executeSql<{ updated_at: string }>(
      'SELECT MAX(updated_at) as updated_at FROM sessions WHERE user_id = $1',
      [childId]
    );

    const lastActive = lastActiveResult.rows[0]?.updated_at || null;

    const alertRows: AlertProgressRow[] = progressResult.rows.map(row => {
      const subject = subjects.find(s => s.id === row.subject);
      const concept = subject?.concepts.find(c => c.id === row.concept_id);
      return {
        subject: row.subject,
        subjectName: subject?.name || row.subject,
        conceptId: row.concept_id,
        conceptName: concept?.name || row.concept_id,
        masteryScore: row.mastery_score,
        attempts: row.attempts,
        nextReviewAt: row.next_review_at,
        reviewIntervalDays: row.review_interval_days,
      };
    });

    return Response.json({
      lastActive,
      alerts: buildAlerts(alertRows, lastActive),
      recentActivity: activityResult.rows,
      struggling: strugglingResult.rows.map(s => {
        const subject = subjects.find(sub => sub.id === s.subject);
        const concept = subject?.concepts.find(c => c.id === s.concept_id);
        return {
          ...s,
          conceptName: concept?.name || s.concept_id,
          subjectName: subject?.name || s.subject,
        };
      }),
      recommendations,
    });
  } catch (error) {
    console.error('Get child analytics error:', error);
    return Response.json({ error: 'Failed to get child analytics' }, { status: 500 });
  }
}
