import { executeSql } from '../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { DEFAULT_CONTENT_LANGUAGE, type ContentLanguage, generateQuizQuestions } from '../_lib/llm.js';
import { getConceptWithLesson } from '../_lib/curriculum.js';

interface User {
  grade_level: number | null;
}

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
}

/**
 * Stores the questions the student is about to see and opens an attempt.
 *
 * Until now a quiz was generated, answered and thrown away: only the score
 * survived, so nobody could ever answer "which question did they miss?".
 * Authored items are reused across attempts by their curriculum id; generated
 * ones are new every time, because they are.
 */
async function openAttempt(
  studentId: number,
  subject: string,
  conceptId: string,
  language: string,
  source: 'authored' | 'generated',
  questions: QuizQuestion[],
  authoredIds: (string | undefined)[]
): Promise<{ attemptId: number; itemIds: number[] }> {
  const itemIds: number[] = [];

  for (const [index, question] of questions.entries()) {
    const authoredId = authoredIds[index];

    if (source === 'authored' && authoredId) {
      const existing = await executeSql<{ id: number }>(
        `SELECT id FROM assessment_items
         WHERE subject_id = $1 AND concept_id = $2 AND language = $3 AND authored_id = $4`,
        [subject, conceptId, language, authoredId]
      );
      if (existing.rows.length > 0) {
        itemIds.push(existing.rows[0].id);
        continue;
      }
    }

    const inserted = await executeSql<{ id: number }>(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, authored_id, stem, options, correct_answer, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        subject,
        conceptId,
        language,
        source,
        authoredId ?? null,
        question.question,
        JSON.stringify(question.options),
        question.correctAnswer,
        question.explanation ?? null,
      ]
    );
    itemIds.push(inserted.rows[0].id);
  }

  const attempt = await executeSql<{ id: number }>(
    `INSERT INTO assessment_attempts (student_id, subject, concept_id, language)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [studentId, subject, conceptId, language]
  );

  return { attemptId: attempt.rows[0].id, itemIds };
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

    // If the concept has stored mastery check questions, use them directly.
    // This avoids LLM generation costs and ensures curriculum alignment.
    if (concept.masteryCheck?.questions?.length === 5) {
      const authored = concept.masteryCheck.questions;
      const questions = authored.map(({ id: _id, ...q }) => q);
      const { attemptId, itemIds } = await openAttempt(
        auth.userId, subject, conceptId, language, 'authored',
        questions, authored.map(q => q.id)
      );
      return Response.json({
        attemptId,
        questions: questions.map((q, index) => ({ ...q, itemId: itemIds[index] })),
      });
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

    const quiz = JSON.parse(jsonStr) as { questions?: QuizQuestion[] };
    const questions = quiz.questions ?? [];

    if (questions.length === 0) {
      return Response.json({ error: 'Failed to generate quiz' }, { status: 500 });
    }

    const { attemptId, itemIds } = await openAttempt(
      auth.userId, subject, conceptId, language, 'generated',
      questions, questions.map(() => undefined)
    );

    return Response.json({
      attemptId,
      questions: questions.map((q, index) => ({ ...q, itemId: itemIds[index] })),
    });
  } catch (error) {
    console.error('Quiz generation error:', error);
    return Response.json({ error: 'Failed to generate quiz' }, { status: 500 });
  }
}
