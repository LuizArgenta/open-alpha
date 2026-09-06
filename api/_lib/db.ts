import { createClient } from '@libsql/client';
import { createHash } from 'crypto';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

/**
 * Rewrites $1, $2, ... placeholders to libsql's `?` and binds each to the
 * parameter its own number names — not to the order placeholders happen to
 * appear in the SQL text. A placeholder used twice (e.g. $1 in two clauses)
 * must bind the same value both times, and one out of order (e.g. $2 written
 * before $1) must not shift every later argument by one slot.
 */
function bindSqlParams(sql: string, params?: unknown[]): { sql: string; args: unknown[] } {
  if (!params) return { sql, args: [] };

  const args: unknown[] = [];
  const processedSql = sql.replace(/\$(\d+)/g, (_match, capturedNumber: string) => {
    const index = Number(capturedNumber) - 1;
    if (index < 0 || index >= params.length) {
      throw new Error(
        `Missing SQL parameter $${capturedNumber}: only ${params.length} argument(s) provided`
      );
    }
    args.push(params[index]);
    return '?';
  });

  return { sql: processedSql, args };
}

export async function executeSql<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const { sql: processedSql, args } = bindSqlParams(sql, params);

  const result = await client.execute({
    sql: processedSql,
    args: args as any[],
  });

  return {
    rows: result.rows as T[],
    rowCount: result.rowsAffected,
  };
}

/**
 * generated_lessons was unique on (subject_id, concept_id), which allows only
 * one language per concept — a Portuguese reader would be served the cached
 * English lesson forever. SQLite cannot drop a table-level constraint, so the
 * table is rebuilt. Rows that predate the column are English: that is what the
 * prompt produced before it took a language.
 */
async function migrateGeneratedLessonsToPerLanguage(): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(generated_lessons)');
  const alreadyMigrated = columns.rows.some(row => row.name === 'language');
  if (alreadyMigrated) return;

  await client.executeMultiple(`
    CREATE TABLE generated_lessons_per_language (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      content TEXT NOT NULL,
      generation_model TEXT,
      generation_prompt_version INTEGER DEFAULT 1,
      feedback_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(subject_id, concept_id, language)
    );

    INSERT INTO generated_lessons_per_language
      (subject_id, concept_id, language, content, generation_model,
       generation_prompt_version, feedback_count, created_at, updated_at)
    SELECT subject_id, concept_id, 'en', content, generation_model,
           generation_prompt_version, feedback_count, created_at, updated_at
    FROM generated_lessons;

    DROP TABLE generated_lessons;
    ALTER TABLE generated_lessons_per_language RENAME TO generated_lessons;
  `);
}

/**
 * Adds the item-bank columns deliberately instead of feeding them through the
 * legacy "ignore every ALTER error" loop. Unexpected migration failures must
 * stop startup; otherwise an installation can appear healthy without hashes
 * or versioned evidence.
 */
