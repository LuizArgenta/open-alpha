/**
 * generated_lessons had to be rebuilt to allow one row per language, because
 * SQLite cannot drop the table-level UNIQUE constraint that stood in the way.
 * A rebuild that silently drops rows would throw away every lesson the
 * platform has ever generated, so it is checked against the real old shape.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql, initializeSchema } from '../api/_lib/db.js';
import { forgetMigration } from './helpers/database.js';

const OLD_SHAPE = `
  CREATE TABLE generated_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    content TEXT NOT NULL,
    generation_model TEXT,
    generation_prompt_version INTEGER DEFAULT 1,
    feedback_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(subject_id, concept_id)
  )
`;

async function columnNames(): Promise<string[]> {
  const info = await executeSql<{ name: string }>('PRAGMA table_info(generated_lessons)');
  return info.rows.map(row => row.name);
}

beforeEach(async () => {
  // Start from a fully migrated database, then rewind it: putting the table
  // back in its pre-language shape also means dropping the record of the
  // migration that changed it, since an install still carrying the old shape
  // would not have that record either.
  await initializeSchema();
  await executeSql('DROP TABLE IF EXISTS generated_lessons');
  await forgetMigration('001-legacy-columns-and-tables');
  await forgetMigration('003-generated-lessons-per-language');
});

describe('per-language lesson cache migration', () => {
  it('keeps existing lessons and marks them as the language they were written in', async () => {
    await executeSql(OLD_SHAPE);
    await executeSql(
      `INSERT INTO generated_lessons (subject_id, concept_id, content, generation_model)
       VALUES ('math', 'math-decimals', '{"objective":"old"}', 'claude-sonnet-4-6')`
    );

    await initializeSchema();

    const rows = await executeSql<{ concept_id: string; language: string; content: string; generation_model: string }>(
      'SELECT concept_id, language, content, generation_model FROM generated_lessons'
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      concept_id: 'math-decimals',
      language: 'en',
      content: '{"objective":"old"}',
      generation_model: 'claude-sonnet-4-6',
    });
  });

  it('allows the same concept in two languages, which the old shape forbade', async () => {
    await executeSql(OLD_SHAPE);
    await initializeSchema();

    await executeSql(
      `INSERT INTO generated_lessons (subject_id, concept_id, language, content)
       VALUES ('math', 'math-decimals', 'en', '{"objective":"english"}')`
    );
    await executeSql(
      `INSERT INTO generated_lessons (subject_id, concept_id, language, content)
       VALUES ('math', 'math-decimals', 'pt-BR', '{"objective":"portugues"}')`
    );

    const rows = await executeSql<{ language: string }>(
      'SELECT language FROM generated_lessons WHERE concept_id = $1 ORDER BY language',
      ['math-decimals']
    );

    expect(rows.rows.map(row => row.language)).toEqual(['en', 'pt-BR']);
  });

  it('still rejects a duplicate of the same concept in the same language', async () => {
    await initializeSchema();

    await executeSql(
      `INSERT INTO generated_lessons (subject_id, concept_id, language, content)
       VALUES ('math', 'math-ratios', 'pt-BR', '{"objective":"a"}')`
    );

    await expect(
      executeSql(
        `INSERT INTO generated_lessons (subject_id, concept_id, language, content)
         VALUES ('math', 'math-ratios', 'pt-BR', '{"objective":"b"}')`
      )
    ).rejects.toThrow();
  });

  it('is safe to run again on an already migrated database', async () => {
    await initializeSchema();
    await executeSql(
      `INSERT INTO generated_lessons (subject_id, concept_id, language, content)
       VALUES ('math', 'math-counting', 'pt-BR', '{"objective":"keep me"}')`
    );

    await initializeSchema();

    const rows = await executeSql<{ content: string }>('SELECT content FROM generated_lessons');
    expect(rows.rows).toHaveLength(1);
    expect(await columnNames()).toContain('language');
  });
});
