import { createClient } from '@libsql/client';
import { createHash } from 'crypto';
import { eventTypeCheckList } from './event-contract.js';
import {
  ENGINE_INTERVENTIONS,
  INTERVENTION_OUTCOME_LIST,
  INTERVENTION_SOURCE_LIST,
  INTERVENTION_STATUS_LIST,
  INTERVENTION_TARGET_LIST,
  INTERVENTION_TYPE_LIST,
} from './intervention-contract.js';


/**
 * The event vocabulary, quoted for a CHECK constraint.
 *
 * Interpolated rather than written out so the constraint cannot drift from the
 * list `event-contract.ts` declares. It drifted before: this file listed eight
 * types and `progress/events.ts` accepted seven.
 */
const EVENT_TYPES = eventTypeCheckList();

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
 * A schema change, applied once and recorded.
 *
 * Deliberately not checksummed. The plan asked for one, and for SQL-string
 * migrations it would be worth having — it catches someone editing a
 * migration that already ran, which is how a fresh database and an upgraded
 * one silently diverge. These are functions that call other helpers, so a
 * checksum of the function body would miss a change one level down while
 * failing startup over a reworded comment: false confidence and false alarms
 * at once. The registry below is append-only instead; correcting an applied
 * migration means adding another one.
 */
interface Migration {
  id: string;
  run: () => Promise<void>;
}

/** What the last schema initialisation did, for the health check to report. */
export const schemaStatus: {
  ready: boolean;
  applied: string[];
  failed: string | null;
  error: string | null;
  checkedAt: string | null;
} = { ready: false, applied: [], failed: null, error: null, checkedAt: null };

/**
 * The one error an additive statement is allowed to fail with.
 *
 * These statements ran for a long time inside a `catch {}` that discarded
 * every exception as "the column is already there" — including permission,
 * connection, corruption and constraint errors, which is how a half-migrated
 * database could report itself healthy. On a database that predates
 * `_schema_migrations` the columns really are already there, so that one
 * error still has to be tolerated; nothing else does.
 */
function isAlreadyApplied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

async function runAdditiveStatements(statements: string[]): Promise<void> {
  for (const sql of statements) {
    try {
      await client.execute(sql);
    } catch (error) {
      if (!isAlreadyApplied(error)) throw error;
    }
  }
}

/**
 * Runs each migration at most once, in order, and stops at the first failure.
 *
 * Stopping matters more than it sounds: the migrations after a failed one
 * assume it succeeded, so continuing past it produces a database that is
 * wrong in a second way and harder to diagnose. A failure leaves the id
 * unrecorded, so the next start retries it rather than skipping ahead.
 */
async function applyMigrations(migrations: Migration[]): Promise<void> {
  schemaStatus.checkedAt = new Date().toISOString();

  await client.execute(`CREATE TABLE IF NOT EXISTS _schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);

  const recorded = await client.execute('SELECT id FROM _schema_migrations');
  const alreadyApplied = new Set(recorded.rows.map(row => String(row.id)));

  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) continue;

    try {
      await migration.run();
    } catch (error) {
      schemaStatus.ready = false;
      schemaStatus.failed = migration.id;
      schemaStatus.error = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.id} failed: ${schemaStatus.error}`, { cause: error });
    }

    await client.execute({
      sql: 'INSERT INTO _schema_migrations (id) VALUES (?)',
      args: [migration.id],
    });
    schemaStatus.applied.push(migration.id);
  }

  schemaStatus.ready = true;
  schemaStatus.failed = null;
  schemaStatus.error = null;
}

/**
 * The table the login and signup limits count in, plus the index they count
 * with — without it every attempt scans the whole table, which is a denial of
 * service wearing the costume of a defence against one.
 *
 * Old rows are swept on write rather than by a cron serverless does not have:
 * the counter only ever asks about the last few minutes, so anything past the
 * window is dead weight and a growing privacy liability.
 */