async function migrateAssessmentItemBank(): Promise<void> {
  const definitions: Record<string, string> = {
    difficulty_tag: "TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty_tag IN ('easy', 'medium', 'hard'))",
    purpose: "TEXT NOT NULL DEFAULT 'mastery' CHECK (purpose IN ('practice', 'check', 'mastery', 'review'))",
    skill_tag: 'TEXT',
    reasoning_type: 'TEXT',
    distractor_rationale: "TEXT NOT NULL DEFAULT '{}'",
    distractor_error_code: "TEXT NOT NULL DEFAULT '{}'",
    pedagogical_rationale: 'TEXT',
    content_hash: 'TEXT',
    version: 'INTEGER NOT NULL DEFAULT 1',
    status: "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired'))",
  };

  const columns = await client.execute('PRAGMA table_info(assessment_items)');
  const existing = new Set(columns.rows.map(row => String(row.name)));
  let migratedLegacyRows = false;
  for (const [name, definition] of Object.entries(definitions)) {
    if (!existing.has(name)) {
      await client.execute(`ALTER TABLE assessment_items ADD COLUMN ${name} ${definition}`);
      migratedLegacyRows = true;
    }
  }

  const rows = await client.execute(`
    SELECT id, subject_id, concept_id, language, authored_id, stem, options,
           correct_answer, explanation
    FROM assessment_items
    WHERE content_hash IS NULL
    ORDER BY subject_id, concept_id, language, authored_id, id
  `);
  if (rows.rows.length > 0) migratedLegacyRows = true;
  for (const row of rows.rows) {
    let version = 1;
    if (row.authored_id !== null) {
      const prior = await client.execute({
        sql: `SELECT COALESCE(MAX(version), 0) AS version FROM assessment_items
              WHERE subject_id = ? AND concept_id = ? AND language = ?
                AND authored_id = ? AND content_hash IS NOT NULL`,
        args: [row.subject_id as string, row.concept_id as string,
          row.language as string, row.authored_id as string],
      });
      version = Number(prior.rows[0]?.version ?? 0) + 1;
    }
    let options: unknown = row.options;
    try {
      options = JSON.parse(String(row.options));
    } catch {
      // Preserve even malformed historical evidence with a deterministic hash.
    }
    const contentHash = createHash('sha256').update(JSON.stringify({
      question: row.stem,
      options,
      correctAnswer: row.correct_answer,
      explanation: row.explanation ?? null,
      difficultyTag: 'medium',
      purpose: 'mastery',
      skillTag: null,
      reasoningType: null,
      distractorRationale: {},
      distractorErrorCode: {},
      pedagogicalRationale: null,
    })).digest('hex');
    await client.execute({
      sql: 'UPDATE assessment_items SET content_hash = ?, version = ? WHERE id = ?',
      args: [contentHash, version, row.id as number],
    });
  }

  // If a legacy database somehow has repeated authored ids, preserve every
  // historical row but expose only the newest as the active bank item.
  if (migratedLegacyRows) {
    await client.execute(`
      UPDATE assessment_items SET status = 'retired'
      WHERE authored_id IS NOT NULL AND id NOT IN (
        SELECT MAX(id) FROM assessment_items
        WHERE authored_id IS NOT NULL
        GROUP BY subject_id, concept_id, language, authored_id
      )
    `);
  }
  await client.execute(`CREATE INDEX IF NOT EXISTS assessment_item_pool
    ON assessment_items(subject_id, concept_id, language, status, purpose)`);
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS assessment_item_authored_version
    ON assessment_items(subject_id, concept_id, language, authored_id, version)
    WHERE authored_id IS NOT NULL`);

  // Early development builds used this name for a UNIQUE hash index. That
  // rejected legitimate, identical legacy snapshots with different versions.
  // Replace only that obsolete variant so the migration remains safe to rerun.
  const indexes = await client.execute('PRAGMA index_list(assessment_items)');
  const obsoleteUniqueHashIndex = indexes.rows.some(row =>
    String(row.name) === 'assessment_item_authored_hash' && Number(row.unique) === 1
  );
  if (obsoleteUniqueHashIndex) {
    await client.execute('DROP INDEX assessment_item_authored_hash');
  }
  await client.execute(`CREATE INDEX IF NOT EXISTS assessment_item_authored_hash
    ON assessment_items(subject_id, concept_id, language, authored_id, content_hash)
    WHERE authored_id IS NOT NULL AND content_hash IS NOT NULL`);
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS assessment_item_active_authored
    ON assessment_items(subject_id, concept_id, language, authored_id)
    WHERE authored_id IS NOT NULL AND status = 'active'`);
}

/**
 * assessment_responses' UNIQUE(attempt_id, item_id) only exists in the
 * fresh-install CREATE TABLE above. An install whose table predates that
 * constraint (anything before PR #20) has it recreated by the legacy
 * migrations list below with `CREATE TABLE IF NOT EXISTS`, which no-ops on a
 * table that already exists and never adds the constraint retroactively —
 * so that install can silently accept two responses to the same item on the
 * same attempt forever.
 *
 * The application already refuses to write a second response once it reads
 * one back (`quiz/answer.ts`), so a healthy database should have no
 * duplicates to clean up; this only matters for a database old enough, or
 * unlucky enough under a race, to have gotten one anyway. Guarded the same
 * way `migrateGeneratedLessonsToPerLanguage` is: check first, skip if the
 * constraint is already there, so this is cheap on every cold start.
 */
async function ensureAssessmentResponsesUniqueConstraint(): Promise<void> {
  const indexes = await client.execute('PRAGMA index_list(assessment_responses)');
  const alreadyEnforced = indexes.rows.some(row => Number(row.unique) === 1);
  if (alreadyEnforced) return;

  // Rows with a null attempt_id or item_id are left alone: SQLite's UNIQUE
  // never treats two nulls as equal, so they were never the constraint's
  // concern, and GROUP BY would otherwise lump them together as if they were.
  await client.execute(`
    DELETE FROM assessment_responses
    WHERE attempt_id IS NOT NULL AND item_id IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id) FROM assessment_responses
        WHERE attempt_id IS NOT NULL AND item_id IS NOT NULL
        GROUP BY attempt_id, item_id
      )
  `);

  await client.execute(
    'CREATE UNIQUE INDEX idx_assessment_responses_attempt_item ON assessment_responses(attempt_id, item_id)'
  );
}

