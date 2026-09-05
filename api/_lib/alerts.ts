/**
 * Turns a student's progress rows into things an adult can act on.
 *
 * A dashboard of percentages tells a parent how much was covered, not where
 * to step in. These alerts name a specific concept and say what the engine
 * already did about it, so the conversation starts from something concrete.
 */

const STUCK_ATTEMPTS = 3;
const MASTERY_THRESHOLD = 80;
const INACTIVE_DAYS = 7;
const MAX_STUCK_ALERTS = 3;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface AlertProgressRow {
  subject: string;
  subjectName: string;
  conceptId: string;
  conceptName: string;
  masteryScore: number;
  attempts: number;
  nextReviewAt: string | null;
  reviewIntervalDays: number | null;
}

export interface StudentAlert {
  code: 'stuck' | 'retention_drop' | 'reviews_overdue' | 'inactive';
  severity: 'high' | 'medium' | 'low';
  /**
   * Translation keys plus values. Where a message has a plural form, the
   * server picks the variant — it knows the count, and both languages split
   * at one.
   */
  titleKey: string;
  titleParams?: Record<string, string | number>;
  detailKey: string;
  detailParams?: Record<string, string | number>;
  subject?: string;
  conceptId?: string;
  conceptName?: string;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function daysBetween(from: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(from).getTime()) / MS_PER_DAY);
}

export function buildAlerts(
  rows: AlertProgressRow[],
  lastActiveAt: string | null,
  now: Date = new Date()
): StudentAlert[] {
  const alerts: StudentAlert[] = [];

  const stuck = rows
    .filter(row => row.attempts >= STUCK_ATTEMPTS && row.masteryScore < MASTERY_THRESHOLD)
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, MAX_STUCK_ALERTS);

  for (const row of stuck) {
    alerts.push({
      code: 'stuck',
      severity: 'high',
      titleKey: 'alert.stuck.title',
      titleParams: { concept: row.conceptName },
      detailKey: 'alert.stuck.detail',
      detailParams: { attempts: row.attempts, score: row.masteryScore },
      subject: row.subject,
      conceptId: row.conceptId,
      conceptName: row.conceptName,
    });
  }

  // Mastered, then knocked back to the first review rung: the concept was
  // learned and did not survive the gap.
  const lapsed = rows.filter(
    row =>
      row.masteryScore >= MASTERY_THRESHOLD &&
      row.attempts >= 2 &&
      row.reviewIntervalDays === 1
  );

  for (const row of lapsed.slice(0, MAX_STUCK_ALERTS)) {
    alerts.push({
      code: 'retention_drop',
      severity: 'medium',
      titleKey: 'alert.retentionDrop.title',
      titleParams: { concept: row.conceptName },
      detailKey: 'alert.retentionDrop.detail',
      subject: row.subject,
      conceptId: row.conceptId,
      conceptName: row.conceptName,
    });
  }

  const overdue = rows.filter(
    row => row.nextReviewAt !== null && new Date(row.nextReviewAt).getTime() <= now.getTime()
  );

  if (overdue.length > 0) {
    const oldest = overdue.reduce((worst, row) =>
      new Date(row.nextReviewAt!).getTime() < new Date(worst.nextReviewAt!).getTime() ? row : worst
    );
    const oldestDays = daysBetween(oldest.nextReviewAt!, now);

    alerts.push({
      code: 'reviews_overdue',
      severity: overdue.length >= 3 ? 'medium' : 'low',
      titleKey: overdue.length === 1
        ? 'alert.reviewsOverdue.title'
        : 'alert.reviewsOverdue.title_plural',
      titleParams: { count: overdue.length },
      detailKey: oldestDays < 1
        ? 'alert.reviewsOverdue.detailToday'
        : oldestDays === 1
          ? 'alert.reviewsOverdue.detail'
          : 'alert.reviewsOverdue.detail_plural',
      detailParams: { days: oldestDays, concept: oldest.conceptName },
    });
  }

  const inactiveDays = lastActiveAt ? daysBetween(lastActiveAt, now) : null;
  if (inactiveDays === null || inactiveDays >= INACTIVE_DAYS) {
    alerts.push({
      code: 'inactive',
      severity: 'medium',
      titleKey: inactiveDays === null ? 'alert.neverStarted.title' : 'alert.inactive.title',
      titleParams: inactiveDays === null ? undefined : { days: inactiveDays },
      detailKey: inactiveDays === null ? 'alert.neverStarted.detail' : 'alert.inactive.detail',
    });
  }

  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
