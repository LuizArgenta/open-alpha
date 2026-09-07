/**
 * Bringing an outside corpus in.
 *
 * The PRD names Wikidata (CC0) as the first one, and the shape of that job is
 * not "call an API": corpora arrive as dumps, exports and conversions, and the
 * live query interface is the least likely way any real volume gets here. So
 * the seam is a **bundle** — a file in this project's own format — and turning
 * someone else's dump into a bundle is a converter, written when there is a
 * dump to convert.
 *
 * That split is deliberate rather than convenient. Building the importer
 * against a remembered guess at another service's wire format would produce
 * something that looks finished and has never met the thing it claims to read.
 * This project has found that shape enough times to stop choosing it. The
 * bundle format is ours, so the importer is tested against the thing it
 * actually consumes.
 *
 * ## What the importer is for
 *
 * Not "put rows in a table" — `admin/curriculum/concepts.ts` already does that
 * one at a time. It is the three things a bulk import needs and a single save
 * does not:
 *
 * 1. **Provenance on every concept**, defaulted from the corpus so a bundle of
 *    four hundred entries does not repeat the licence four hundred times, and
 *    refused if the corpus itself cannot account for its terms.
 * 2. **All or nothing.** A partial import of a graph leaves prerequisites
 *    pointing at concepts that were rejected — a curriculum that is worse than
 *    the one before the import.
 * 3. **Every problem at once.** Someone fixing a converter wants the list.
 */

import { validateConceptGraph } from './curriculum-validation.js';
import {
  type ContentLicense,
  type ContentSource,
  type Provenance,
  provenanceProblem,
} from './provenance.js';

/** The provenance every concept in a bundle inherits unless it says otherwise. */
export interface CorpusHeader {
  name: string;
  source: ContentSource;
  sourceUrl?: string;
  sourceVersion?: string;
  license?: ContentLicense;
  attribution?: string;
}

export interface BundledConcept {
  conceptId: string;
  name: string;
  description?: string;
  level: number;
  prerequisites?: string[];
  /** The enriched bundle, stored as authored. */
  content?: Record<string, unknown>;
  /** Where this particular entry came from, within the corpus. */
  sourceUrl?: string;
  sourceVersion?: string;
}

export interface CorpusBundle {
  corpus: CorpusHeader;
  subjectId: string;
  concepts: BundledConcept[];
}

export interface ImportProblem {
  conceptId: string | null;
  problem: string;
}

export interface PreparedConcept extends BundledConcept {
  provenance: Provenance;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a bundle and returns what to write, or everything wrong with it.
 *
 * Pure: no database, so the rules can be exercised without one, and so an
 * admin interface could show the problems before anything is attempted.
 */
export function prepareBundle(
  value: unknown,
  existingConcepts: Array<{ id: string; name: string; level: number; prerequisites: string[] }> = []
): { concepts: PreparedConcept[] } | { problems: ImportProblem[] } {
  if (!isObject(value)) return { problems: [{ conceptId: null, problem: 'the bundle is not an object' }] };

  const bundle = value as unknown as CorpusBundle;
  const problems: ImportProblem[] = [];

  if (!isObject(bundle.corpus)) {
    return { problems: [{ conceptId: null, problem: 'the bundle names no corpus' }] };
  }
  if (typeof bundle.subjectId !== 'string' || bundle.subjectId.trim() === '') {
    problems.push({ conceptId: null, problem: 'the bundle names no subject' });
  }
  if (!Array.isArray(bundle.concepts) || bundle.concepts.length === 0) {
    return { problems: [...problems, { conceptId: null, problem: 'the bundle has no concepts' }] };
  }

  const prepared: PreparedConcept[] = [];
  const seen = new Set<string>();

  for (const entry of bundle.concepts) {
    if (!isObject(entry) || typeof entry.conceptId !== 'string' || !ID_PATTERN.test(entry.conceptId)) {
      problems.push({ conceptId: null, problem: `"${String((entry as BundledConcept)?.conceptId)}" is not a usable concept id` });
      continue;
    }
    const conceptId = entry.conceptId;
    if (seen.has(conceptId)) {
      problems.push({ conceptId, problem: 'appears twice in the same bundle' });
      continue;
    }
    seen.add(conceptId);

    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      problems.push({ conceptId, problem: 'has no name' });
      continue;
    }
    if (!Number.isInteger(entry.level) || entry.level < 0) {
      problems.push({ conceptId, problem: `has level "${String(entry.level)}", which is not a grade` });
      continue;
    }

    // Corpus provenance, with the entry allowed to point at its own page and
    // revision. A bundle of four hundred entries should not repeat a licence
    // four hundred times, but each one still says which page it came from.
    const provenance: Provenance = {
      source: bundle.corpus.source,
      sourceUrl: entry.sourceUrl ?? bundle.corpus.sourceUrl ?? null,
      sourceVersion: entry.sourceVersion ?? bundle.corpus.sourceVersion ?? null,
      license: bundle.corpus.license ?? null,
      attribution: bundle.corpus.attribution ?? null,
    };

    const problem = provenanceProblem(provenance);
    if (problem) {
      problems.push({ conceptId, problem });
      continue;
    }

    prepared.push({ ...entry, prerequisites: entry.prerequisites ?? [], provenance });
  }

  if (problems.length > 0) return { problems };

  /**
   * The graph as it would be *after* the import, including what is already
   * there. A bundle can be internally consistent and still point at
   * prerequisites the subject does not have.
   */
  const proposed = [
    ...existingConcepts.filter(concept => !seen.has(concept.id)),
    ...prepared.map(entry => ({
      id: entry.conceptId,
      name: entry.name,
      level: entry.level,
      prerequisites: entry.prerequisites ?? [],
    })),
  ];

  const graphProblems = validateConceptGraph(proposed);
  if (graphProblems.length > 0) {
    return {
      problems: graphProblems.map(problem => ({
        conceptId: problem.conceptId ?? null,
        problem: problem.detail,
      })),
    };
  }

  return { concepts: prepared };
}
