/**
 * A data notice that quietly falls out of date is worse than none: it is a
 * promise nobody is keeping, and the person it was written for has no way to
 * tell. So it is checked against the schema rather than trusted.
 *
 * Adding a table to the database fails these tests until it is either
 * described in the notice or declared to hold nothing about a person. That
 * decision is cheap to make while adding the table and nearly impossible to
 * reconstruct a year later.
 */

import { describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { WHAT_IS_STORED } from '../frontend/src/pages/stored-data.js';

/**
 * Tables that hold nothing about an identifiable person: curriculum content,
 * machinery, and aggregate accounting.
 *
 * `llm_usage` is here deliberately — it records what a model call cost, with
 * no user id, precisely so that spending can be capped without building a log
 * of who asked what and when.
 */
const HOLDS_NOTHING_ABOUT_A_PERSON = [
  '_schema_migrations',
  'assessment_attempt_items',
  'assessment_items',
  'contribution_reviews',
  'contributor_reputation',
  'contributions',
  'curriculum_concepts',
  'curriculum_subjects',
  'generated_lessons',
  'llm_usage',
  'oauth_pkce',
  'staff_roles',
];

async function tablesInSchema(): Promise<string[]> {
  await initializeSchema();
  const result = await executeSql<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return result.rows.map(row => row.name);
}

describe('the data notice matches what is actually stored', () => {
  it('accounts for every table in the schema', async () => {
    const described = WHAT_IS_STORED.map(entry => entry.table);
    const unaccounted = (await tablesInSchema()).filter(
      table => !described.includes(table) && !HOLDS_NOTHING_ABOUT_A_PERSON.includes(table)
    );

    // A new table is a decision: does it hold something about a person? If it
    // does, describe it in DataNotice.tsx. If it does not, say so above.
    expect(unaccounted).toEqual([]);
  });

  it('describes only tables that exist', async () => {
    const schema = await tablesInSchema();
    const phantom = WHAT_IS_STORED.filter(entry => !schema.includes(entry.table));

    // Describing a table that was removed is the same failure in the other
    // direction: the notice claims something untrue about the system.
    expect(phantom.map(entry => entry.table)).toEqual([]);
  });

  it('does not classify a table as both personal and impersonal', () => {
    const described = WHAT_IS_STORED.map(entry => entry.table);
    expect(described.filter(table => HOLDS_NOTHING_ABOUT_A_PERSON.includes(table))).toEqual([]);
  });

  it('says what is kept and why, for every entry', () => {
    for (const entry of WHAT_IS_STORED) {
      expect(entry.what.length, `${entry.table} needs a "what"`).toBeGreaterThan(20);
      expect(entry.why.length, `${entry.table} needs a "why"`).toBeGreaterThan(20);
    }
  });

  it('names the things a person would most want to know are recorded', () => {
    const described = WHAT_IS_STORED.map(entry => entry.table);

    // Conversations with the tutor, the judgements the engine forms about the
    // learner, and their disagreement with those judgements. These are the
    // entries a notice is most tempting to leave vague.
    expect(described).toContain('sessions');
    expect(described).toContain('learning_decisions');
    expect(described).toContain('focus_contests');
  });
});
