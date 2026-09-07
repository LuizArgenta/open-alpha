import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { type SqlStatement, executeSql, executeTransaction } from './db.js';
import { type RecordProblem, parseConceptRecord } from './curriculum-record.js';

// ── Enriched content types ────────────────────────────────────────────────────

export interface ConceptExplanation {
  text: string;
  childVersion?: string;
  adultVersion?: string;
}

export interface AlternateExplanation {
  type: 'visual' | 'analogy' | 'realWorld' | 'stepByStep' | 'formal';
  text: string;
}

export interface WorkedExample {
  problem: string;
  steps: string[];
  answer: string;
}

export interface GuidedPracticeItem {
  id: string;
  prompt: string;
  answer: string;
  hint: string;
  feedback: {
    correct: string;
    incorrect: string;
  };
}

export interface MasteryQuestion {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  /** Item-bank metadata. Optional so existing curriculum remains valid. */
  difficultyTag?: 'easy' | 'medium' | 'hard';
  purpose?: 'practice' | 'check' | 'mastery' | 'review';
  skillTag?: string;
  reasoningType?: string;
  distractorRationale?: Record<string, string>;
  distractorErrorCode?: Record<string, string>;
  pedagogicalRationale?: string;
}

export interface MasteryCheck {
  passingScore: number;
  questions: MasteryQuestion[];
}

export interface RemediationPath {
  action: 'review_prerequisites' | 'simpler_explanation' | 'sub_skill' | 'extra_practice';
  conceptId?: string;
  message: string;
}

export interface ConceptMetadata {
  tags?: string[];
  estimatedMinutes?: number;
  gradeBand?: string;
  difficulty?: 'foundational' | 'standard' | 'advanced';
}

// ── Core types ────────────────────────────────────────────────────────────────

export interface Concept {
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  gradeLevel: number;
  // Enriched fields — present only on fully-built concept bundles
  objective?: string;
  explanation?: ConceptExplanation;
  alternateExplanations?: AlternateExplanation[];
  workedExamples?: WorkedExample[];
  guidedPractice?: GuidedPracticeItem[];
  masteryCheck?: MasteryCheck;
  remediationPath?: RemediationPath;
  whyItMatters?: string;
  metadata?: ConceptMetadata;
}

export interface Subject {
  id: string;
  name: string;
  description: string;
  concepts: Concept[];
}

// ── Loading ───────────────────────────────────────────────────────────────────
//
// The curriculum lives in the database so it can be authored at runtime, and
// the JSON files remain its seed and its fallback. Reading stays synchronous:
// this module is the seam every consumer goes through, and making it async
// would spread `await` across all of them for no gain. The graph is loaded
// once per serverless instance, exactly as the file loader always did.

/** Shape of the enriched fields, as stored and as authored. */
const ENRICHED_FIELDS = [
  'objective',
  'explanation',
  'alternateExplanations',
  'workedExamples',
  'guidedPractice',
  'masteryCheck',
  'remediationPath',
  'whyItMatters',
  'metadata',
] as const;

function pickEnriched(source: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of ENRICHED_FIELDS) {
    if (source[field] !== undefined) content[field] = source[field];
  }
  return content;
}

export function loadSubjectsFromFiles(): Subject[] {
  const curriculumDir = join(process.cwd(), 'curriculum');
  // Only load files that are subject definitions (have a concepts array).
  // Exclude any *schema*.json files (schema.json, contribution-schema.json, etc.)
  const files = readdirSync(curriculumDir).filter(
    f => f.endsWith('.json') && !f.includes('schema')
  );

  const result: Subject[] = [];
  for (const file of files) {
    const raw = readFileSync(join(curriculumDir, file), 'utf-8');
    const data = JSON.parse(raw);
    // Skip files that aren't subject definitions
    if (!data.id || !Array.isArray(data.concepts)) continue;
    result.push({
      id: data.id,
      name: data.name,
      description: data.description,
      concepts: data.concepts.map((c: Record<string, unknown>) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        prerequisites: c.prerequisites,
        gradeLevel: c.level,
        // Pass enriched fields through when present
        ...(c.objective !== undefined && { objective: c.objective }),
        ...(c.explanation !== undefined && { explanation: c.explanation }),
        ...(c.alternateExplanations !== undefined && { alternateExplanations: c.alternateExplanations }),
        ...(c.workedExamples !== undefined && { workedExamples: c.workedExamples }),
        ...(c.guidedPractice !== undefined && { guidedPractice: c.guidedPractice }),
        ...(c.masteryCheck !== undefined && { masteryCheck: c.masteryCheck }),
        ...(c.remediationPath !== undefined && { remediationPath: c.remediationPath }),
        ...(c.whyItMatters !== undefined && { whyItMatters: c.whyItMatters }),
        ...(c.metadata !== undefined && { metadata: c.metadata }),
      })),
    });
  }
  return result;
}

