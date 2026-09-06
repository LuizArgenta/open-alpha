/**
 * assessment_responses' UNIQUE(attempt_id, item_id) constraint exists in the
 * fresh-install CREATE TABLE, but a database whose table predates it (created
 * before PR #20) had that constraint recreated with `CREATE TABLE IF NOT
 * EXISTS`, which no-ops on an existing table — so a migrated install kept
 * accepting two responses to the same item on the same attempt, forever,
 * while a fresh one never could. This guards that a migrated database ends
 * up structurally equivalent to a fresh one, dirty data included.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { resetDatabase } from './helpers/database.js';

interface IndexListRow {
  name: string;
  unique: number;
}

async function hasUniqueIndex(): Promise<boolean> {
  const result = await executeSql<IndexListRow>('PRAGMA index_list(assessment_responses)');
  return result.rows.some(row => Number(row.unique) === 1);
}

/** A real attempt row, since assessment_responses.attempt_id is a foreign key. */
async function createAttempt(): Promise<number> {
  const result = await executeSql<{ id: number }>(
    "INSERT INTO assessment_attempts (subject, concept_id) VALUES ('math', 'probe') RETURNING id"
  );
  return result.rows[0].id;
}

/** A real item row, since assessment_responses.item_id is a foreign key. */
async function createItem(): Promise<number> {
  const result = await executeSql<{ id: number }>(
    `INSERT INTO assessment_items (subject_id, concept_id, source, stem, options, correct_answer)
     VALUES ('math', 'probe', 'authored', 'stem', '[]', 'A') RETURNING id`
  );
  return result.rows[0].id;
}

async function recreateTableWithoutUniqueConstraint(): Promise<void> {
  // Exactly the pre-PR-#20 shape: reachable today only via CREATE TABLE IF
  // NOT EXISTS on an install old enough to already have this table.
  await executeSql('DROP TABLE assessment_responses');
  await executeSql(`CREATE TABLE assessment_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER REFERENCES assessment_attempts(id),
    item_id INTEGER REFERENCES assessment_items(id),
    chosen TEXT,
    correct INTEGER NOT NULL,
    response_ms INTEGER,
    answered_at TEXT DEFAULT (datetime('now'))
  )`);
}

beforeEach(async () => {
  await resetDatabase();
});

describe('assessment_responses schema equivalence', () => {
  it('a fresh install already enforces one response per attempt and item', async () => {
    expect(await hasUniqueIndex()).toBe(true);

    const attemptId = await createAttempt();
    const itemId = await createItem();

    await executeSql(
      'INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES ($1, $2, $3, $4)',
      [attemptId, itemId, 'A', 1]
    );
    await expect(
      executeSql(
        'INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES ($1, $2, $3, $4)',
        [attemptId, itemId, 'B', 0]
      )
    ).rejects.toThrow();
  });

  it('repairs a database whose table predates the constraint, deduping existing rows', async () => {
    const duplicatedAttempt = await createAttempt();
    const duplicatedItem = await createItem();
    const untouchedAttempt = await createAttempt();
    const untouchedItem = await createItem();

    await recreateTableWithoutUniqueConstraint();
    expect(await hasUniqueIndex()).toBe(false);

    // Dirty data the missing constraint let through: two responses for the
    // same (attempt, item), plus an unrelated legitimate row.
    await executeSql(
      'INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES ($1, $2, $3, 1)',
      [duplicatedAttempt, duplicatedItem, 'A']
    );
    await executeSql(
      'INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES ($1, $2, $3, 0)',
      [duplicatedAttempt, duplicatedItem, 'B']
    );
    await executeSql(
      'INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES ($1, $2, $3, 1)',
      [untouchedAttempt, untouchedItem, 'C']
    );

    await initializeSchema();

    expect(await hasUniqueIndex()).toBe(true);

    const forRepairedPair = await executeSql<{ id: number; chosen: string }>(
      'SELECT id, chosen FROM assessment_responses WHERE attempt_id = $1 AND item_id = $2',
      [duplicatedAttempt, duplicatedItem]
    );
    // The earlier of the two duplicates survives — the one that was actually
    // graded and returned to the student first.
    expect(forRepairedPair.rows).toHaveLength(1);
    expect(forRepairedPair.rows[0].chosen).toBe('A');

    const untouched = await executeSql<{ chosen: string }>(
      'SELECT chosen FROM assessment_responses WHERE attempt_id = $1 AND item_id = $2',
      [untouchedAttempt, untouchedItem]
    );
    expect(untouched.rows).toHaveLength(1);
    expect(untouched.rows[0].chosen).toBe('C');

    await expect(
      executeSql(
        'INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES ($1, $2, $3, 0)',
        [duplicatedAttempt, duplicatedItem, 'D']
      )
    ).rejects.toThrow();
  });

  it('leaves rows with a null attempt or item alone rather than merging them', async () => {
    await recreateTableWithoutUniqueConstraint();
    await executeSql(
      "INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES (NULL, NULL, 'A', 1)"
    );
    await executeSql(
      "INSERT INTO assessment_responses (attempt_id, item_id, chosen, correct) VALUES (NULL, NULL, 'B', 0)"
    );

    await initializeSchema();

    const rows = await executeSql('SELECT id FROM assessment_responses WHERE attempt_id IS NULL');
    expect(rows.rows).toHaveLength(2);
  });

  it('running the repair again on an already-repaired database is a no-op', async () => {
    await initializeSchema();
    await initializeSchema();
    expect(await hasUniqueIndex()).toBe(true);
  });
});
