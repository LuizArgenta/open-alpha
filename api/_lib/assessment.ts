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

import { executeSql, executeTransaction, withTransaction } from './db.js';
import { selectMasteryItems, snapshotItem } from './item-bank.js';

const poolSyncs = new Map<string, Promise<void>>();

async function withPoolLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = poolSyncs.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  poolSyncs.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (poolSyncs.get(key) === current) poolSyncs.delete(key);
  }
}

export interface AttemptQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  difficultyTag?: 'easy' | 'medium' | 'hard';
  purpose?: 'practice' | 'check' | 'mastery' | 'review';
  skillTag?: string;
  reasoningType?: string;
  distractorRationale?: Record<string, string>;
  distractorErrorCode?: Record<string, string>;
  pedagogicalRationale?: string;
}

export interface AttemptItem {
  /** The concept this item assesses. For a placement, items differ. */
  conceptId: string;
  question: AttemptQuestion;
  /** The curriculum's own id for an authored item, when it has one. */
  authoredId?: string;
  /** Already persisted by the item-bank sync. */
  storedItemId?: number;
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
  if (item.storedItemId !== undefined) return item.storedItemId;

  const snapshot = snapshotItem(item.question);
  const identityParams = [subject, item.conceptId, language, item.authoredId ?? null];

  const findSnapshot = async (): Promise<number | undefined> => {
    if (source !== 'authored' || !item.authoredId) return undefined;
    const existing = await executeSql<{ id: number }>(
      `SELECT id FROM assessment_items
       WHERE subject_id = $1 AND concept_id = $2 AND language = $3
         AND authored_id = $4 AND content_hash = $5`,
      [...identityParams, snapshot.contentHash]
    );
    return existing.rows[0]?.id;
  };

  const activateSnapshot = async (itemId: number): Promise<void> => {
    if (source !== 'authored' || !item.authoredId) return;
    // The order matters with the partial unique index: retire the former
    // active version before activating this exact immutable snapshot.
    await executeTransaction([
      {
        sql: `UPDATE assessment_items SET status = 'retired'
              WHERE subject_id = $1 AND concept_id = $2 AND language = $3
                AND authored_id = $4 AND id <> $5`,
        params: [...identityParams, itemId],
      },
      { sql: `UPDATE assessment_items SET status = 'active' WHERE id = $1`, params: [itemId] },
    ]);
  };

  const reusable = await findSnapshot();
  if (reusable !== undefined) {
    await activateSnapshot(reusable);
    return reusable;
  }

  // UNIQUE indexes arbitrate concurrent writers. A collision means another
  // request won either the same hash or the next version; re-read and retry.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const priorVersion = item.authoredId
      ? await executeSql<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) AS version FROM assessment_items
         WHERE subject_id = $1 AND concept_id = $2 AND language = $3 AND authored_id = $4`,
        identityParams
      )
      : { rows: [{ version: 0 }], rowCount: 1 };
    const version = Number(priorVersion.rows[0]?.version ?? 0) + 1;

    const inserted = await executeSql<{ id: number }>(
      `INSERT INTO assessment_items
         (subject_id, concept_id, language, source, authored_id, stem, options,
          correct_answer, explanation, difficulty_tag, purpose, skill_tag,
          reasoning_type, distractor_rationale, distractor_error_code,
          pedagogical_rationale, content_hash, version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT DO NOTHING RETURNING id`,
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
        snapshot.difficultyTag,
        snapshot.purpose,
        snapshot.skillTag,
        snapshot.reasoningType,
        JSON.stringify(snapshot.distractorRationale),
        JSON.stringify(snapshot.distractorErrorCode),
        snapshot.pedagogicalRationale,
        snapshot.contentHash,
        version,
        source === 'authored' ? 'retired' : 'active',
      ]
    );

    const itemId = inserted.rows[0]?.id ?? await findSnapshot();
    if (itemId !== undefined) {
      await activateSnapshot(itemId);
      return itemId;
    }
  }

  throw new Error(`Could not persist a unique snapshot for authored item ${item.authoredId}`);
}

/** Persist the complete authored pool, then draw five items for this attempt. */
export async function drawFromAuthoredItemBank(options: {
  subject: string;
  conceptId: string;
  language: string;
  questions: Array<AttemptQuestion & { id: string }>;
  random?: () => number;
}): Promise<AttemptItem[]> {
  if (options.questions.filter(item => (item.purpose ?? 'mastery') === 'mastery').length < 5) {
    throw new Error('An authored item bank needs at least five mastery items');
  }
  const key = [options.subject, options.conceptId, options.language].join('\u0000');
  return withPoolLock(key, async () => {
    const pool: AttemptItem[] = [];
    for (const { id, ...question } of options.questions) {
      const item: AttemptItem = { conceptId: options.conceptId, authoredId: id, question };
      item.storedItemId = await storeItem(options.subject, options.language, 'authored', item);
      pool.push(item);
    }
    return selectMasteryItems(pool, options.random);
  });
}

/**
 * Opens an attempt over a fixed list of items.
 *
 * `conceptId` is the concept being assessed for a mastery check, and '*' for a
 * placement, where no single concept is: the items carry their own.
 *
 * The attempt row and its item links are written as one unit. An attempt that
 * exists with only some of its links is the dangerous partial state: the score
 * divides by `COUNT(*)` over `assessment_attempt_items`, so a link that never
 * landed silently shrinks the denominator and inflates the mark. Storing the
 * items themselves stays outside the transaction on purpose — since the item
 * bank they are content-addressed snapshots, so one left behind by a failure
 * here is not garbage: it is a valid row the next request for the same content
 * finds and reuses.
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
  // An attempt with no items scores 0/0 and would tell the engine the student
  // failed a check they were never shown.
  if (options.items.length === 0) {
    throw new Error('Cannot open an attempt with no items');
  }

  const itemIds: number[] = [];
  for (const item of options.items) {
    itemIds.push(await storeItem(options.subject, options.language, options.source, item));
  }

  const attemptId = await withTransaction(async scope => {
    const attempt = await scope.run<{ id: number }>(
      `INSERT INTO assessment_attempts (student_id, subject, concept_id, language, kind)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [options.studentId, options.subject, options.conceptId, options.language, options.kind]
    );
    const id = attempt.rows[0].id;

    // The server's own record of what this attempt consists of. Without it an
    // answer could claim to belong to any attempt, or to any concept.
    for (const [position, itemId] of itemIds.entries()) {
      await scope.run(
        'INSERT INTO assessment_attempt_items (attempt_id, item_id, position) VALUES ($1, $2, $3)',
        [id, itemId, position]
      );
    }

    return id;
  });

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