interface ConceptRow {
  subject_id: string;
  concept_id: string;
  name: string;
  description: string | null;
  level: number;
  prerequisites: string;
  content: string;
}

interface SubjectRow {
  id: string;
  name: string;
  description: string | null;
}

export interface DatabaseCurriculum {
  subjects: Subject[];
  /** Records that were stored but could not be trusted, and why. */
  problems: RecordProblem[];
}

/**
 * Published curriculum from the database, with the unusable records left out
 * rather than allowed to take the read down.
 *
 * `content` and `prerequisites` are JSON blobs and JSON.parse throws, so one
 * corrupted row used to fail the whole query — and the caller, seeing a failed
 * read, swapped the entire curriculum for the fallback files. One damaged
 * concept now costs one concept, and says so.
 */
export async function readCurriculumFromDatabase(): Promise<DatabaseCurriculum> {
  const subjectRows = await executeSql<SubjectRow>(
    `SELECT id, name, description FROM curriculum_subjects WHERE status = 'published' ORDER BY id`
  );
  if (subjectRows.rows.length === 0) return { subjects: [], problems: [] };

  const conceptRows = await executeSql<ConceptRow>(
    `SELECT subject_id, concept_id, name, description, level, prerequisites, content
     FROM curriculum_concepts WHERE status = 'published'
     ORDER BY subject_id, level, concept_id`
  );

  const bySubject = new Map<string, Concept[]>();
  const problems: RecordProblem[] = [];

  for (const row of conceptRows.rows) {
    const parsed = parseConceptRecord(row);
    if ('problem' in parsed) {
      problems.push(parsed.problem);
      continue;
    }

    const concept: Concept = {
      id: row.concept_id,
      name: row.name,
      description: row.description ?? '',
      prerequisites: parsed.record.prerequisites,
      gradeLevel: row.level,
      ...(parsed.record.content as Partial<Concept>),
    };
    bySubject.set(row.subject_id, [...(bySubject.get(row.subject_id) ?? []), concept]);
  }

  return {
    subjects: subjectRows.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      concepts: bySubject.get(row.id) ?? [],
    })),
    problems,
  };
}

/** The graph alone, for callers that only want to compare it to the files. */
export async function loadSubjectsFromDatabase(): Promise<Subject[]> {
  return (await readCurriculumFromDatabase()).subjects;
}

/**
 * The content hash of a concept as published.
 *
 * Re-running the import used to bump `version` on every concept every time,
 * because the write was unconditional. Version then measured how many times
 * the import had run, not how many times the concept had changed — which is
 * the one thing a version is for when a teacher asks "what did the students
 * see last term?".
 */
