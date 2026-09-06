import { executeSql } from '../_lib/db.js';
import { LlmUnavailableError, unavailableResponse } from '../_lib/llm-budget.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { DEFAULT_CONTENT_LANGUAGE, type ContentLanguage, generateQuizQuestions } from '../_lib/llm.js';
import { questionProblem } from '../_lib/curriculum-record.js';
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

    // Authored mastery checks are item pools: persist every item, then draw the
    // five that form this attempt. More adaptive selection belongs to item 20.
    const authored = concept.masteryCheck?.questions;
    const masteryItemCount = authored?.filter(item => (item.purpose ?? 'mastery') === 'mastery').length ?? 0;
    const hasStableIds = authored?.every(item => typeof item.id === 'string' && item.id.trim().length > 0) ?? false;
    if (masteryItemCount >= 5 && hasStableIds) {
      const selected = await drawFromAuthoredItemBank({
        subject,
        conceptId,
        language,
        questions: authored!,
      });
      const { attemptId, items } = await openAttempt({
        studentId: auth.userId,
        subject,
        conceptId,
        language,
        kind: 'mastery',
        source: 'authored',
        items: selected,
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

    const quizJson = await generateQuizQuestions(
      subject,
      concept.name,
      userResult.rows[0].grade_level,
      5,
      interests,
      recentAccuracy,
      language
    );

    // Extract JSON from markdown code blocks if present
    let jsonStr = quizJson;
    const jsonMatch = quizJson.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const quiz = JSON.parse(jsonStr) as { questions?: AttemptQuestion[] };
    const questions = quiz.questions ?? [];

    if (questions.length === 0) {
      return Response.json({ error: 'Failed to generate quiz' }, { status: 500 });
    }

    /**
     * Generated questions used to reach the student with no checking at all —
     * straight from JSON.parse into the attempt. The answerability rule that
     * `curriculum-record.ts` enforces only ever ran on authored content, which
     * is 6% of the curriculum; the model's output, which is the other 94%,
     * went unchecked.
     *
     * An item whose correctAnswer matches none of its options is failed by
     * every student forever, and the engine reads that as a knowledge gap and
     * sends them back to a prerequisite they already know. Refusing the quiz
     * is worse than serving a good one and better than serving that.
     */
    const rejected = questions
      .map((question, index) => questionProblem(
        question as unknown as Record<string, unknown>,
        `generated[${index}]`
      ))
      .filter((problem): problem is string => problem !== undefined);

    if (rejected.length > 0) {
      console.error('Rejected generated quiz:', rejected.join('; '));
      return Response.json(
        { error: 'The generated quiz did not pass validation. Please try again.' },
        { status: 502 }
      );
    }

    const { attemptId, items } = await openAttempt({
      studentId: auth.userId,
      subject,
      conceptId,
      language,
      kind: 'mastery',
      source: 'generated',
      items: questions.map(question => ({ conceptId, question })),
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
