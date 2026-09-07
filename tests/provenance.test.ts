/**
 * Item 1.6, which the PRD calls the **legal prerequisite** of importing open
 * content rather than tidying — and the reason is one-directional.
 *
 * Once outside material is published to learners, "which parts of our
 * curriculum came from where, under what licence" has to be answerable. If it
 * was not recorded at import time it cannot be reconstructed: you can re-derive
 * a lot of things from content, and a licence is not one of them.
 *
 * So the rule lands before the importer, and 1.7 arrives into a system that
 * already refuses to publish what it cannot account for.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { createUser, resetDatabase } from './helpers/database.js';
import { POST as saveSubject } from '../api/admin/curriculum/subjects.js';
import { POST as saveConcept } from '../api/admin/curriculum/concepts.js';
import { POST as publish } from '../api/admin/curriculum/publish.js';
import { provenanceProblem } from '../api/_lib/provenance.js';

let adminToken: string;

function request(body: unknown) {
  return new Request('https://test.local/api/admin/curriculum', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as any };
}

const CONCEPT = { subjectId: 'history', conceptId: 'rome', name: 'Roma', level: 0 };

beforeEach(async () => {
  await resetDatabase();
  const adminId = await createUser('parent');
  await executeSql(`INSERT INTO staff_roles (user_id, role) VALUES ($1, 'admin')`, [adminId]);
  adminToken = signToken({ userId: adminId, role: 'parent' });
  await saveSubject(request({ id: 'history', name: 'História' }));
});

describe('what may be published', () => {
  it('publishes content written for this project without ceremony', async () => {
    await saveConcept(request(CONCEPT));
    const { status } = await json(await publish(request({ subjectId: 'history' })));
    expect(status).toBe(200);
  });

  it('refuses a concept whose origin nobody recorded', async () => {
    await saveConcept(request(CONCEPT));
    // Simulating a row written before this rule existed, or by an importer
    // that skipped it. Publishing is the last cheap moment to ask.
    await executeSql("UPDATE curriculum_concepts SET content_source = NULL");

    const { status, body } = await json(await publish(request({ subjectId: 'history' })));

    expect(status).toBe(422);
    expect(body.provenance[0].conceptId).toBe('rome');
    expect(body.provenance[0].problem).toMatch(/no provenance/);
  });

  it('lists every unaccounted concept, not just the first', async () => {
    await saveConcept(request(CONCEPT));
    await saveConcept(request({ ...CONCEPT, conceptId: 'greece', name: 'Grécia' }));
    await executeSql("UPDATE curriculum_concepts SET content_source = NULL");

    const { body } = await json(await publish(request({ subjectId: 'history' })));

    // An admin fixing a bulk import wants all of them. One at a time turns a
    // single correction into twenty round trips.
    expect(body.provenance.map((entry: any) => entry.conceptId).sort())
      .toEqual(['greece', 'rome']);
  });

  it('lets a subject be unpublished regardless', async () => {
    await saveConcept(request(CONCEPT));
    await executeSql("UPDATE curriculum_concepts SET content_source = NULL");

    // Withdrawing content is never the thing to block: an admin pulling
    // something they should not have published must not be stopped by the
    // rule that says they should not have published it.
    const { status } = await json(await publish(request({ subjectId: 'history', unpublish: true })));
    expect(status).toBe(200);
  });
});

describe('outside content', () => {
  const EXTERNAL = {
    ...CONCEPT,
    provenance: {
      source: 'external',
      sourceUrl: 'https://www.wikidata.org/wiki/Q1747689',
      sourceVersion: '2026-09-01',
      license: 'CC0-1.0',
      attribution: 'Wikidata contributors, CC0 1.0',
    },
  };

  it('is accepted when it says where it came from and under what terms', async () => {
    const saved = await json(await saveConcept(request(EXTERNAL)));
    expect(saved.status).toBe(200);

    const stored = await executeSql<{ content_license: string; content_attribution: string }>(
      'SELECT content_license, content_attribution FROM curriculum_concepts WHERE concept_id = $1',
      ['rome']
    );
    expect(stored.rows[0].content_license).toBe('CC0-1.0');
    expect(stored.rows[0].content_attribution).toBe('Wikidata contributors, CC0 1.0');

    expect((await json(await publish(request({ subjectId: 'history' })))).status).toBe(200);
  });

  for (const [missing, field] of [
    ['a source URL', 'sourceUrl'],
    ['a licence', 'license'],
    ['an attribution', 'attribution'],
  ] as const) {
    it(`is refused without ${missing}`, async () => {
      const { [field]: _dropped, ...rest } = EXTERNAL.provenance;
      const { status } = await json(await saveConcept(request({ ...EXTERNAL, provenance: rest })));
      expect(status).toBe(422);
    });
  }

  it('is refused when the URL is not a web address', async () => {
    const { status } = await json(await saveConcept(request({
      ...EXTERNAL,
      provenance: { ...EXTERNAL.provenance, sourceUrl: 'wikidata' },
    })));
    expect(status).toBe(422);
  });
});

describe('licences', () => {
  it('refuses one nobody has considered', () => {
    expect(provenanceProblem({ source: 'original', license: 'WTFPL' }))
      .toMatch(/has not considered/);
  });

  /**
   * A product decision, recorded as a rule so it is visible rather than
   * assumed. The PRD says to start with Wikidata's CC0 and leave Wikipedia's
   * share-alike alone while the licence model is new — share-alike reaches
   * into what the platform builds on top of the content, not only the content.
   * Lifting it is one constant.
   */
  it('refuses share-alike for now, and says why', () => {
    const problem = provenanceProblem({
      source: 'external',
      sourceUrl: 'https://en.wikipedia.org/wiki/Rome',
      license: 'CC-BY-SA-4.0',
      attribution: 'Wikipedia contributors',
    });
    expect(problem).toMatch(/share-alike/);
  });
});

describe('a contribution', () => {
  it('must credit whoever wrote it', () => {
    expect(provenanceProblem({ source: 'contributed' })).toMatch(/cannot be credited/);
    expect(provenanceProblem({ source: 'contributed', attribution: 'Prof. Ana' })).toBeUndefined();
  });
});
