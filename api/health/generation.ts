/**
 * GET /api/health/generation
 *
 * How often the model omits the metadata the diagnosis reads.
 *
 * `tutor/quiz.ts` no longer refuses a quiz over a missing
 * `distractorErrorCode` — it serves the item and records the omission, because
 * trading a student's session for a telemetry field is the wrong way round in
 * a learning product. That trade is only defensible if the omission is
 * visible. A number written to a column nobody queries is the silent fallback
 * with extra steps, which is the exact defect an audit found in this project:
 * `distractor_error_code` was written by nothing and read by nothing, and 0 of
 * 45 authored questions had one.
 *
 * So this endpoint exists to make the question cheap to ask. It reports and
 * does not judge: there is no threshold here and it never answers 503, because
 * nobody has a baseline for what rate is normal yet. Producing that baseline
 * is its first job. A threshold added before the first week of data would be
 * an invented one.
 */

import { executeSql } from '../_lib/db.js';
import { isDenied, requireStaff } from '../_lib/staff.js';

const DEFAULT_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 90;

interface Totals {
  quizzes: number;
  retried: number;
  items: number;
  without_error_codes: number;
  discarded: number;
}

export async function GET(request: Request) {
  const access = await requireStaff(request, 'teacher');
  if (isDenied(access)) return access;

  const requested = Number(new URL(request.url).searchParams.get('days'));
  const days = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_WINDOW_DAYS)
    : DEFAULT_WINDOW_DAYS;

  // Only starts that actually called the model carry a `generation` object;
  // a purely authored attempt has nothing to say about generation quality and
  // must not dilute the rate.
  const totals = await executeSql<Totals>(
    `SELECT
       COUNT(*) AS quizzes,
       SUM(CASE WHEN json_extract(payload, '$.generation.attempts') > 1 THEN 1 ELSE 0 END) AS retried,
       SUM(json_extract(payload, '$.generation.items')) AS items,
       SUM(json_extract(payload, '$.generation.withoutErrorCodes')) AS without_error_codes,
       SUM(json_extract(payload, '$.generation.discarded')) AS discarded
     FROM learning_events
     WHERE event_type = 'quiz_start'
       AND json_extract(payload, '$.generation') IS NOT NULL
       AND created_at >= datetime('now', $1)`,
    [`-${days} days`]
  );

  const row = totals.rows[0];
  const quizzes = Number(row?.quizzes ?? 0);
  const items = Number(row?.items ?? 0);
  const withoutErrorCodes = Number(row?.without_error_codes ?? 0);

  return Response.json({
    windowDays: days,
    quizzes,
    /** Starts where the first draw was incomplete and a second was asked for. */
    retried: Number(row?.retried ?? 0),
    items,
    withoutErrorCodes,
    /** Of those, the ones where a map came back and was too wrong to trust. */
    discarded: Number(row?.discarded ?? 0),
    /**
     * The one number this is for: the share of generated items a learner sat
     * that cannot contribute to a misconception diagnosis. Null rather than
     * zero when nothing was generated — "no data" and "no omissions" are not
     * the same answer, and rounding them together is how a metric starts
     * lying.
     */
    withoutErrorCodesRate: items > 0 ? Number((withoutErrorCodes / items).toFixed(4)) : null,
  });
}
