import { executeSql } from '../_lib/db.js';
import { readEvents } from '../_lib/events.js';
import { parseDbTimestamp } from '../_lib/time.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { getConcept } from '../_lib/curriculum.js';
import { WALKED_AWAY_MS, rapidAnswerThresholdMs } from '../_lib/diagnosis.js';
import { DAILY_XP_GOAL } from '../_lib/xp.js';

interface FocusReason {
  code: 'rapid_guessing' | 'walked_away' | 'low_accuracy';
  /** Translation key plus values — the server does not know the reader's language. */
  detailKey: string;
  detailParams: Record<string, string | number>;
  points: number;
  contestable: boolean;
  contested: boolean;
}

interface ProgressRow {
  concept_id: string;
  mastery_score: number;
  attempts: number;
}

interface ConceptCount {
  total: number;
}

interface MasteredCount {
  mastered: number;
}

// GET — compute timeback & waste meter stats for today's session
export async function GET(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const url = new URL(request.url);
    const subject = url.searchParams.get('subject') || null;

    /**
     * Today's events, as envelopes.
     *
     * Read through the contract rather than off the table, which is the point
     * of having one: this loop measures the *gaps between* events to infer
     * focus, and it was measuring them between the moments rows were inserted.
     * A browser posts lesson and hint events after the fact and retries the
     * ones it drops, so a batch landing together read as a burst of activity
     * that never happened. `occurredAt` is when the student did it.
     */
    const todayStart = await executeSql<{ start: string }>(
      "SELECT datetime(date('now')) AS start"
    );
    const events = await readEvents({
      studentId: auth.userId,
      since: todayStart.rows[0].start,
    });

    // Calculate focus metrics
    let totalLessonTimeMs = 0;
    let totalQuizTimeMs = 0;
    let rapidGuessCount = 0;
    let totalAnswers = 0;
    let correctAnswers = 0;
    let hintRequests = 0;
    let idleTimeouts = 0;
    let walkedAwayCount = 0;
    let conceptsStudiedToday = new Set<string>();

    let lessonStartTime: string | null = null;
    let quizStartTime: string | null = null;
    let previousAnswerAt: string | null = null;

    for (const event of events) {
      conceptsStudiedToday.add(event.conceptId);

      switch (event.type) {
        case 'lesson_start':
          lessonStartTime = event.occurredAt;
          break;
        case 'lesson_end':
          if (lessonStartTime) {
            totalLessonTimeMs += parseDbTimestamp(event.occurredAt).getTime() - parseDbTimestamp(lessonStartTime).getTime();
            lessonStartTime = null;
          }
          break;
        case 'quiz_start':
          quizStartTime = event.occurredAt;
          break;
        case 'quiz_answer': {
          totalAnswers++;
          const payload = event.payload;
          if (payload.correct) correctAnswers++;

          // What counts as rushed depends on the question: a two-second answer
          // is plausible for counting and not for an advanced concept.
          const threshold = rapidAnswerThresholdMs(
            getConcept(event.subject, event.conceptId)?.metadata?.difficulty
          );
          // Typed as unknown by the envelope, which is what caught this: the
          // old read was `!== undefined`, and a null response time would have
          // coerced to 0 and counted as a rapid guess against the student.
          const responseTimeMs = payload.responseTimeMs;
          if (typeof responseTimeMs === 'number' && responseTimeMs < threshold) {
            rapidGuessCount++;
          }

          // The real "walked away" signal. idle_timeout events are declared in
          // the schema but no screen emits them, so the gap between consecutive
          // answers is what actually shows a student leaving mid-quiz.
          if (
            previousAnswerAt &&
            parseDbTimestamp(event.occurredAt).getTime() - parseDbTimestamp(previousAnswerAt).getTime() >= WALKED_AWAY_MS
          ) {
            walkedAwayCount++;
          }
          previousAnswerAt = event.occurredAt;
          break;
        }
        case 'quiz_complete':
          if (quizStartTime) {
            totalQuizTimeMs += parseDbTimestamp(event.occurredAt).getTime() - parseDbTimestamp(quizStartTime).getTime();
            quizStartTime = null;
          }
          break;
        case 'hint_request':
          hintRequests++;
          break;
        case 'idle_timeout':
          idleTimeouts++;
          break;
      }
    }

    // Signals the student has already pushed back on today don't count against
    // them again — otherwise "contest" would be a button that changes nothing.
    const contestsResult = await executeSql<{ pattern: string }>(
      `SELECT pattern FROM focus_contests WHERE student_id = $1 AND created_at >= date('now')`,
      [auth.userId]
    );
    const contested = new Set(contestsResult.rows.map(row => row.pattern));

    // Waste score: 0 (perfect focus) to 100 (all waste)
    const reasons: FocusReason[] = [];

    const rapidPoints = totalAnswers > 0
      ? Math.round((rapidGuessCount / totalAnswers) * 50)
      : 0;
    if (rapidGuessCount > 0) {
      reasons.push({
        code: 'rapid_guessing',
        detailKey: 'focus.reason.rapidGuessing',
        detailParams: { rapid: rapidGuessCount, total: totalAnswers },
        points: contested.has('rapid_guessing') ? 0 : rapidPoints,
        contestable: true,
        contested: contested.has('rapid_guessing'),
      });
    }

    const walkedAwayPoints = Math.min(walkedAwayCount * 10, 30);
    if (walkedAwayCount > 0) {
      reasons.push({
        code: 'walked_away',
        // The server picks the plural variant: it knows the count, and both
        // languages split at one.
        detailKey: walkedAwayCount === 1
          ? 'focus.reason.walkedAway'
          : 'focus.reason.walkedAway_plural',
        detailParams: { count: walkedAwayCount },
        points: contested.has('walked_away') ? 0 : walkedAwayPoints,
        contestable: true,
        contested: contested.has('walked_away'),
      });
    }

    // Very low accuracy suggests answering without engaging. Not contestable:
    // it is a fact about the answers, not a judgement about behaviour.
    const lowAccuracy = totalAnswers > 0 && 1 - correctAnswers / totalAnswers > 0.6;
    if (lowAccuracy) {
      reasons.push({
        code: 'low_accuracy',
        detailKey: 'focus.reason.lowAccuracy',
        detailParams: { total: totalAnswers },
        points: 20,
        contestable: false,
        contested: false,
      });
    }

    const wasteScore = Math.min(
      reasons.reduce((total, reason) => total + reason.points, 0),
      100
    );

    const focusScore = 100 - wasteScore;

    // XP earned today: what the student proved they learned, and how well
    // they worked while doing it.
    const xpResult = await executeSql<{ earned: number | null }>(
      `SELECT SUM(amount) as earned FROM xp_awards
       WHERE student_id = $1 AND created_at >= date('now')`,
      [auth.userId]
    );
    const xpEarnedToday = Number(xpResult.rows[0]?.earned ?? 0);

    // Timeback calculation: estimate how much time the student has "earned back"
    // by staying focused. Base: 2 hours of academic time per day (Alpha model).
    // Focused work earns timeback at a faster rate.
    const totalActiveTimeMs = totalLessonTimeMs + totalQuizTimeMs;
    const totalActiveMinutes = totalActiveTimeMs / 60000;
    const targetMinutes = 120; // 2-hour academic block

    // Progress toward daily completion (capped at 100%)
    const dailyProgress = Math.min(Math.round((totalActiveMinutes / targetMinutes) * 100), 100);

    // Efficiency multiplier: focused students finish faster → more free time
    const efficiencyMultiplier = focusScore >= 80 ? 1.25 : focusScore >= 60 ? 1.0 : 0.75;
    const effectiveMinutes = Math.round(totalActiveMinutes * efficiencyMultiplier);
    const timebackMinutes = Math.max(0, Math.round(targetMinutes - effectiveMinutes));

    // Subject-level mastery progress
    let subjectProgress = null;
    if (subject) {
      const totalResult = await executeSql<ConceptCount>(
        `SELECT COUNT(*) as total FROM json_each((SELECT json_group_array(json_extract(value, '$.id')) FROM json_each((SELECT concepts FROM (SELECT json_extract(content, '$.concepts') as concepts FROM generated_lessons WHERE subject_id = $1 LIMIT 1)))))`,
        [subject]
      );
      // Simpler query: count progress rows
      const masteredResult = await executeSql<MasteredCount>(
        'SELECT COUNT(*) as mastered FROM progress WHERE student_id = $1 AND subject = $2 AND mastery_score >= 80',
        [auth.userId, subject]
      );
      const totalProgressResult = await executeSql<ConceptCount>(
        'SELECT COUNT(*) as total FROM progress WHERE student_id = $1 AND subject = $2',
        [auth.userId, subject]
      );
      subjectProgress = {
        mastered: masteredResult.rows[0]?.mastered ?? 0,
        total: totalProgressResult.rows[0]?.total ?? 0,
      };
    }

    // Recent accuracy for adaptive difficulty
    const recentProgress = await executeSql<ProgressRow>(
      `SELECT concept_id, mastery_score, attempts FROM progress
       WHERE student_id = $1
       ORDER BY last_attempt_at DESC LIMIT 5`,
      [auth.userId]
    );

    const recentAccuracy = recentProgress.rows.length > 0
      ? Math.round(recentProgress.rows.reduce((sum, p) => sum + p.mastery_score, 0) / recentProgress.rows.length)
      : null;

    return Response.json({
      today: {
        totalActiveMinutes: Math.round(totalActiveMinutes),
        lessonMinutes: Math.round(totalLessonTimeMs / 60000),
        quizMinutes: Math.round(totalQuizTimeMs / 60000),
        conceptsStudied: conceptsStudiedToday.size,
        totalAnswers,
        correctAnswers,
        hintRequests,
      },
      wasteMeter: {
        score: wasteScore,
        focusScore,
        rapidGuessCount,
        idleTimeouts,
        walkedAwayCount,
        reasons,
      },
      xp: {
        earnedToday: xpEarnedToday,
        dailyGoal: DAILY_XP_GOAL,
        // The goal is evidence of learning, not minutes in the seat: a student
        // who gets there in ninety minutes has earned the rest of the day.
        goalProgress: Math.min(Math.round((xpEarnedToday / DAILY_XP_GOAL) * 100), 100),
        goalReached: xpEarnedToday >= DAILY_XP_GOAL,
      },
      timeback: {
        dailyProgress,
        targetMinutes,
        effectiveMinutes,
        timebackMinutes,
        efficiencyMultiplier,
      },
      recentAccuracy,
      subjectProgress,
    });
  } catch (error) {
    console.error('Timeback stats error:', error);
    return Response.json({ error: 'Failed to compute timeback stats' }, { status: 500 });
  }
}