async function migrateAuthAttempts(): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS auth_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('login', 'signup')),
    kind TEXT NOT NULL CHECK (kind IN ('email', 'ip')),
    identifier TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await client.execute(`CREATE INDEX IF NOT EXISTS auth_attempts_lookup
    ON auth_attempts(scope, kind, identifier, created_at)`);
}

/**
 * The table the model budget counts in, and the index it counts with — the
 * query only ever asks about the last day, so without it every check scans
 * every call ever made.
 *
 * Numbered 007 to leave 006 for the auth_attempts migration in the open
 * rate-limiting PR; ids are strings and run in array order, so a gap costs
 * nothing and a collision would cost a merge conflict.
 */
/**
 * Lets the server write to the event stream, and says who wrote each row.
 *
 * `learning_events` had exactly one writer: `progress/events.ts`, which the
 * browser calls with `.catch(() => {})`. Everything the server knows for
 * certain — an attempt opened, an answer graded, a quiz finalised, an attempt
 * expired — never reached the stream at all, and a dropped browser request
 * left no trace of the gap. A student who had just sat a quiz showed a streak
 * of zero because of it.
 *
 * `source` makes provenance legible rather than assumed: a reader can tell a
 * fact the server observed from one a browser reported. `attempt_id` is what
 * makes an event joinable back to the evidence it describes.
 *
 * The CHECK is widened rather than dropped. `quiz_expired` is not
 * `idle_timeout`: one is the server closing a stale attempt, the other is the
 * browser noticing a person walked away, and collapsing them would lose the
 * distinction the focus diagnosis depends on.
 */
