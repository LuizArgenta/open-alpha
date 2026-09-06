import { executeSql } from '../_lib/db.js';
import { ITEMS_PER_MASTERY_ATTEMPT as ITEMS_PER_ATTEMPT } from '../_lib/item-bank.js';
import { LlmUnavailableError, unavailableResponse } from '../_lib/llm-budget.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { DEFAULT_CONTENT_LANGUAGE, type ContentLanguage } from '../_lib/llm.js';
import { generateServableQuiz } from '../_lib/generated-quiz.js';
import { recordEvent } from '../_lib/events.js';
import { getConceptWithLesson } from '../_lib/curriculum.js';
import { drawFromAuthoredItemBank, type AttemptQuestion, openAttempt, withoutAnswerKey } from '../_lib/assessment.js';
import { expireStaleAttempts } from '../_lib/attempts.js';

interface User {
  grade_level: number | null;
}

export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const body = await request.json() as { subject: string; conceptId: string; language?: ContentLanguage };
    const { subject, conceptId } = body;
    const language = body.language ?? DEFAULT_CONTENT_LANGUAGE;

    if (!subject || !conceptId) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Serverless has nowhere to run a sweep, so it rides on the next quiz the
    // student opens: anything they abandoned is closed before a new one starts.
    await expireStaleAttempts(auth.userId);

    const userResult = await executeSql<User>(
      'SELECT grade_level FROM users WHERE id = $1',
      [auth.userId]
    );

    if (userResult.rows.length === 0 || userResult.rows[0].grade_level === null) {
      return Response.json({ error: 'Grade level not set' }, { status: 400 });
    }

    const concept = await getConceptWithLesson(subject, conceptId, language);
    if (!concept) {
      return Response.json({ error: 'Concept not found' }, { status: 400 });
    }

    /**
     * Authored and generated items compose, rather than one excluding the
     * other.
     *
     * The endpoint used to require five authored mastery items before it would
     * touch the bank at all. That made an approved contribution publish into
     * the curriculum and never reach a learner: a concept with one contributed
     * question had a pool of one, so the pool was ignored and the model wrote
     * five from scratch. `deployed` meant "in the database", not "in front of
     * a student".
     *
     * Now whatever is authored is served, and the model fills the rest. A
     * teacher's first question counts from the moment it clears review, which
     * is what makes contributing worth doing.
     */
    const authored = concept.masteryCheck?.questions;
    const eligible = authored?.filter(item => (item.purpose ?? 'mastery') === 'mastery') ?? [];
    const hasStableIds = eligible.every(item => typeof item.id === 'string' && item.id.trim().length > 0);
    const authoredCount = hasStableIds ? Math.min(eligible.length, ITEMS_PER_ATTEMPT) : 0;

    const authoredItems = authoredCount > 0
      ? await drawFromAuthoredItemBank({
          subject,
          conceptId,
          language,
          questions: authored!,
          count: authoredCount,
        })
      : [];

    if (authoredItems.length >= ITEMS_PER_ATTEMPT) {
      const { attemptId, items } = await openAttempt({
        studentId: auth.userId,
        subject,
        conceptId,
        language,
        kind: 'mastery',
        source: 'authored',
        items: authoredItems,
      });
      await recordEvent({
        studentId: auth.userId, subject, conceptId,
        type: 'quiz_start', attemptId, payload: { source: 'authored', items: items.length },
      });

      return Response.json({ attemptId, questions: items.map(withoutAnswerKey) });
    }

    // Fetch student interests for personalized quiz framing
    const interestResult = await executeSql<{ category: string; value: string }>(
      'SELECT category, value FROM user_interests WHERE user_id = $1 ORDER BY weight DESC',
      [auth.userId]
    );
    const interests = interestResult.rows.length > 0 ? interestResult.rows : undefined;

    // Get recent accuracy for adaptive difficulty targeting 80-85% success rate
    const recentResult = await executeSql<{ mastery_score: number }>(
      'SELECT mastery_score FROM progress WHERE student_id = $1 ORDER BY last_attempt_at DESC LIMIT 5',
      [auth.userId]
    );
    const recentAccuracy = recentResult.rows.length > 0
      ? Math.round(recentResult.rows.reduce((sum, p) => sum + p.mastery_score, 0) / recentResult.rows.length)
      : undefined;

    const missing = ITEMS_PER_ATTEMPT - authoredItems.length;

    /**
     * Generated questions used to reach the student with no checking at all —
     * straight from JSON.parse into the attempt. The answerability rule that
     * `curriculum-record.ts` enforces only ever ran on authored content, which
     * is 6% of the curriculum; the model's output, which is the other 94%,
     * went unchecked.
     *
     * It now checks, retries once, and distinguishes what it refuses from what
     * it repairs — see `generated-quiz.ts`. An unanswerable item refuses the
     * quiz; a missing distractor map degrades it and says so.
     */
    const generated = await generateServableQuiz({
      subject,
      conceptName: concept.name,
      gradeLevel: userResult.rows[0].grade_level,
      count: missing,
      interests,
      recentAccuracy,
      language,
    });

    if ('problems' in generated) {
      console.error('Rejected generated quiz:', generated.problems.join('; '));
      return Response.json(
        { error: 'The generated quiz did not pass validation. Please try again.' },
        { status: 502 }
      );
    }

    const questions = generated.questions;

    /**
     * Authored items arrive already stored, so `storeItem` short-circuits on
     * them and `source: 'generated'` applies only to the ones the model wrote.
     * Mixed attempts need no separate path.
     */
    const { attemptId, items } = await openAttempt({
      studentId: auth.userId,
      subject,
      conceptId,
      language,
      kind: 'mastery',
      source: 'generated',
      items: [...authoredItems, ...questions.map(question => ({ conceptId, question }))],
    });

    await recordEvent({
      studentId: auth.userId, subject, conceptId,
      type: 'quiz_start',
      attemptId,
      payload: {
        source: authoredItems.length > 0 ? 'mixed' : 'generated',
        items: items.length,
        authored: authoredItems.length,
        // Degraded is acceptable; degraded and unmeasured is not. This is the
        // denominator for "how often does generation omit pedagogical
        // metadata", and it is here rather than in a log because a log nobody
        // queries is the silent fallback with extra steps.
        generation: generated.quality,
      },
    });

    return Response.json({ attemptId, questions: items.map(withoutAnswerKey) });
  } catch (error) {
    // A refused model call is not a server fault: say which limit was hit
    // so the interface can tell a budget from an outage.
    if (error instanceof LlmUnavailableError) return unavailableResponse(error);
    console.error('Quiz generation error:', error);
    return Response.json({ error: 'Failed to generate quiz' }, { status: 500 });
  }
}
