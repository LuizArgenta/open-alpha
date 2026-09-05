/**
 * Authoring puts curriculum edits one click away from students, with no pull
 * request in between. The graph checks and the role checks are what stands
 * in that gap.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { validateConceptGraph } from '../api/_lib/curriculum-validation.js';
import { GET as listSubjects, POST as saveSubject } from '../api/admin/curriculum/subjects.js';
import { GET as listConcepts, POST as saveConcept } from '../api/admin/curriculum/concepts.js';
import { POST as publish } from '../api/admin/curriculum/publish.js';
import { POST as grantRole } from '../api/admin/grant-role.js';
import { createUser, resetDatabase } from './helpers/database.js';

let adminId: number;
let teacherId: number;
let studentId: number;
let adminToken: string;
let teacherToken: string;
let studentToken: string;

function request(body?: unknown, token = adminToken, url = 'https://test.local/api/admin/x') {
  return new Request(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(response: Response) {
  return { status: response.status, body: (await response.json()) as any };
}

beforeEach(async () => {
  await resetDatabase();

  adminId = await createUser('parent');
  teacherId = await createUser('parent');
  studentId = await createUser('student');

  await executeSql(`INSERT INTO staff_roles (user_id, role) VALUES ($1, 'admin')`, [adminId]);
  await executeSql(`INSERT INTO staff_roles (user_id, role) VALUES ($1, 'teacher')`, [teacherId]);

  adminToken = signToken({ userId: adminId, role: 'parent' });
  teacherToken = signToken({ userId: teacherId, role: 'parent' });
  studentToken = signToken({ userId: studentId, role: 'student' });

  await saveSubject(request({ id: 'history', name: 'História' }));
});

describe('graph validation', () => {
  it('catches a prerequisite loop, which would make the engine walk forever', () => {
    const problems = validateConceptGraph([
      { id: 'a', name: 'A', level: 1, prerequisites: ['b'] },
      { id: 'b', name: 'B', level: 1, prerequisites: ['a'] },
    ]);

    expect(problems.map(p => p.code)).toContain('cycle');
  });

  it('reports a loop once, not once per node in it', () => {
    const problems = validateConceptGraph([
      { id: 'a', name: 'A', level: 1, prerequisites: ['b'] },
      { id: 'b', name: 'B', level: 1, prerequisites: ['c'] },
      { id: 'c', name: 'C', level: 1, prerequisites: ['a'] },
    ]);

    expect(problems.filter(p => p.code === 'cycle')).toHaveLength(1);
  });

  it('catches a concept that requires itself', () => {
    const problems = validateConceptGraph([
      { id: 'a', name: 'A', level: 1, prerequisites: ['a'] },
    ]);

    expect(problems[0].code).toBe('self_prerequisite');
  });

  it('catches a prerequisite that does not exist', () => {
    const problems = validateConceptGraph([
      { id: 'a', name: 'A', level: 1, prerequisites: ['ghost'] },
    ]);

    expect(problems[0].code).toBe('missing_prerequisite');
  });

  it('catches a prerequisite that sits above its dependent', () => {
    const problems = validateConceptGraph([
      { id: 'easy', name: 'Easy', level: 1, prerequisites: ['hard'] },
      { id: 'hard', name: 'Hard', level: 5, prerequisites: [] },
    ]);

    expect(problems[0].code).toBe('level_inversion');
  });

  it('passes a healthy chain', () => {
    expect(
      validateConceptGraph([
        { id: 'a', name: 'A', level: 1, prerequisites: [] },
        { id: 'b', name: 'B', level: 2, prerequisites: ['a'] },
        { id: 'c', name: 'C', level: 3, prerequisites: ['b'] },
      ])
    ).toEqual([]);
  });
});

describe('who may author', () => {
  it('refuses a student', async () => {
    const { status } = await json(await saveSubject(request({ id: 'x', name: 'X' }, studentToken)));
    expect(status).toBe(403);
  });

  it('refuses an adult with no staff role', async () => {
    const outsider = signToken({ userId: await createUser('parent'), role: 'parent' });
    const { status } = await json(await saveSubject(request({ id: 'x', name: 'X' }, outsider)));
    expect(status).toBe(403);
  });

  it('lets a teacher read the curriculum but not rewrite it', async () => {
    const read = await json(await listSubjects(request(undefined, teacherToken)));
    const write = await json(await saveSubject(request({ id: 'x', name: 'X' }, teacherToken)));

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
  });

  it('reads the role from the database, not from the token', async () => {
    // A token lives seven days; revoking should take effect when it is
    // revoked, not a week later.
    await executeSql('DELETE FROM staff_roles WHERE user_id = $1', [adminId]);

    const { status } = await json(await saveSubject(request({ id: 'x', name: 'X' })));
    expect(status).toBe(403);
  });

  it('lets the deployment key create the first admin', async () => {
    process.env.ADMIN_INIT_KEY = 'test-admin-key';
    const email = await executeSql<{ email: string }>('SELECT email FROM users WHERE id = $1', [studentId]);

    const response = await grantRole(
      new Request('https://test.local/api/admin/grant-role', {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin-key', 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.rows[0].email, role: 'admin' }),
      })
    );

    expect(response.status).toBe(200);
    delete process.env.ADMIN_INIT_KEY;
  });
});

describe('authoring a tree', () => {
  async function addConcept(overrides: Record<string, unknown> = {}) {
    return json(await saveConcept(request({
      subjectId: 'history',
      conceptId: 'history-timeline',
      name: 'Linha do tempo',
      level: 3,
      prerequisites: [],
      ...overrides,
    })));
  }

  it('creates a subject as a draft, because an empty subject helps nobody', async () => {
    const { body } = await json(await listSubjects(request()));
    const history = body.subjects.find((s: any) => s.id === 'history');

    expect(history.status).toBe('draft');
    expect(history.concepts).toBe(0);
  });

  it('rejects an id that would not survive a URL', async () => {
    const { status } = await json(await saveSubject(request({ id: 'História!', name: 'X' })));
    expect(status).toBe(400);
  });

  it('adds a concept and reports the tree back', async () => {
    await addConcept();

    const { body } = await json(await listConcepts(
      request(undefined, adminToken, 'https://test.local/api/admin/curriculum/concepts?subject=history')
    ));

    expect(body.concepts).toHaveLength(1);
    expect(body.concepts[0]).toMatchObject({ id: 'history-timeline', level: 3, status: 'draft' });
    expect(body.problems).toEqual([]);
  });

  it('refuses a save that would break the graph, before writing it', async () => {
    const { status, body } = await addConcept({ prerequisites: ['history-ghost'] });

    expect(status).toBe(422);
    expect(body.problems[0].code).toBe('missing_prerequisite');

    const stored = await executeSql('SELECT concept_id FROM curriculum_concepts');
    expect(stored.rows).toHaveLength(0);
  });

  it('refuses a concept for a subject that does not exist', async () => {
    const { status } = await addConcept({ subjectId: 'no-such-subject' });
    expect(status).toBe(404);
  });

  it('bumps the version when a concept is edited', async () => {
    await addConcept();
    await addConcept({ name: 'Linha do tempo (revisada)' });

    const row = await executeSql<{ version: number; name: string }>(
      'SELECT version, name FROM curriculum_concepts WHERE concept_id = $1',
      ['history-timeline']
    );

    expect(row.rows[0].version).toBe(2);
    expect(row.rows[0].name).toBe('Linha do tempo (revisada)');
  });
});

describe('publishing', () => {
  it('refuses to publish a subject with nothing in it', async () => {
    const { status } = await json(await publish(request({ subjectId: 'history' })));
    expect(status).toBe(422);
  });

  it('publishes the subject and its concepts together', async () => {
    await saveConcept(request({
      subjectId: 'history', conceptId: 'history-timeline', name: 'Linha do tempo', level: 3,
    }));

    const { status } = await json(await publish(request({ subjectId: 'history' })));
    expect(status).toBe(200);

    const subject = await executeSql<{ status: string }>(
      'SELECT status FROM curriculum_subjects WHERE id = $1', ['history']
    );
    const concept = await executeSql<{ status: string }>(
      'SELECT status FROM curriculum_concepts WHERE subject_id = $1', ['history']
    );

    expect(subject.rows[0].status).toBe('published');
    expect(concept.rows[0].status).toBe('published');
  });

  it('checks the graph again at publish, not only at save', async () => {
    // Saving validates the graph, but a later edit to a neighbour can break
    // what an earlier save left valid.
    await saveConcept(request({
      subjectId: 'history', conceptId: 'history-a', name: 'A', level: 1,
    }));
    await executeSql(
      `UPDATE curriculum_concepts SET prerequisites = '["history-ghost"]' WHERE concept_id = 'history-a'`
    );

    const { status, body } = await json(await publish(request({ subjectId: 'history' })));

    expect(status).toBe(422);
    expect(body.problems[0].code).toBe('missing_prerequisite');
  });

  it('can take a subject back out of circulation', async () => {
    await saveConcept(request({
      subjectId: 'history', conceptId: 'history-timeline', name: 'Linha do tempo', level: 3,
    }));
    await publish(request({ subjectId: 'history' }));
    await publish(request({ subjectId: 'history', unpublish: true }));

    const subject = await executeSql<{ status: string }>(
      'SELECT status FROM curriculum_subjects WHERE id = $1', ['history']
    );
    expect(subject.rows[0].status).toBe('draft');
  });
});