async function migrateLearningEventSource(): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(learning_events)');
  const existing = new Set(columns.rows.map(row => String(row.name)));

  if (!existing.has('source')) {
    await client.execute(
      "ALTER TABLE learning_events ADD COLUMN source TEXT NOT NULL DEFAULT 'browser'"
    );
  }
  if (!existing.has('attempt_id')) {
    await client.execute('ALTER TABLE learning_events ADD COLUMN attempt_id INTEGER');
  }

  /**
   * The CHECK has to be widened, not left alone.
   *
   * A first version of this migration added the columns and reasoned that the
   * old constraint was harmless because the application is the only writer.
   * That was wrong in a way only the upgrade path shows: an existing database
   * does not merely lack a guard, it *actively rejects* `quiz_expired`. And
   * since recordEvent never throws, every expiry on a deployment with history
   * would have failed silently — precisely the databases that have users.
   *
   * SQLite cannot alter a CHECK, so the table is rebuilt. The row count is
   * verified before the original is dropped: this migration exists to preserve
   * those rows, and a rebuild that loses them would be worse than the bug.
   */
  const constraint = await client.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'learning_events'"
  );
  const definition = String(constraint.rows[0]?.sql ?? '');
  if (definition.includes('quiz_expired')) {
    await client.execute(
      'CREATE INDEX IF NOT EXISTS learning_events_attempt ON learning_events(attempt_id)'
    );
    return;
  }

  const before = await client.execute('SELECT COUNT(*) AS n FROM learning_events');
  const rowsBefore = Number(before.rows[0].n);

  await client.execute(`CREATE TABLE learning_events_rebuilt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES users(id),
    subject TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('lesson_start', 'lesson_end', 'quiz_start', 'quiz_answer', 'quiz_complete', 'quiz_expired', 'hint_request', 'idle_timeout')),
    source TEXT NOT NULL DEFAULT 'browser',
    attempt_id INTEGER,
    payload TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await client.execute(`INSERT INTO learning_events_rebuilt
      (id, student_id, subject, concept_id, event_type, source, attempt_id, payload, created_at)
    SELECT id, student_id, subject, concept_id, event_type, source, attempt_id, payload, created_at
    FROM learning_events`);

  const copied = await client.execute('SELECT COUNT(*) AS n FROM learning_events_rebuilt');
  if (Number(copied.rows[0].n) !== rowsBefore) {
    await client.execute('DROP TABLE learning_events_rebuilt');
    throw new Error(
      `learning_events rebuild copied ${copied.rows[0].n} of ${rowsBefore} rows; refusing to drop the original`
    );
  }

  await client.execute('DROP TABLE learning_events');
  await client.execute('ALTER TABLE learning_events_rebuilt RENAME TO learning_events');
  await client.execute(
    'CREATE INDEX IF NOT EXISTS learning_events_attempt ON learning_events(attempt_id)'
  );
}

/**
 * The Learning Event Contract, v1, applied to an existing stream.
 *
 * Four columns, and each is here because something is wrong without it.
 *
 * **`event_id`** — the rowid is this database's private counter. Anything
 * outside it that wants to refer to one event, deduplicate a replay, or
 * reconcile two copies needs an identity the row carries with it. Backfilled
 * for existing rows rather than left null, so no reader has to know that the
 * stream has a before and an after: that is the whole point of the adapter in
 * `event-contract.ts`.
 *
 * **`schema_version`** — a stream nobody can version is a stream nobody can
 * change. Writing 1 on every row now is what makes a v2 reader able to tell
 * what it is looking at later.
 *
 * **`occurred_at`** — separate from `created_at`, which was doing both jobs
 * and getting one of them wrong. The browser posts lesson and hint events
 * after the fact, and the waste meter measures the gaps *between* events to
 * infer focus. A batch that arrives late currently reads as a burst of
 * activity at the moment it landed. Backfilled to `created_at`, which is the
 * best that was ever knowable about the old rows.
 *
 * **`dedupe_key`** — a client's retry token, kept apart from `event_id` on
 * purpose. The obvious design lets the browser supply the event id and makes
 * that unique, and it hands one student the ability to suppress another's
 * event by writing their id first. The key is unique **per student**, so a
 * replay can only ever collide with its own author's rows, and the identity
 * stays server-generated and global.
 *
 * SQLite cannot add a UNIQUE column, so both uniqueness rules are indexes.
 * `dedupe_key`'s is partial: every row written before it existed has none, and
 * SQLite would otherwise treat each of those nulls as distinct anyway — the
 * same shape as the xp_awards index below.
 */
async function migrateLearningEventEnvelope(): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(learning_events)');
  const existing = new Set(columns.rows.map(row => String(row.name)));

  if (!existing.has('event_id')) {
    await client.execute('ALTER TABLE learning_events ADD COLUMN event_id TEXT');
  }
  if (!existing.has('schema_version')) {
    await client.execute(
      'ALTER TABLE learning_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1'
    );
  }
  if (!existing.has('occurred_at')) {
    await client.execute('ALTER TABLE learning_events ADD COLUMN occurred_at TEXT');
  }
  if (!existing.has('dedupe_key')) {
    await client.execute('ALTER TABLE learning_events ADD COLUMN dedupe_key TEXT');
  }

  // A UUIDv4 per row, in SQL: randomblob is evaluated per row, so this does
  // not stamp one id across the table. Done here rather than in application
  // code because a backfill that has to page through rows is a backfill that
  // can stop halfway.
  await client.execute(`UPDATE learning_events SET event_id = lower(
      hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
      substr(hex(randomblob(2)), 2) || '-' ||
      substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
      hex(randomblob(6))
    ) WHERE event_id IS NULL`);

  await client.execute(
    'UPDATE learning_events SET occurred_at = created_at WHERE occurred_at IS NULL'
  );

  // If the backfill left a duplicate or a gap, the unique index below would
  // fail and take the whole migration with it. Better to say which.
  const unfilled = await client.execute(
    'SELECT COUNT(*) AS n FROM learning_events WHERE event_id IS NULL'
  );
  if (Number(unfilled.rows[0].n) > 0) {
    throw new Error(`${unfilled.rows[0].n} learning_events rows have no event_id after backfill`);
  }

  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS learning_events_event_id ON learning_events(event_id)'
  );
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS learning_events_dedupe
       ON learning_events(student_id, dedupe_key) WHERE dedupe_key IS NOT NULL`
  );
  await client.execute(
    'CREATE INDEX IF NOT EXISTS learning_events_occurred ON learning_events(student_id, occurred_at)'
  );
}

