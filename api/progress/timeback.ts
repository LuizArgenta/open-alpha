import { executeSql } from '../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { getConcept } from '../_lib/curriculum.js';
import { WALKED_AWAY_MS, rapidAnswerThresholdMs } from '../_lib/diagnosis.js';

interface FocusReason {
  code: 'rapid_guessing' | 'walked_away' | 'low_accuracy';
  /** Translation key plus values — the server does not know the reader's language. */
  detailKey: string;
  detailParams: Record<string, string | number>;
  points: number;
  contestable: boolean;
  contested: boolean;
}

interface LearningEvent {
  event_type: string;
  payload: string;
  created_at: string;
  concept_id: string;
  subject: string;
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

    // Get today's learning events
    const eventsResult = await executeSql<LearningEvent>(
      `SELECT event_type, payload, created_at, concept_id, subject
       FROM learning_events
       WHERE student_id = $1
         AND created_at >= date('now')
       ORDER BY created_at ASC`,
      [auth.userId]
    );

    const events = eventsResult.rows;

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
      conceptsStudiedToday.add(event.concept_id);

      switch (event.event_type) {
        case 'lesson_start':
          lessonStartTime = event.created_at;
          break;
        case 'lesson_end':
          if (lessonStartTime) {
            totalLessonTimeMs += new Date(event.created_at).getTime() - new Date(lessonStartTime).getTime();
            lessonStartTime = null;
          }
          break;
        case 'quiz_start':
          quizStartTime = event.created_at;
          break;
        case 'quiz_answer': {
          totalAnswers++;
          const payload = JSON.parse(event.payload || '{}');
          if (payload.correct) correctAnswers++;

          // What counts as rushed depends on the question: a two-second answer
          // is plausible for counting and not for an advanced concept.
          const threshold = rapidAnswerThresholdMs(
            getConcept(event.subject, event.concept_id)?.metadata?.difficulty
          );
          if (payload.responseTimeMs !== undefined && payload.responseTimeMs < threshold) {
            rapidGuessCount++;
          }

          // The real "walked away" signal. idle_timeout events are declared in
          // the schema but no screen emits them, so the gap between consecutive
          // answers is what actually shows a student leaving mid-quiz.
          if (
            previousAnswerAt &&
            new Date(event.created_at).getTime() - new Date(previousAnswerAt).getTime() >= WALKED_AWAY_MS
          ) {
            walkedAwayCount++;
          }
          previousAnswerAt = event.created_at;
          break;
        }
        case 'quiz_complete':
          if (quizStartTime) {
            totalQuizTimeMs += new Date(event.created_at).getTime() - new Date(quizStartTime).getTime();
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
