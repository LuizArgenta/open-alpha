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
  'assessment_attempts',
  'assessment_items',
  'learning_decisions',
  'xp_awards',
  'learning_events',
  'focus_contests',
  'progress',
  'sessions',
  'user_interests',
  'parent_links',
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