export function conceptContentHash(concept: {
  name: string;
  description: string;
  gradeLevel: number;
  prerequisites: string[];
  content: Record<string, unknown>;
}): string {
  // Key order is the author's, not meaningful, so it must not change the hash.
  const canonical = JSON.stringify(
    {
      name: concept.name,
      description: concept.description,
      level: concept.gradeLevel,
      prerequisites: [...concept.prerequisites].sort(),
      content: concept.content,
    },
    (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
        : value
  );

  return createHash('sha256').update(canonical).digest('hex');
}

export interface ImportResult {
  subjects: number;
  /** Concepts written: created plus genuinely changed. */
  concepts: number;
  created: number;
  updated: number;
  /** Concepts already stored with identical content, left untouched. */
  unchanged: number;
}

/**
 * Copies the JSON files into the database, as one transaction.
 *
 * It used to write concept by concept: an import interrupted halfway left the
 * curriculum half-old and half-new, with no way to tell which half a student
 * had been served. Nothing here needs the database's answer mid-way, so the
 * whole thing is prepared and then applied at once.
 *
 * Idempotent in the strong sense now: a concept whose content hash already
 * matches is not written at all, so re-running does not touch `version` or
 * `updated_at`.
 */
export async function importCurriculumFromFiles(): Promise<ImportResult> {
  const fromFiles = loadSubjectsFromFiles();

  const stored = await executeSql<{ subject_id: string; concept_id: string; content_hash: string | null }>(
    'SELECT subject_id, concept_id, content_hash FROM curriculum_concepts'
  );
  const hashes = new Map(
    stored.rows.map(row => [`${row.subject_id}/${row.concept_id}`, row.content_hash])
  );

  const writes: SqlStatement[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const subject of fromFiles) {
    writes.push({
      sql: `INSERT INTO curriculum_subjects (id, name, description, status)
       VALUES ($1, $2, $3, 'published')
       ON CONFLICT(id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         updated_at = datetime('now')`,
      params: [subject.id, subject.name, subject.description],
    });

    for (const concept of subject.concepts) {
      const { id, name, description, prerequisites, gradeLevel, ...enriched } = concept;
      const content = pickEnriched(enriched as Record<string, unknown>);
      const hash = conceptContentHash({ name, description, gradeLevel, prerequisites, content });

      const key = `${subject.id}/${id}`;
      if (hashes.has(key)) {
        if (hashes.get(key) === hash) {
          unchanged++;
          continue;
        }
        updated++;
      } else {
        created++;
      }

      writes.push({
        sql: `INSERT INTO curriculum_concepts
           (subject_id, concept_id, name, description, level, prerequisites, content, content_hash, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published')
         ON CONFLICT(subject_id, concept_id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           level = EXCLUDED.level,
           prerequisites = EXCLUDED.prerequisites,
           content = EXCLUDED.content,
           content_hash = EXCLUDED.content_hash,
           version = curriculum_concepts.version + 1,
           updated_at = datetime('now')`,
        params: [
          subject.id,
          id,
          name,
          description,
          gradeLevel,
          JSON.stringify(prerequisites),
          JSON.stringify(content),
          hash,
        ],
      });
    }
  }

  await executeTransaction(writes);

  return {
    subjects: fromFiles.length,
    concepts: created + updated,
    created,
    updated,
    unchanged,
  };
}

/**
 * Where the curriculum in memory came from, and whether that is where it was
 * supposed to come from.
 *
 * The fallback used to be silent: a database failure in production served the
 * seed files and nobody knew. That is the worst shape a failure can take here.
 * The files are a *valid* curriculum, so nothing crashes and nothing looks
 * wrong — while every tree an admin authored at runtime has vanished, students
 * are being taught from a curriculum nobody chose, and progress rows point at
 * concepts the running graph no longer contains. A crash would have been
 * noticed in minutes; this can run for weeks.
 */
export type CurriculumOrigin = 'database' | 'files';

export type CurriculumDegradation =
  /** The database answered, and had no published curriculum in it. */
  | 'database_empty'
  /** The database could not be read at all. */
  | 'database_error';

export interface CurriculumStatus {
  origin: CurriculumOrigin;
  /** True whenever the files are being served in the database's place. */
  degraded: boolean;
  reason?: CurriculumDegradation;
  /** The failure, kept for whoever has to fix it. Never shown to students. */
  error?: string;
  loadedAt: string;
  subjects: number;
  concepts: number;
  /**
   * Records that were stored but unusable, and so are missing from the graph.
   * Not degraded — the rest of the curriculum is the one that was published —
   * but a student whose progress points at one of these has nowhere to go.
   */
  invalidRecords: RecordProblem[];
  /**
   * Fingerprint of the published curriculum this graph was built from. What a
   * refresh compares against to decide whether it has anything to do.
   */
  revision: string;
  /** When this instance last checked whether it was out of date. */
  checkedAt: string;
  /** Why the last check could not be made, when it could not. */
  refreshError?: string;
}

function countConcepts(loaded: Subject[]): number {
  return loaded.reduce((total, subject) => total + subject.concepts.length, 0);
}

/**
 * Set when serving the files is not acceptable — a school in operation would
 * rather be down than teach from a curriculum nobody chose.
 *
 * On by default in production, off everywhere else so a fresh install and the
 * test suite still boot. It used to be off everywhere, which meant the one
 * deployment that most needs the guarantee was the one where forgetting a
 * variable silently taught from the seed files, with a warning only in the
 * log. Opting *out* in production stays possible and now has to be deliberate.
 */
function databaseIsRequired(): boolean {
  const configured = process.env.CURRICULUM_REQUIRE_DATABASE;
  if (configured !== undefined) return configured === 'true';
  return process.env.NODE_ENV === 'production';
}

export class CurriculumUnavailableError extends Error {
  constructor(reason: CurriculumDegradation, cause?: unknown) {
    super(
      reason === 'database_empty'
        ? 'Curriculum database is empty and CURRICULUM_REQUIRE_DATABASE is set. Run the import before serving.'
        : `Curriculum database is unreadable and CURRICULUM_REQUIRE_DATABASE is set: ${String(cause)}`
    );
    this.name = 'CurriculumUnavailableError';
  }
}

/**
 * Database first, files second — but never quietly. A fresh install and a
 * production outage both end up on the files; only the second one is an
 * emergency, and the difference has to be legible from outside the process.
 */
export async function resolveCurriculum(): Promise<{ loaded: Subject[]; status: CurriculumStatus }> {
  const at = new Date().toISOString();

  const degrade = (reason: CurriculumDegradation, cause?: unknown): { loaded: Subject[]; status: CurriculumStatus } => {
    if (databaseIsRequired()) throw new CurriculumUnavailableError(reason, cause);

    const loaded = loadSubjectsFromFiles();
    // Deliberately loud and greppable: this line is the only warning anyone
    // gets before students start seeing a curriculum nobody published.
    console.error(
      `[CURRICULUM_DEGRADED] serving ${loaded.length} subjects from files instead of the database (${reason})`,
      cause ?? ''
    );
    return {
      loaded,
      status: {
        origin: 'files',
        degraded: true,
        reason,
        error: cause === undefined ? undefined : String(cause),
        loadedAt: at,
        checkedAt: at,
        subjects: loaded.length,
        concepts: countConcepts(loaded),
        invalidRecords: [],
        // No revision: the files have none, so the next check has something to
        // differ from and will try the database again.
        revision: '',
      },
    };
  };

  let fromDatabase: DatabaseCurriculum;
  let revision: string;
  try {
    revision = await publishedRevision();
    fromDatabase = await readCurriculumFromDatabase();
  } catch (error) {
    return degrade('database_error', error);
  }

  if (fromDatabase.subjects.length === 0) return degrade('database_empty');

  if (fromDatabase.problems.length > 0) {
    // Loud for the same reason as the degraded line: nothing else about a
    // dropped concept is visible from the outside.
    console.error(
      `[CURRICULUM_INVALID_RECORDS] ${fromDatabase.problems.length} stored concepts were skipped`,
      fromDatabase.problems
    );
  }

  return {
    loaded: fromDatabase.subjects,
    status: {
      origin: 'database',
      degraded: false,
      loadedAt: at,
      checkedAt: at,
      subjects: fromDatabase.subjects.length,
      concepts: countConcepts(fromDatabase.subjects),
      invalidRecords: fromDatabase.problems,
      revision,
    },
  };
}

/**
 * A fingerprint of the published curriculum, derived rather than declared.
 *
 * A revision column someone has to remember to bump is a revision column
 * someone will forget to bump — and the failure is invisible, because the
 * curriculum simply stays stale. Counts, version sum and the latest
 * updated_at move on every publish, edit, unpublish and delete, and no writer
 * has to know this function exists.
 */
export async function publishedRevision(): Promise<string> {
  const row = await executeSql<{
    subject_count: number;
    concept_count: number;
    version_sum: number;
    concept_updated: string;
    subject_updated: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM curriculum_subjects WHERE status = 'published') as subject_count,
       (SELECT COUNT(*) FROM curriculum_concepts WHERE status = 'published') as concept_count,
       (SELECT COALESCE(SUM(version), 0) FROM curriculum_concepts WHERE status = 'published') as version_sum,
       (SELECT COALESCE(MAX(updated_at), '') FROM curriculum_concepts) as concept_updated,
       (SELECT COALESCE(MAX(updated_at), '') FROM curriculum_subjects) as subject_updated`
  );

  const r = row.rows[0];
  return [r.subject_count, r.concept_count, r.version_sum, r.concept_updated, r.subject_updated].join('|');
}

// Loaded once at module evaluation, so every read below stays synchronous for
// its callers, and refreshed in the background from there.
const resolved = await resolveCurriculum();

/**
 * The graph every read goes through.
 *
 * Replaced in place rather than reassigned: a dozen endpoints import this
 * binding directly, and mutating the array they already hold is the one way to
 * update all of them without asking each to change how it reads.
 */
export const subjects: Subject[] = resolved.loaded;

/** What the load actually did. Read by the health endpoint and the tests. */
export const curriculumStatus: CurriculumStatus = resolved.status;

function adoptCurriculum(next: { loaded: Subject[]; status: CurriculumStatus }): void {
  subjects.length = 0;
  subjects.push(...next.loaded);
  Object.assign(curriculumStatus, next.status);
}

// ── Staying current ──────────────────────────────────────────────────────────
//
// The curriculum was loaded at cold start and never looked at again. Each
// serverless instance therefore served whatever was published the moment it
// happened to boot: an admin could publish a concept, reload the page, see it
// listed, and students on an older instance would go on not seeing it for
// hours — with no error anywhere and no way to tell which students were
// affected.
//
// Reads stay synchronous, so the check cannot block them. Instead a read marks
// the graph as worth checking and the check runs alongside the request: an
// instance is at worst one request behind, instead of permanently behind.
// Anywhere that is not good enough — publishing, mainly — awaits
// refreshCurriculum() directly.

const DEFAULT_REFRESH_SECONDS = 30;

function refreshIntervalMs(): number {
  const configured = Number(process.env.CURRICULUM_REFRESH_SECONDS);
  const seconds = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_REFRESH_SECONDS;
  return seconds * 1000;
}

let lastCheckedMs = Date.now();
let inFlight: Promise<void> | null = null;

/**
 * Reloads the graph if the published curriculum has moved on.
 *
 * `force` skips the throttle, not the comparison: a check that finds the same
 * revision still costs one small aggregate query and no rebuild.
 */
export async function refreshCurriculum({ force = false } = {}): Promise<boolean> {
  if (!force && Date.now() - lastCheckedMs < refreshIntervalMs()) return false;
  if (inFlight) {
    await inFlight;
    return false;
  }

  let changed = false;
  inFlight = (async () => {
    lastCheckedMs = Date.now();
    try {
      const revision = await publishedRevision();
      curriculumStatus.checkedAt = new Date().toISOString();
      delete curriculumStatus.refreshError;

      // A degraded instance re-checks on every pass: it is serving the files,
      // so any revision at all is better than what it has.
      if (!curriculumStatus.degraded && revision === curriculumStatus.revision) return;

      adoptCurriculum(await resolveCurriculum());
      changed = true;
    } catch (error) {
      // A failed check is not a reason to throw away a curriculum that works.
      curriculumStatus.refreshError = String(error);
      console.error('[CURRICULUM_REFRESH_FAILED]', error);
    } finally {
      inFlight = null;
    }
  })();

  await inFlight;
  return changed;
}

/**
 * Called by the synchronous readers. Starts a check without waiting for it, so
 * a request never pays for the reload it triggers — the next one gets the
 * fresh graph.
 */
function noteRead(): void {
  if (Date.now() - lastCheckedMs < refreshIntervalMs()) return;
  void refreshCurriculum();
}

export function getSubject(subjectId: string): Subject | undefined {
  noteRead();
  return subjects.find(s => s.id === subjectId);
}

export function getConcept(subjectId: string, conceptId: string): Concept | undefined {
  const subject = getSubject(subjectId);
  return subject?.concepts.find(c => c.id === conceptId);
}

export function getConceptsForGrade(subjectId: string, gradeLevel: number): Concept[] {
  const subject = getSubject(subjectId);
  if (!subject) return [];
  const filtered = subject.concepts.filter(c => c.gradeLevel <= gradeLevel);
  // If grade-based filtering returns nothing (e.g., a K-12 student browsing
  // an adult subject), return all concepts so the subject isn't empty
  if (filtered.length === 0) return subject.concepts;
  return filtered;
}

export const MASTERY_THRESHOLD = 80;

// Three failed attempts is where "try again" stops being useful and the gap is
// more likely to be in a prerequisite than in this concept.
const STRUGGLE_ATTEMPTS = 3;

export interface ProgressRecord {
  conceptId: string;
  masteryScore: number;
  attempts: number;
}

export function toProgressMap(progress: ProgressRecord[]): Map<string, ProgressRecord> {
  return new Map(progress.map(record => [record.conceptId, record]));
}

/**
 * Walks up the prerequisite chain and returns the nearest concept the student
 * has never demonstrated. Nearest rather than deepest on purpose: sending a
 * 7th grader straight back to counting on the first stumble is worse than
 * stepping back one link at a time.
 */
function findUnverifiedPrerequisite(
  subjectId: string,
  concept: Concept,
  progressById: Map<string, ProgressRecord>
): Concept | undefined {
  const queue = [...concept.prerequisites];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const prerequisiteId = queue.shift()!;
    if (seen.has(prerequisiteId)) continue;
    seen.add(prerequisiteId);

    const prerequisite = getConcept(subjectId, prerequisiteId);
    if (!prerequisite) continue;
    if (!progressById.has(prerequisiteId)) return prerequisite;

    queue.push(...prerequisite.prerequisites);
  }

  return undefined;
}

/**
 * The weakest *direct* prerequisite: never attempted first, otherwise lowest
 * mastery. Deliberately does not walk further up the chain — an authored
 * remediation message names the concept right below this one, so pointing the
 * student at a distant ancestor would contradict the text they are reading.
 */
function findWeakestPrerequisite(
  subjectId: string,
  concept: Concept,
  progressById: Map<string, ProgressRecord>
): Concept | undefined {
  let weakest: Concept | undefined;
  let weakestScore = Infinity;

  for (const prerequisiteId of concept.prerequisites) {
    const prerequisite = getConcept(subjectId, prerequisiteId);
    if (!prerequisite) continue;

    // Never attempted is weaker than any score.
    const record = progressById.get(prerequisiteId);
    const score = record ? record.masteryScore : -1;

    if (score < weakestScore) {
      weakest = prerequisite;
      weakestScore = score;
    }
  }

  return weakest;
}

/** Why the engine chose this concept — moving on, or reaching back. */
export type SelectionReason = 'next_in_sequence' | 'prerequisite_gap';

export interface ConceptSelection {
  concept: Concept;
  reason: SelectionReason;
}

/**
 * The next concept **and why it was chosen**.
 *
 * The reason has to come from here, because only this function knows. The
 * caller used to infer it — "no progress row for this concept and some
 * progress elsewhere, therefore the engine stepped back" — and that is wrong
 * in the ordinary case: a student who masters one concept moves to the next
 * *unseen* one, which by definition has no progress row. Every normal
 * advancement was recorded as `prerequisite_gap`.
 *
 * It was a mislabelled row in the decision log until item 1.4 made the reason
 * drive the action a learner is given, at which point mastering something told
 * them to go back and review it.
 */
export function selectNextConcept(
  subjectId: string,
  progress: ProgressRecord[],
  gradeLevel: number
): ConceptSelection | undefined {
  const availableConcepts = getConceptsForGrade(subjectId, gradeLevel);
  const progressById = toProgressMap(progress);
  const completedConceptIds = progress
    .filter(record => record.masteryScore >= MASTERY_THRESHOLD)
    .map(record => record.conceptId);

  const candidate = selectCandidate(availableConcepts, completedConceptIds, gradeLevel);
  if (!candidate) return undefined;

  // Repeated failures on the same concept usually mean a missing prerequisite,
  // not a need to see the same material a fourth time. This branch — and only
  // this branch — is the engine stepping back.
  const record = progressById.get(candidate.id);
  if (record && record.attempts >= STRUGGLE_ATTEMPTS && record.masteryScore < MASTERY_THRESHOLD) {
    const gap = findUnverifiedPrerequisite(subjectId, candidate, progressById);
    if (gap) return { concept: gap, reason: 'prerequisite_gap' };
  }

  return { concept: candidate, reason: 'next_in_sequence' };
}

export function getNextConcept(
  subjectId: string,
  progress: ProgressRecord[],
  gradeLevel: number
): Concept | undefined {
  return selectNextConcept(subjectId, progress, gradeLevel)?.concept;
}

function selectCandidate(
  availableConcepts: Concept[],
  completedConceptIds: string[],
  gradeLevel: number
): Concept | undefined {
  // If student has no progress, start them at their grade level (not kindergarten)
  if (completedConceptIds.length === 0) {
    // First, try to find a concept AT their grade level
    const gradeAppropriate = availableConcepts.find(concept => {
      if (concept.gradeLevel !== gradeLevel) return false;
      // Check if all prerequisites are below their grade (assumed mastered)
      return concept.prerequisites.every(prereqId => {
        const prereq = availableConcepts.find(c => c.id === prereqId);
        return prereq && prereq.gradeLevel < gradeLevel;
      });
    });

    if (gradeAppropriate) return gradeAppropriate;

    // If no concept at exact grade level, find the highest grade concept they can start
    const sortedByGrade = [...availableConcepts]
      .sort((a, b) => b.gradeLevel - a.gradeLevel);

    return sortedByGrade.find(concept => {
      return concept.prerequisites.every(prereqId => {
        const prereq = availableConcepts.find(c => c.id === prereqId);
        return prereq && prereq.gradeLevel < gradeLevel;
      });
    });
  }

  // If they have progress, use normal progression logic
  return availableConcepts.find(concept => {
    if (completedConceptIds.includes(concept.id)) return false;
    return concept.prerequisites.every(prereq => completedConceptIds.includes(prereq));
  });
}

export interface ResolvedRemediation {
  action: RemediationPath['action'];
  /**
   * Authored text, in whatever language the curriculum was written in. Absent
   * when the engine had to synthesise the guidance, in which case messageKey
   * carries a translation key instead.
   */
  message?: string;
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  conceptId?: string;
  conceptName?: string;
}

/**
 * Turns the concept's authored remediationPath into something the UI can act
 * on: a message plus, where the action points somewhere, the concept to go to.
 * Concepts without an authored path still get a useful answer when the student
 * has a visibly weak prerequisite.
 */
export function resolveRemediation(
  subjectId: string,
  concept: Concept,
  progressById: Map<string, ProgressRecord>
): ResolvedRemediation | undefined {
  const path = concept.remediationPath;

  if (path?.action === 'sub_skill' && path.conceptId) {
    const target = getConcept(subjectId, path.conceptId);
    return {
      action: path.action,
      message: path.message,
      conceptId: path.conceptId,
      conceptName: target?.name,
    };
  }

  if (path?.action === 'review_prerequisites') {
    const target = findWeakestPrerequisite(subjectId, concept, progressById);
    return {
      action: path.action,
      message: path.message,
      conceptId: target?.id,
      conceptName: target?.name,
    };
  }

  if (path) {
    return { action: path.action, message: path.message };
  }

  const target = findWeakestPrerequisite(subjectId, concept, progressById);
  if (!target) return undefined;

  return {
    action: 'review_prerequisites',
    messageKey: 'remediation.reviewPrerequisite',
    messageParams: { concept: target.name },
    conceptId: target.id,
    conceptName: target.name,
  };
}

// ── On-demand lesson resolution ──────────────────────────────────────────────

interface CachedLessonRow {
  content: string;
}

/**
 * Returns a concept enriched with lesson content from any available source:
 *   1. Pre-authored JSON (already on the concept object)
 *   2. Cached generated lesson from the DB
 *
 * Does NOT trigger generation — that's the job of the /api/curriculum/lesson endpoint.
 * This function is for internal use (e.g., the tutor chat) where we want the best
 * available content without blocking on LLM generation.
 */
export async function getConceptWithLesson(
  subjectId: string,
  conceptId: string,
  language: string = 'en'
): Promise<Concept | undefined> {
  const concept = getConcept(subjectId, conceptId);
  if (!concept) return undefined;

  // Authored content is written in English; a reader in another language is
  // better served by a cached translation when one exists.
  const authoredIsComplete =
    !!concept.explanation && !!concept.workedExamples?.length && !!concept.masteryCheck;
  if (authoredIsComplete && language === 'en') {
    return concept;
  }

  // Check for cached generated lesson in the requested language
  const cached = await executeSql<CachedLessonRow>(
    'SELECT content FROM generated_lessons WHERE subject_id = $1 AND concept_id = $2 AND language = $3',
    [subjectId, conceptId, language]
  );

  if (cached.rows.length > 0) {
    const lesson = JSON.parse(cached.rows[0].content);
    return {
      ...concept,
      objective: lesson.objective ?? concept.objective,
      explanation: lesson.explanation ?? concept.explanation,
      alternateExplanations: lesson.alternateExplanations ?? concept.alternateExplanations,
      workedExamples: lesson.workedExamples ?? concept.workedExamples,
      guidedPractice: lesson.guidedPractice ?? concept.guidedPractice,
      masteryCheck: lesson.masteryCheck ?? concept.masteryCheck,
      remediationPath: lesson.remediationPath ?? concept.remediationPath,
      whyItMatters: lesson.whyItMatters ?? concept.whyItMatters,
    };
  }

  // Nothing cached for this language — the authored content, or the stub
  return concept;
}