/**
 * Intervention as a first-class entity.
 *
 * Two tables and a seed. What makes this more than bookkeeping is
 * `expected_outcome`, written when a run starts rather than judged after it
 * ends: without a prediction recorded first, comparing two interventions is
 * retrospective, and something always explains what already happened.
 *
 * Identity is `(key, version)`. An intervention is never edited in place —
 * revising one means a new version, because a run recorded against version 1
 * has to keep meaning what it meant when it was written. That is also why the
 * seed is `ON CONFLICT DO NOTHING` rather than an upsert.
 *
 * The vocabularies come from `interventions.ts` and the CHECKs are built from
 * them, for the reason `learning_events` had to be rebuilt in 008: a list kept
 * in two places is a list that will disagree with itself, and the copy in the
 * database is the one that rejects writes silently.
 */
async function migrateInterventions(): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS interventions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (${INTERVENTION_TYPE_LIST})),
    target_kind TEXT NOT NULL CHECK (target_kind IN (${INTERVENTION_TARGET_LIST})),
    target_id TEXT,
    source TEXT NOT NULL CHECK (source IN (${INTERVENTION_SOURCE_LIST})),
    content_ref TEXT,
    estimated_minutes INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${INTERVENTION_STATUS_LIST})),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(key, version)
  )`);

  await client.execute(`CREATE TABLE IF NOT EXISTS intervention_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    intervention_id INTEGER NOT NULL REFERENCES interventions(id),
    student_id INTEGER NOT NULL REFERENCES users(id),
    decision_id INTEGER REFERENCES learning_decisions(id),
    subject TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT NOT NULL DEFAULT '{}',
    expected_outcome TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (${INTERVENTION_OUTCOME_LIST})),
    evidence_summary TEXT
  )`);

  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS intervention_runs_run_id ON intervention_runs(run_id)'
  );
  await client.execute(`CREATE INDEX IF NOT EXISTS intervention_runs_open
    ON intervention_runs(student_id, subject, concept_id, completed_at)`);

  // Seeded here rather than by calling into interventions.ts: that module
  // reads and writes through this one, and importing it back would make the
  // cycle real. The catalogue itself is a plain constant with no database in
  // it, which is what the contract/implementation split is for.
  //
  // ON CONFLICT DO NOTHING on (key, version), so a fresh deployment gets the
  // rows and an existing one gets nothing. Revising an intervention means a
  // new version, never an edit — a run recorded against version 1 has to keep
  // meaning what it meant.
  for (const intervention of ENGINE_INTERVENTIONS) {
    await client.execute({
      sql: `INSERT INTO interventions
              (key, type, target_kind, target_id, source, content_ref, estimated_minutes, version, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (key, version) DO NOTHING`,
      args: [
        intervention.key,
        intervention.type,
        intervention.targetKind,
        intervention.targetId,
        intervention.source,
        intervention.contentRef,
        intervention.estimatedMinutes,
        intervention.version,
        intervention.status,
      ],
    });
  }
}

/**
 * What a run *offered*, as against what it is judged on.
 *
 * `review_prerequisites` sends the student to a different concept than the one
 * they failed: they are offered division and re-measured on fractions. The run
 * recorded only the second, so the timeline said "offered practice on
 * Fractions" for an intervention that never mentioned fractions.
 *
 * Nullable, and null means "the same concept" — which is true of every run
 * written before this column existed and of most written after it.
 */
async function migrateInterventionTarget(): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(intervention_runs)');
  const existing = new Set(columns.rows.map(row => String(row.name)));

  if (!existing.has('target_concept_id')) {
    await client.execute('ALTER TABLE intervention_runs ADD COLUMN target_concept_id TEXT');
  }
}

async function migrateLlmUsage(): Promise<void> {
  await client.execute(`CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  await client.execute(`CREATE INDEX IF NOT EXISTS llm_usage_window
    ON llm_usage(created_at)`);
}

