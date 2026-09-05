/**
 * Opening an attempt: the record of which questions a student was shown.
 *
 * Extracted from the quiz endpoint so the placement probe uses the same
 * machinery. It used to have its own: the probe was rebuilt from the
 * curriculum on submission and answers were matched to it by position, while
 * the concept each answer counted for came from the client. A student could
 * answer the easiest item and label it with the hardest concept, and be placed
 * above the gap they still had. The same hole PR #20 closed for the quiz,
 * still open next door.
 */

import { executeSql } from './db.js';

export interface AttemptQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
}

export interface AttemptItem {
  /** The concept this item assesses. For a placement, items differ. */
  conceptId: string;
  question: AttemptQuestion;
  /** The curriculum's own id for an authored item, when it has one. */
  authoredId?: string;
}

export interface OpenedAttempt {
  attemptId: number;
  /** In the order the student will see them. */
  items: { itemId: number; conceptId: string; question: AttemptQuestion }[];
}

/**
 * Stores an item, reusing the stored copy of an authored one.
 *
 * Authored items are reused across attempts by their curriculum id; generated
 * ones are new every time, because they are.
 */
async function storeItem(
  subject: string,
  language: string,
  source: 'authored' | 'generated',
  item: AttemptItem
): Promise<number> {
  if (source === 'authored' && item.authoredId) {
    const existing = await executeSql<{ id: number }>(
      `SELECT id FROM assessment_items
       WHERE subject_id = $1 AND concept_id = $2 AND language = $3 AND authored_id = $4`,
      [subject, item.conceptId, language, item.authoredId]
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
  }

  const inserted = await executeSql<{ id: number }>(
    `INSERT INTO assessment_items
       (subject_id, concept_id, language, source, authored_id, stem, options, correct_answer, explanation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      subject,
      item.conceptId,
      language,
      source,
      item.authoredId ?? null,
      item.question.question,
      JSON.stringify(item.question.options),
      item.question.correctAnswer,
      item.question.explanation ?? null,
    ]
  );
  return inserted.rows[0].id;
}

/**
 * Opens an attempt over a fixed list of items.
 *
 * `conceptId` is the concept being assessed for a mastery check, and '*' for a
 * placement, where no single concept is: the items carry their own.
 */
export async function openAttempt(options: {
  studentId: number;
  subject: string;
  conceptId: string;
  language: string;
  kind: 'mastery' | 'placement';
  source: 'authored' | 'generated';
  items: AttemptItem[];
}): Promise<OpenedAttempt> {
  const itemIds: number[] = [];
  for (const item of options.items) {
    itemIds.push(await storeItem(options.subject, options.language, options.source, item));
  }

  const attempt = await executeSql<{ id: number }>(
    `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, kind)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [options.studentId, options.subject, options.conceptId, options.language, options.kind]
  );
  const attemptId = attempt.rows[0].id;

  // The server's own record of what this attempt consists of. Without it an
  // answer could claim to belong to any attempt, or to any concept.
  for (const [position, itemId] of itemIds.entries()) {
    await executeSql(
      'INSERT INTO assessment_attempt_items (attempt_id, item_id, position) VALUES ($1, $2, $3)',
      [attemptId, itemId, position]
    );
  }

  return {
    attemptId,
    items: options.items.map((item, index) => ({
      itemId: itemIds[index],
      conceptId: item.conceptId,
      question: item.question,
    })),
  };
}

/** What the student may see: the question and its options, never the answer. */
export function withoutAnswerKey(item: { itemId: number; conceptId: string; question: AttemptQuestion }) {
  return {
    itemId: item.itemId,
    conceptId: item.conceptId,
    question: item.question.question,
    options: item.question.options,
  };
}
