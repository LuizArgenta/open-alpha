/**
 * Item 1.7 — one corpus, end to end, with attribution rendered to the learner.
 *
 * The corpus arrives as a **bundle**: a file in this project's own format. That
 * is not a shortcut around calling Wikidata's API, it is how corpora actually
 * move — dumps, exports and conversions, not live queries at import volume.
 * Turning someone else's dump into a bundle is a converter, written when there
 * is a dump to convert.
 *
 * The alternative was to build the importer against a remembered guess at
 * another service's wire format, which would produce something that looks
 * finished and has never met the thing it claims to read. This project has
 * found that shape enough times.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';
import { POST as saveSubject } from '../api/admin/curriculum/subjects.js';
import { POST as importCorpus } from '../api/admin/curriculum/import.js';
import { POST as publish } from '../api/admin/curriculum/publish.js';
import { prepareBundle } from '../api/_lib/corpus-import.js';
import { readCurriculumFromDatabase } from '../api/_lib/curriculum.js';

let adminToken: string;

function request(body: unknown) {
  return new Request('https://test.local/api/admin/curriculum/import', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as any };
}

const CORPUS = {
  name: 'Wikidata core science',
  source: 'external' as const,
  sourceUrl: 'https://www.wikidata.org/',
  sourceVersion: '2026-09-01',
  license: 'CC0-1.0' as const,
  attribution: 'Wikidata contributors, CC0 1.0',
};

const BUNDLE = {
  corpus: CORPUS,
  subjectId: 'nature',
  concepts: [
    { conceptId: 'cells', name: 'Células', level: 4, prerequisites: [] },
    {
      conceptId: 'photosynthesis',
      name: 'Fotossíntese',
      level: 5,
      prerequisites: ['cells'],
      sourceUrl: 'https://www.wikidata.org/wiki/Q11982',
      content: { objective: 'Explicar como plantas usam luz', explanation: { text: 'As plantas...' } },
    },
  ],
};

beforeEach(async () => {
  await resetDatabase();
  const adminId = await createUser('parent');
  await executeSql(`INSERT INTO staff_roles (user_id, role) VALUES ($1, 'admin')`, [adminId]);
  adminToken = signToken({ userId: adminId, role: 'parent' });
  await saveSubject(new Request('https://test.local/api/admin/curriculum/subjects', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'nature', name: 'Natureza' }),
  }));
});

describe('importing a corpus', () => {
  it('lands as drafts, and says so', async () => {
    const { status, body } = await json(await importCorpus(request(BUNDLE)));

    expect(status).toBe(200);
    expect(body).toMatchObject({ imported: 2, status: 'draft' });

    // Drafts, never published. The provenance gate lives at publish, and an
    // import that walked past it would defeat the item that had to land first.
    const rows = await executeSql<{ status: string }>(
      "SELECT status FROM curriculum_concepts WHERE subject_id = 'nature'"
    );
    expect(rows.rows.every(row => row.status === 'draft')).toBe(true);
  });

  it('carries the corpus licence onto every concept, and each page onto its own', async () => {
    await importCorpus(request(BUNDLE));

    const rows = await executeSql<{ concept_id: string; content_license: string; content_source_url: string }>(
      "SELECT concept_id, content_license, content_source_url FROM curriculum_concepts ORDER BY concept_id"
    );

    // A bundle of four hundred entries should not repeat a licence four
    // hundred times — but each entry still says which page it came from.
    expect(rows.rows.every(row => row.content_license === 'CC0-1.0')).toBe(true);
    expect(rows.rows.find(row => row.concept_id === 'photosynthesis')?.content_source_url)
      .toBe('https://www.wikidata.org/wiki/Q11982');
    expect(rows.rows.find(row => row.concept_id === 'cells')?.content_source_url)
      .toBe('https://www.wikidata.org/');
  });

  it('publishes once an admin has looked at it', async () => {
    await importCorpus(request(BUNDLE));
    const { status } = await json(await publish(request({ subjectId: 'nature' })));
    expect(status).toBe(200);
  });
});

describe('a bundle that cannot be accounted for', () => {
  it('is refused whole when the corpus records no licence', async () => {
    const { corpus: _dropped, ...rest } = BUNDLE;
    const { status, body } = await json(await importCorpus(request({
      ...rest,
      corpus: { ...CORPUS, license: undefined },
    })));

    expect(status).toBe(422);
    expect(body.problems[0].problem).toMatch(/licence/);

    // Nothing written. A partial import of a graph leaves prerequisites
    // pointing at concepts that were rejected — worse than before it ran.
    const rows = await executeSql<{ n: number }>(
      "SELECT COUNT(*) AS n FROM curriculum_concepts WHERE subject_id = 'nature'"
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('reports every problem, not the first', () => {
    const prepared = prepareBundle({
      corpus: CORPUS,
      subjectId: 'nature',
      concepts: [
        { conceptId: 'ok', name: 'Fine', level: 1 },
        { conceptId: 'no-name', level: 1 },
        { conceptId: 'BAD ID', name: 'Nope', level: 1 },
      ],
    });

    expect('problems' in prepared && prepared.problems.length).toBe(2);
  });

  it('refuses a bundle whose prerequisites point at nothing', () => {
    const prepared = prepareBundle({
      corpus: CORPUS,
      subjectId: 'nature',
      concepts: [{ conceptId: 'leaves', name: 'Folhas', level: 5, prerequisites: ['missing'] }],
    });

    expect('problems' in prepared).toBe(true);
  });

  it('validates against what is already there, not only against itself', () => {
    // Internally consistent, and still broken once it meets the subject: the
    // bundle relies on a concept that exists at a *higher* level.
    const prepared = prepareBundle(
      {
        corpus: CORPUS,
        subjectId: 'nature',
        concepts: [{ conceptId: 'leaves', name: 'Folhas', level: 2, prerequisites: ['cells'] }],
      },
      [{ id: 'cells', name: 'Células', level: 7, prerequisites: [] }]
    );

    expect('problems' in prepared).toBe(true);
  });
});

describe('the learner is told where it came from', () => {
  it('reaches the served concept as a credit line', async () => {
    await importCorpus(request(BUNDLE));
    await publish(request({ subjectId: 'nature' }));

    const { subjects } = await readCurriculumFromDatabase();
    const concept = subjects
      .find(subject => subject.id === 'nature')?.concepts
      .find(entry => entry.id === 'photosynthesis');

    // Attribution only an administrator can see is not attribution — it is a
    // record of having meant to.
    expect(concept?.attribution).toEqual({
      text: 'Wikidata contributors, CC0 1.0',
      license: 'CC0-1.0',
      sourceUrl: 'https://www.wikidata.org/wiki/Q11982',
    });
  });

  it('says nothing on content written for this project', async () => {
    const { subjects } = await readCurriculumFromDatabase();
    for (const subject of subjects) {
      for (const concept of subject.concepts) {
        // An empty credit line everywhere would train readers to ignore the
        // place credit appears.
        expect(concept.attribution).toBeUndefined();
      }
    }
  });
});