/**
 * A statement queued inside a transaction, in the same shape executeSql takes.
 */
export interface SqlStatement {
  sql: string;
  params?: unknown[];
}

function toLibsqlStatement({ sql, params }: SqlStatement) {
  const { sql: processedSql, args } = bindSqlParams(sql, params);
  return { sql: processedSql, args: args as any[] };
}

/**
 * Runs statements as one unit, so a failure halfway cannot leave a student
 * with XP awarded and no progress recorded, or an attempt closed with no
 * mastery written.
 *
 * Deliberately takes a prepared list rather than a callback: everything that
 * needs to be atomic here is known before the first write, and a callback
 * would invite reads inside the transaction that libsql would serialise
 * behind the write lock.
 */
export async function executeTransaction(statements: SqlStatement[]): Promise<void> {
  if (statements.length === 0) return;

  const transaction = await client.transaction('write');
  try {
    for (const statement of statements) {
      await transaction.execute(toLibsqlStatement(statement));
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function initializeSchema(): Promise<void> {
  await client.executeMultiple(`
    -- Users (students and parents)
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      atxp_account_id TEXT UNIQUE,
      display_name TEXT,
      role TEXT NOT NULL CHECK (role IN ('student', 'parent')),
      grade_level INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Parent-child links
    CREATE TABLE IF NOT EXISTS parent_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES users(id),
      student_id INTEGER REFERENCES users(id),
      invite_code TEXT UNIQUE,
      linked_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Progress tracking
    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      mastery_score INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_attempt_at TEXT,
      completed_at TEXT,
      next_review_at TEXT,
      review_interval_days INTEGER,
      mastery_source TEXT DEFAULT 'quiz',
      mastery_confidence REAL DEFAULT 1.0,
      UNIQUE(student_id, subject, concept_id)
    );

    -- Chat sessions (tutor and coach)
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      session_type TEXT CHECK (session_type IN ('tutor', 'coach')),
      subject TEXT,
      concept_id TEXT,
      messages TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- PKCE state for OAuth flows
    CREATE TABLE IF NOT EXISTS oauth_pkce (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      role TEXT,
      grade_level INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Curriculum contributions from agents and humans
    CREATE TABLE IF NOT EXISTS contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contributor_id TEXT NOT NULL,
      contributor_type TEXT DEFAULT 'human' CHECK (contributor_type IN ('agent', 'human', 'institution')),
      contribution_type TEXT NOT NULL CHECK (contribution_type IN ('lesson_module', 'quiz_item', 'pedagogical_improvement', 'new_concept')),
      subject_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'auto_validated', 'approved', 'rejected', 'deployed')),
      validation_results TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Reviews of contributions (human reviewers and automated systems)
    CREATE TABLE IF NOT EXISTS contribution_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contribution_id INTEGER REFERENCES contributions(id),
      reviewer_id TEXT NOT NULL,
      reviewer_type TEXT DEFAULT 'human' CHECK (reviewer_type IN ('agent', 'human', 'automated')),
      decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'improve')),
      feedback TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Contributor reputation scores (higher = more trusted, content auto-approved sooner)
    CREATE TABLE IF NOT EXISTS contributor_reputation (
      contributor_id TEXT PRIMARY KEY,
      contributor_type TEXT DEFAULT 'human',
      total_contributions INTEGER DEFAULT 0,
      approved_contributions INTEGER DEFAULT 0,
      rejected_contributions INTEGER DEFAULT 0,
      reputation_score REAL DEFAULT 0.0,
      last_contribution_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- On-demand generated lessons (cached LLM output), one row per language
    CREATE TABLE IF NOT EXISTS generated_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      content TEXT NOT NULL,
      generation_model TEXT,
      generation_prompt_version INTEGER DEFAULT 1,
      feedback_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(subject_id, concept_id, language)
    );

    -- Student interest profiles (for personalized lesson generation)
    CREATE TABLE IF NOT EXISTS user_interests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      category TEXT NOT NULL CHECK (category IN ('hobby', 'sport', 'media', 'hero', 'career', 'other')),
      value TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, category, value)
    );

    -- Learning events for waste meter / timeback tracking
    CREATE TABLE IF NOT EXISTS learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('lesson_start', 'lesson_end', 'quiz_start', 'quiz_answer', 'quiz_complete', 'hint_request', 'idle_timeout')),
      payload TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Staff roles live beside the account type rather than inside it.
    -- users.role has a CHECK constraint and half a dozen tables reference
    -- users(id), so widening it would mean rebuilding a table with foreign
    -- keys pointing at it. It is also truer: in a school a teacher is often
    -- also a parent, and one column cannot hold both.
    CREATE TABLE IF NOT EXISTS staff_roles (
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('teacher', 'admin')),
      granted_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, role)
    );

    -- Curriculum as data, so it can be authored at runtime instead of only
    -- by editing files and redeploying
    CREATE TABLE IF NOT EXISTS curriculum_subjects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'in_review', 'published')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS curriculum_concepts (
      subject_id TEXT NOT NULL REFERENCES curriculum_subjects(id),
      concept_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      level INTEGER NOT NULL,
      prerequisites TEXT NOT NULL DEFAULT '[]',
      -- The enriched bundle (explanation, examples, mastery check...) kept as
      -- authored. It is nested and it is always read whole.
      content TEXT NOT NULL DEFAULT '{}',
      -- Hash of the published content, so an import that changes nothing does
      -- not bump the version a teacher reads as "this concept changed".
      content_hash TEXT,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'in_review', 'published')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (subject_id, concept_id)
    );

    -- Every question a student was actually shown, kept so a mastery decision
    -- can be reconstructed after the fact
    CREATE TABLE IF NOT EXISTS assessment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      source TEXT NOT NULL CHECK (source IN ('authored', 'generated')),
      authored_id TEXT,
      stem TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_answer TEXT NOT NULL,
      explanation TEXT,
      difficulty_tag TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty_tag IN ('easy', 'medium', 'hard')),
      purpose TEXT NOT NULL DEFAULT 'mastery' CHECK (purpose IN ('practice', 'check', 'mastery', 'review')),
      skill_tag TEXT,
      reasoning_type TEXT,
      distractor_rationale TEXT NOT NULL DEFAULT '{}',
      distractor_error_code TEXT NOT NULL DEFAULT '{}',
      pedagogical_rationale TEXT,
      content_hash TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assessment_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      -- A mastery check is about one concept; a placement probe spans a
      -- subject, and stores '*' as its concept because none of them is the
      -- one being assessed. Each item carries the concept it belongs to.
      kind TEXT NOT NULL DEFAULT 'mastery' CHECK (kind IN ('mastery', 'placement')),
      score INTEGER,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      -- Set when the attempt timed out rather than being submitted, so a
      -- closed attempt with no score is never ambiguous.
      expired_at TEXT
    );

    -- Which items an attempt is made of, and in what order. Without this the
    -- server cannot tell whether a submitted answer belongs to the attempt
    -- claiming it.
    CREATE TABLE IF NOT EXISTS assessment_attempt_items (
      attempt_id INTEGER NOT NULL REFERENCES assessment_attempts(id),
      item_id INTEGER NOT NULL REFERENCES assessment_items(id),
      position INTEGER NOT NULL,
      PRIMARY KEY (attempt_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS assessment_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER REFERENCES assessment_attempts(id),
      item_id INTEGER REFERENCES assessment_items(id),
      chosen TEXT,
      correct INTEGER NOT NULL,
      response_ms INTEGER,
      answered_at TEXT DEFAULT (datetime('now')),
      UNIQUE(attempt_id, item_id)
    );

    -- What the engine decided about a student, and on what grounds
    CREATE TABLE IF NOT EXISTS learning_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT,
      concept_id TEXT,
      kind TEXT NOT NULL,
      decision TEXT,
      reason TEXT NOT NULL,
      inputs TEXT DEFAULT '{}',
      engine_version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- XP awarded per mastery attempt (evidence of learning, not time spent)
    CREATE TABLE IF NOT EXISTS xp_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Student pushback on a focus signal ("I wasn't guessing")
    CREATE TABLE IF NOT EXISTS focus_contests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      pattern TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Guest sessions for demo mode (no account required)
    CREATE TABLE IF NOT EXISTS guest_sessions (
      id TEXT PRIMARY KEY,
      subject TEXT,
      concept_id TEXT,
      grade_level INTEGER DEFAULT 9,
      messages TEXT DEFAULT '[]',
      message_count INTEGER DEFAULT 0,
      ip_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migrations: add new columns to existing installs (errors ignored if already present)
  const migrations = [
    'ALTER TABLE users ADD COLUMN atxp_account_id TEXT',
    'ALTER TABLE users ADD COLUMN atxp_connection_token TEXT',
    // Content hash of a published concept, to keep version meaningful
    'ALTER TABLE curriculum_concepts ADD COLUMN content_hash TEXT',
    // What an attempt is assessing: one concept, or where to start
    "ALTER TABLE assessment_attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'mastery'",
    // Attempts that timed out instead of being submitted
    'ALTER TABLE assessment_attempts ADD COLUMN expired_at TEXT',
    // Spaced review scheduling
    'ALTER TABLE progress ADD COLUMN next_review_at TEXT',
    'ALTER TABLE progress ADD COLUMN review_interval_days INTEGER',
    // How a mastery estimate was arrived at, and how much to trust it
    "ALTER TABLE progress ADD COLUMN mastery_source TEXT DEFAULT 'quiz'",
    'ALTER TABLE progress ADD COLUMN mastery_confidence REAL DEFAULT 1.0',
    `CREATE TABLE IF NOT EXISTS staff_roles (
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('teacher', 'admin')),
      granted_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, role)
    )`,
    `CREATE TABLE IF NOT EXISTS curriculum_subjects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'in_review', 'published')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS curriculum_concepts (
      subject_id TEXT NOT NULL REFERENCES curriculum_subjects(id),
      concept_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      level INTEGER NOT NULL,
      prerequisites TEXT NOT NULL DEFAULT '[]',
      content TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'in_review', 'published')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (subject_id, concept_id)
    )`,
    `CREATE TABLE IF NOT EXISTS assessment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      source TEXT NOT NULL CHECK (source IN ('authored', 'generated')),
      authored_id TEXT,
      stem TEXT NOT NULL,
      options TEXT NOT NULL,
      correct_answer TEXT NOT NULL,
      explanation TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS assessment_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      score INTEGER,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT,
      expired_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS assessment_attempt_items (
      attempt_id INTEGER NOT NULL REFERENCES assessment_attempts(id),
      item_id INTEGER NOT NULL REFERENCES assessment_items(id),
      position INTEGER NOT NULL,
      PRIMARY KEY (attempt_id, item_id)
    )`,
    `CREATE TABLE IF NOT EXISTS assessment_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER REFERENCES assessment_attempts(id),
      item_id INTEGER REFERENCES assessment_items(id),
      chosen TEXT,
      correct INTEGER NOT NULL,
      response_ms INTEGER,
      answered_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS learning_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT,
      concept_id TEXT,
      kind TEXT NOT NULL,
      decision TEXT,
      reason TEXT NOT NULL,
      inputs TEXT DEFAULT '{}',
      engine_version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS xp_awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS focus_contests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      pattern TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    // Contribution system tables (added after initial launch)
    `CREATE TABLE IF NOT EXISTS contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contributor_id TEXT NOT NULL,
      contributor_type TEXT DEFAULT 'human' CHECK (contributor_type IN ('agent', 'human', 'institution')),
      contribution_type TEXT NOT NULL CHECK (contribution_type IN ('lesson_module', 'quiz_item', 'pedagogical_improvement', 'new_concept')),
      subject_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'auto_validated', 'approved', 'rejected', 'deployed')),
      validation_results TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS contribution_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contribution_id INTEGER REFERENCES contributions(id),
      reviewer_id TEXT NOT NULL,
      reviewer_type TEXT DEFAULT 'human' CHECK (reviewer_type IN ('agent', 'human', 'automated')),
      decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'improve')),
      feedback TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS contributor_reputation (
      contributor_id TEXT PRIMARY KEY,
      contributor_type TEXT DEFAULT 'human',
      total_contributions INTEGER DEFAULT 0,
      approved_contributions INTEGER DEFAULT 0,
      rejected_contributions INTEGER DEFAULT 0,
      reputation_score REAL DEFAULT 0.0,
      last_contribution_at TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS guest_sessions (
      id TEXT PRIMARY KEY,
      subject TEXT,
      concept_id TEXT,
      grade_level INTEGER DEFAULT 9,
      messages TEXT DEFAULT '[]',
      message_count INTEGER DEFAULT 0,
      ip_hash TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS generated_lessons (
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
    )`,
    `CREATE TABLE IF NOT EXISTS user_interests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      category TEXT NOT NULL CHECK (category IN ('hobby', 'sport', 'media', 'hero', 'career', 'other')),
      value TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, category, value)
    )`,
    `CREATE TABLE IF NOT EXISTS learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('lesson_start', 'lesson_end', 'quiz_start', 'quiz_answer', 'quiz_complete', 'hint_request', 'idle_timeout')),
      payload TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
  ];
  for (const sql of migrations) {
    try {
      await client.execute(sql);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  await migrateAssessmentItemBank();

  // Multi-step and not idempotent by accident, so it guards itself rather than
  // relying on the swallowed errors above.
  await migrateGeneratedLessonsToPerLanguage();
  await ensureAssessmentResponsesUniqueConstraint();
}

export default { executeSql, initializeSchema };
