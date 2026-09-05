/**
 * GET /api/curriculum/lesson?subject=math&concept=math-fractions-intro
 *
 * Returns the full lesson content for a concept. Resolution order:
 *   1. Pre-authored content from the curriculum JSON files (always wins)
 *   2. Cached generated lesson from the database
 *   3. On-demand generation via LLM (then cached for future requests)
 *
 * This endpoint is the core of the "generate just-in-time" strategy:
 * we only need skeleton concept graphs up front — lesson content is
 * produced when the first learner arrives and cached for everyone after.
 *
 * No auth required — lesson content is a public good.
 */

import { executeSql } from '../_lib/db.js';
import { getSubject, getConcept, type Concept } from '../_lib/curriculum.js';
import {
  DEFAULT_CONTENT_LANGUAGE,
  type ContentLanguage,
  type GeneratedLessonContent,
  LESSON_PROMPT_VERSION,
  generateLesson,
  translateLesson,
} from '../_lib/llm.js';
import { validateGeneratedLesson } from '../_lib/lesson-validation.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface CachedLesson {
  content: string;
  generation_model: string;
  generation_prompt_version: number;
  created_at: string;
}

function conceptHasFullContent(concept: Concept): boolean {
  return !!(concept.explanation && concept.workedExamples?.length && concept.masteryCheck);
}

/** The curriculum JSON files are authored in English. */
const AUTHORED_LANGUAGE: ContentLanguage = 'en';

function parseLanguage(raw: string | null): ContentLanguage {
  return raw === 'en' || raw === 'pt-BR' ? raw : DEFAULT_CONTENT_LANGUAGE;
}

function authoredLesson(concept: Concept) {
  return {
    objective: concept.objective,
    explanation: concept.explanation,
    alternateExplanations: concept.alternateExplanations,
    workedExamples: concept.workedExamples,
    guidedPractice: concept.guidedPractice,
    masteryCheck: concept.masteryCheck,
    remediationPath: concept.remediationPath,
    whyItMatters: concept.whyItMatters,
  };
}

export async function GET(request: Request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(request.url);
    const subjectId = url.searchParams.get('subject');
    const conceptId = url.searchParams.get('concept');
    const language = parseLanguage(url.searchParams.get('lang'));

    if (!subjectId || !conceptId) {
      return Response.json(
        { error: 'subject and concept query parameters are required' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const subject = getSubject(subjectId);
    if (!subject) {
      return Response.json(
        { error: `Subject '${subjectId}' not found` },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    const concept = getConcept(subjectId, conceptId);
    if (!concept) {
      return Response.json(
        { error: `Concept '${conceptId}' not found in subject '${subjectId}'` },
        { status: 404, headers: CORS_HEADERS }
      );
    }

    // 1. Authored content, when the reader's language is the one it was written in
    if (conceptHasFullContent(concept) && language === AUTHORED_LANGUAGE) {
      return Response.json(
        {
          source: 'authored',
          concept: {
            id: concept.id,
            name: concept.name,
            description: concept.description,
            level: concept.gradeLevel,
          },
          language,
          lesson: authoredLesson(concept),
        },
        { headers: CORS_HEADERS }
      );
    }

    // 2. Check for a cached generated lesson in the database
    const cached = await executeSql<CachedLesson>(
      `SELECT content, generation_model, generation_prompt_version, created_at
       FROM generated_lessons WHERE subject_id = $1 AND concept_id = $2 AND language = $3`,
      [subjectId, conceptId, language]
    );

    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      const lesson = JSON.parse(row.content) as GeneratedLessonContent;
      return Response.json(
        {
          source: 'cached',
          language,
          generatedAt: row.created_at,
          promptVersion: row.generation_prompt_version,
          concept: {
            id: concept.id,
            name: concept.name,
            description: concept.description,
            level: concept.gradeLevel,
          },
          lesson,
        },
        { headers: CORS_HEADERS }
      );
    }

    // 3. Generate on-demand
    const prerequisiteNames = concept.prerequisites.map(pid => {
      const prereq = getConcept(subjectId, pid);
      return prereq ? prereq.name : pid;
    });

    const model = 'claude-sonnet-4-6';

    // Authored content in another language is translated rather than rewritten:
    // the examples and their order were chosen deliberately by a human.
    const translatingAuthoredContent = conceptHasFullContent(concept);

    const generationContext = {
      subjectName: subject.name,
      conceptId: concept.id,
      conceptName: concept.name,
      conceptDescription: concept.description,
      level: concept.gradeLevel,
      prerequisites: prerequisiteNames,
      gradeBand: concept.metadata?.gradeBand,
      language,
    };

    // Captured out here because attemptGeneration is hoisted, which costs the
    // narrowing of `concept` inside it.
    const authoredSource = authoredLesson(concept) as GeneratedLessonContent;

    async function attemptGeneration(correctionFeedback?: string) {
      try {
        const lesson = translatingAuthoredContent
          ? await translateLesson(authoredSource, language, model)
          : await generateLesson({ ...generationContext, correctionFeedback }, model);
        return { lesson, problems: validateGeneratedLesson(lesson).problems };
      } catch (error) {
        // Malformed JSON — usually a truncated response
        return {
          lesson: null,
          problems: [error instanceof Error ? error.message : 'response was not valid JSON'],
        };
      }
    }

    let attempt = await attemptGeneration();
    if (attempt.problems.length > 0) {
      console.warn(
        `Lesson generation for ${subjectId}/${conceptId} rejected: ${attempt.problems.join('; ')}`
      );
      attempt = await attemptGeneration(attempt.problems.join('\n'));
    }

    if (!attempt.lesson) {
      console.error(
        `Lesson generation for ${subjectId}/${conceptId} failed twice: ${attempt.problems.join('; ')}`
      );
      return Response.json(
        { error: 'Failed to fetch or generate lesson content' },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const lesson = attempt.lesson;
    const passedValidation = attempt.problems.length === 0;

    // Only cache what passed. A generated lesson is written once and served to
    // everyone who reaches this concept, so caching a bad bundle makes it the
    // lesson indefinitely; serving it uncached lets the next request retry.
    if (passedValidation) {
      await executeSql(
        `INSERT INTO generated_lessons (subject_id, concept_id, language, content, generation_model, generation_prompt_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(subject_id, concept_id, language) DO UPDATE SET
           content = EXCLUDED.content,
           generation_model = EXCLUDED.generation_model,
           generation_prompt_version = EXCLUDED.generation_prompt_version,
           updated_at = datetime('now')`,
        [subjectId, conceptId, language, JSON.stringify(lesson), model, LESSON_PROMPT_VERSION]
      );
    } else {
      console.warn(
        `Serving unvalidated lesson for ${subjectId}/${conceptId} without caching: ${attempt.problems.join('; ')}`
      );
    }

    return Response.json(
      {
        source: passedValidation ? 'generated' : 'generated_unvalidated',
        language,
        generatedAt: new Date().toISOString(),
        promptVersion: LESSON_PROMPT_VERSION,
        concept: {
          id: concept.id,
          name: concept.name,
          description: concept.description,
          level: concept.gradeLevel,
        },
        lesson,
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error('Lesson fetch/generate error:', error);
    return Response.json(
      { error: 'Failed to fetch or generate lesson content' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export function OPTIONS(_request: Request) {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
