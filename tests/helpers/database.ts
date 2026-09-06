/**
 * One cleanup order for every test file.
 *
 * Each file used to keep its own hand-written list, so adding a table that
 * references users broke unrelated suites with a foreign key error — three
 * times, which is twice more than a pattern needs to prove itself.
 */

import { executeSql, initializeSchema } from '../../api/_lib/db.js';

/** Children before parents: anything referencing users is deleted first. */
const TABLES_IN_DEPENDENCY_ORDER = [
  'assessment_responses',
  'assessment_attempt_items',
  // Before assessment_attempts: an XP award now names the attempt that earned
  // it, so clearing attempts first trips the foreign key.
  'xp_awards',
  'assessment_attempts',
  'assessment_items',
  'learning_decisions',
  'learning_events',
  'focus_contests',
  'progress',
  'sessions',
  'user_interests',
  'parent_links',
  'staff_roles',
  'users',
  // Cleared too, so a run never inherits a curriculum imported by an earlier
  // one: every test file loads the curriculum when it imports curriculum.js,
  // and leftovers there change what the engine reads.
  'curriculum_concepts',
  'curriculum_subjects',
];

export async function resetDatabase(): Promise<void> {
  await initializeSchema();
  for (const table of TABLES_IN_DEPENDENCY_ORDER) {
    await executeSql(`DELETE FROM ${table}`);
  }
}

export async function createUser(
  role: 'student' | 'parent',
  gradeLevel: number | null = 4
): Promise<number> {
  const row = await executeSql<{ id: number }>(
    `INSERT INTO users (email, password_hash, role, grade_level)
     VALUES ($1, 'hash', $2, $3) RETURNING id`,
    [`${role}-${Date.now()}-${Math.random()}@example.test`, role, gradeLevel]
  );
  return row.rows[0].id;
}

export async function linkParentToChild(parentId: number, childId: number): Promise<void> {
  await executeSql(
    `INSERT INTO parent_links (parent_id, student_id, invite_code, linked_at)
     VALUES ($1, $2, $3, datetime('now'))`,
    [parentId, childId, `code-${Math.random()}`]
  );
}

/** Calls an endpoint handler as a signed-in user. */
export function callAs(
  token: string,
  handler: (request: Request) => Promise<Response>,
  body: unknown
): Promise<Response> {
  return handler(new Request('https://test.local/api', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export interface OpenQuiz {
  attemptId: number;
  questions: { itemId: number }[];
}

/** Opens an attempt without answering it, for tests about what happens next. */
export async function openQuiz(
  token: string,
  subject: string,
  conceptId: string
): Promise<OpenQuiz> {
  const { POST: buildQuiz } = await import('../../api/tutor/quiz.js');
  return (await callAs(token, buildQuiz, { subject, conceptId })).json() as Promise<OpenQuiz>;
}

/** The stored answer key, which only the server is supposed to know. */
export async function answerKey(itemId: number): Promise<string> {
  const key = await executeSql<{ correct_answer: string }>(
    'SELECT correct_answer FROM assessment_items WHERE id = $1',
    [itemId]
  );
  return key.rows[0].correct_answer;
}

/**
 * Sits a real quiz: opens an attempt, answers through the grading endpoint and
 * submits. Tests used to post a score directly, which is exactly the hole the
 * integrity work closed — so they now have to earn the score they assert on.
 */
export async function takeQuiz(
  token: string,
  subject: string,
  conceptId: string,
  correctAnswers: number,
  /** Client-reported pace, which is what the focus signals read. */
  responseTimeMs?: number
): Promise<any> {
  const { POST: answerQuiz } = await import('../../api/tutor/quiz/answer.js');
  const { POST: submitQuiz } = await import('../../api/tutor/quiz/submit.js');

  const quiz = await openQuiz(token, subject, conceptId);

  for (const [index, question] of quiz.questions.entries()) {
    const right = await answerKey(question.itemId);
    const chosen = index < correctAnswers
      ? right
      : ['A', 'B', 'C', 'D'].find(letter => letter !== right)!;

    await callAs(token, answerQuiz, {
      attemptId: quiz.attemptId,
      itemId: question.itemId,
      chosen,
      responseTimeMs,
    });
  }

  return (await callAs(token, submitQuiz, { attemptId: quiz.attemptId })).json();
}
