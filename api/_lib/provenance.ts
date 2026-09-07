/**
 * Where a piece of content came from, and what may legally be done with it.
 *
 * This is item 1.6, and the PRD calls it the **legal prerequisite** of 1.7
 * rather than tidying. The reason is one-directional: once content from an
 * outside corpus is published to learners, "which parts of our curriculum came
 * from where, under what licence" has to be answerable — and if the answer was
 * not recorded at import time it cannot be reconstructed afterwards. There is
 * no migration that recovers a licence nobody wrote down.
 *
 * So the model and the gate land *before* the first importer, and 1.7 arrives
 * into a system that already refuses to publish content it cannot account for.
 *
 * ## Every source here means something today
 *
 * `original`, `contributed` and `generated` describe content that already
 * exists in this repository. `external` is the one that has no producer yet —
 * deliberately, because the entire point of the item is that the rule exists
 * before the importer does. It is the rule that arrives early, not a column
 * waiting for a feature.
 */

export const CONTENT_SOURCES = [
  /** Written for this project. The 141 seeded concepts are this. */
  'original',
  /** Written by a teacher through the contribution flow. */
  'contributed',
  /** Written by a model. */
  'generated',
  /** Imported from an outside corpus. Requires url, licence and attribution. */
  'external',
] as const;

export type ContentSource = typeof CONTENT_SOURCES[number];

/**
 * Licences this platform knows how to honour.
 *
 * Not a general SPDX list: a licence nobody has thought about is a licence
 * nobody is complying with, so the set is what has actually been considered.
 */
export const CONTENT_LICENSES = [
  /** Public domain dedication. Wikidata. */
  'CC0-1.0',
  /** Attribution required. */
  'CC-BY-4.0',
  /** Attribution *and* share-alike. Wikipedia. See SHARE_ALIKE below. */
  'CC-BY-SA-4.0',
  'MIT',
  /** Ours, or licensed to us directly. */
  'proprietary',
] as const;

export type ContentLicense = typeof CONTENT_LICENSES[number];

/**
 * Licences that oblige derivative work to carry the same terms.
 *
 * Refused for now, and this is a product decision rather than a legal one I am
 * qualified to make: the PRD says to start with Wikidata's CC0 and leave
 * Wikipedia's share-alike alone *while the licence model is new*, because
 * share-alike reaches into what the platform builds on top of the content, not
 * only the content. Lifting this is a one-line change and a deliberate one.
 */
export const SHARE_ALIKE: readonly string[] = ['CC-BY-SA-4.0'];

export interface Provenance {
  source: ContentSource;
  sourceUrl?: string | null;
  /** The upstream revision, so "which version did we import" has an answer. */
  sourceVersion?: string | null;
  license?: ContentLicense | null;
  /** The credit line, as it must be shown to a learner. */
  attribution?: string | null;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The problem that makes this provenance unpublishable, or undefined.
 *
 * Returns a sentence rather than a code because it is shown to the person
 * trying to publish, and "provenance_invalid" tells them nothing about what to
 * fix.
 */
export function provenanceProblem(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return 'has no provenance recorded, so nobody can say where it came from';
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'has provenance that is not an object';
  }

  const provenance = value as Record<string, unknown>;
  const source = provenance.source;

  if (!isNonEmpty(source) || !(CONTENT_SOURCES as readonly string[]).includes(source)) {
    return `names an unknown source "${String(source)}"`;
  }

  if (provenance.license !== undefined && provenance.license !== null) {
    if (!isNonEmpty(provenance.license) ||
        !(CONTENT_LICENSES as readonly string[]).includes(provenance.license)) {
      return `names a licence this platform has not considered: "${String(provenance.license)}"`;
    }
    if (SHARE_ALIKE.includes(provenance.license)) {
      return `is under ${provenance.license}, whose share-alike terms reach into what is built on top of it — not accepted while the licence model is new`;
    }
  }

  if (source === 'external') {
    // The three things that make outside content usable. Missing any one of
    // them means the import cannot be honoured, and none can be recovered
    // later by looking at the content.
    if (!isNonEmpty(provenance.sourceUrl)) {
      return 'comes from outside but records no source URL';
    }
    if (!/^https?:\/\//i.test(provenance.sourceUrl.trim())) {
      return `records a source URL that is not a web address: "${provenance.sourceUrl}"`;
    }
    if (!isNonEmpty(provenance.license)) {
      return 'comes from outside but records no licence';
    }
    if (!isNonEmpty(provenance.attribution)) {
      return 'comes from outside but records no attribution, which is what a learner has to be shown';
    }
  }

  if (source === 'contributed' && !isNonEmpty(provenance.attribution)) {
    return 'was contributed but records no attribution, so the contributor cannot be credited';
  }

  return undefined;
}

/**
 * The stored columns, as a Provenance.
 *
 * Prefixed `content_` in the schema because `interventions.source` already
 * means who *delivers* an intervention — a teacher can hand a learner
 * public-domain material, and those are two separate facts.
 */
export interface ProvenanceRow {
  content_source?: string | null;
  content_source_url?: string | null;
  content_source_version?: string | null;
  content_license?: string | null;
  content_attribution?: string | null;
}

/** Reads the stored columns as a Provenance, or undefined when unrecorded. */
export function provenanceFromRow(row: ProvenanceRow): Provenance | undefined {
  if (!isNonEmpty(row.content_source)) return undefined;
  return {
    source: row.content_source as ContentSource,
    sourceUrl: row.content_source_url ?? null,
    sourceVersion: row.content_source_version ?? null,
    license: (row.content_license as ContentLicense | null) ?? null,
    attribution: row.content_attribution ?? null,
  };
}