/**
 * Ties an XP award to the attempt that earned it.
 *
 * Without the column, "one award per attempt" is only as strong as the code
 * path that writes it, and XP is the one number a student watches — a double
 * award is both wrong and visibly wrong. The unique index is partial because
 * awards predating the column carry no attempt id, and because SQLite's UNIQUE
 * would otherwise treat every one of those nulls as distinct anyway.
 */
async function migrateXpAwardsAttemptId(): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(xp_awards)');
  const hasAttemptId = columns.rows.some(row => String(row.name) === 'attempt_id');
  if (!hasAttemptId) {
    await client.execute(
      'ALTER TABLE xp_awards ADD COLUMN attempt_id INTEGER REFERENCES assessment_attempts(id)'
    );
  }

  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS xp_awards_one_per_attempt
    ON xp_awards(attempt_id) WHERE attempt_id IS NOT NULL`);
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
 * One write transaction at a time, per process.
 *
 * `client.transaction('write')` issues a BEGIN, and against a local SQLite
 * file a second BEGIN while one is open fails outright with SQLITE_BUSY —
 * thrown while acquiring, before any statement runs. Two learners submitting
 * at the same moment would then get a 500 rather than the answer their
 * request deserves, and that is the deployment this project promises to
 * support offline.
 *
 * Serialising here costs nothing against a remote Turso, where each instance
 * holds its own connection and the server arbitrates anyway, and makes the
 * local case deterministic instead of a race. Reads are untouched: only the
 * transaction bodies queue, so the interleaving that concurrency guards exist
 * to catch still happens.
 *
 * Nesting is not supported — a transaction body that calls back into one of
 * these would wait on itself. Use the scope handed to the callback.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(work, work);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
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

  return enqueueWrite(async () => {
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
  });
}

/** Reads and writes issued inside a `withTransaction` callback. */
export interface TransactionScope {
  run<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }>;
}

/**
 * A transaction whose later statements depend on what the earlier ones
 * returned — the case `executeTransaction` deliberately cannot serve.
 *
 * The prepared-list form above is still the right tool whenever every write is
 * known before the first one, and it stays the default: a callback makes it
 * easy to accidentally hold the write lock across an LLM call or an HTTP
 * request. Reach for this one only when an id or a row count produced *inside*
 * the transaction decides what happens next — `openAttempt` needs the attempt
 * id to write its item links, and a guarded finalisation needs to know whether
 * its `UPDATE` actually matched a row.
 *
 * Use `scope.run` for every statement inside the callback. Calling `executeSql`
 * in there instead would run outside the transaction, on a connection that
 * libsql serialises behind this one's write lock — so it would not roll back
 * with the rest, and can deadlock.
 */
export async function withTransaction<T>(
  work: (scope: TransactionScope) => Promise<T>
): Promise<T> {
  return enqueueWrite(async () => {
    const transaction = await client.transaction('write');
    try {
      const result = await work({
        run: async (sql, params) => {
          const executed = await transaction.execute(toLibsqlStatement({ sql, params }));
          return { rows: executed.rows as any[], rowCount: executed.rowsAffected };
        },
      });
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  });
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

    -- What should be done for a student, why, and what it is meant to achieve.
    -- See interventions.ts: this is deliberately not a second lessons table.
    CREATE TABLE IF NOT EXISTS interventions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Stable name, so a run can be read without joining and a seed can be
      -- re-run. Identity is (key, version): changing what an intervention
      -- *is* means a new version, never an edit, or every run recorded
      -- against it silently changes meaning.
      key TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN (${INTERVENTION_TYPE_LIST})),
      target_kind TEXT NOT NULL CHECK (target_kind IN (${INTERVENTION_TARGET_LIST})),
      target_id TEXT,
      source TEXT NOT NULL CHECK (source IN (${INTERVENTION_SOURCE_LIST})),
      -- Where the material lives, when it lives outside this database.
      content_ref TEXT,
      estimated_minutes INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (${INTERVENTION_STATUS_LIST})),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(key, version)
    );

    CREATE TABLE IF NOT EXISTS intervention_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      intervention_id INTEGER NOT NULL REFERENCES interventions(id),
      student_id INTEGER NOT NULL REFERENCES users(id),
      -- The decision that chose this, so a challenge to one reaches the other.
      decision_id INTEGER REFERENCES learning_decisions(id),
      subject TEXT NOT NULL,
      -- The concept this run is *judged on*: where the student was measured
      -- and where they will be measured again.
      concept_id TEXT NOT NULL,
      -- The concept the student was actually sent to, when that differs.
      -- Reviewing a prerequisite means being offered one concept and assessed
      -- on another, and a record that keeps only the second cannot say what
      -- was tried.
      target_concept_id TEXT,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '{}',
      -- Written before the result, which is the whole point: without a
      -- prediction recorded first, comparing interventions is retrospective.
      expected_outcome TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN (${INTERVENTION_OUTCOME_LIST})),
      evidence_summary TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS intervention_runs_run_id ON intervention_runs(run_id);
    CREATE INDEX IF NOT EXISTS intervention_runs_open
      ON intervention_runs(student_id, subject, concept_id, completed_at);

    -- Learning events for waste meter / timeback tracking
    CREATE TABLE IF NOT EXISTS learning_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- The event's own identity, stable and independent of the rowid. What a
      -- consumer outside this database refers to, and what makes recording
      -- idempotent.
      event_id TEXT,
      -- Which version of the Learning Event Contract this row was written
      -- under. See event-contract.ts.
      schema_version INTEGER NOT NULL DEFAULT 1,
      student_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (${EVENT_TYPES})),
      -- Who observed this. 'server' is a fact the engine knows; 'browser' is a
      -- report that may never have arrived.
      source TEXT NOT NULL DEFAULT 'browser',
      -- What the event is about, when it is about an attempt. Joins the stream
      -- back to the evidence.
      attempt_id INTEGER,
      -- When it happened, as against created_at, when we heard about it. Equal
      -- for server events; a browser report can arrive much later.
      occurred_at TEXT,
      -- A client's retry token, never its identity: unique per student, so one
      -- learner's replay can never suppress another's event.
      dedupe_key TEXT,
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
      -- The attempt that earned it, so an award can be traced back to the
      -- evidence for it and cannot be granted twice for the same attempt.
      attempt_id INTEGER REFERENCES assessment_attempts(id),
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

    -- Failed authentication attempts, for rate limiting. Identifiers are
    -- peppered SHA-256, never the email or IP itself.
    CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL CHECK (scope IN ('login', 'signup')),
      kind TEXT NOT NULL CHECK (kind IN ('email', 'ip')),
      identifier TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- What model calls cost, so a deployment can hold a ceiling.
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purpose TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
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
  await applyMigrations([
    { id: '001-legacy-columns-and-tables', run: () => runAdditiveStatements(migrations) },
    { id: '002-assessment-item-bank', run: migrateAssessmentItemBank },
    { id: '003-generated-lessons-per-language', run: migrateGeneratedLessonsToPerLanguage },
    { id: '004-assessment-responses-unique', run: ensureAssessmentResponsesUniqueConstraint },
    { id: '005-xp-awards-attempt-id', run: migrateXpAwardsAttemptId },
    { id: '006-auth-attempts', run: migrateAuthAttempts },
    { id: '007-llm-usage', run: migrateLlmUsage },
    { id: '008-learning-event-source', run: migrateLearningEventSource },
    { id: '009-learning-event-envelope', run: migrateLearningEventEnvelope },
    { id: '010-interventions', run: migrateInterventions },
    { id: '011-intervention-target', run: migrateInterventionTarget },
  ]);
}

export default { executeSql, initializeSchema };
