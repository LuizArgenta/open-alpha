/**
 * Professor contribui → dois revisores aprovam → um aluno senta a prova.
 *
 * This test could not be written before. The contribution pipeline was real
 * and complete except at the end: submit, peer review, reputation, and a
 * `deployed` state in the schema that nothing ever wrote. It was only read, as
 * a guard. An approved contribution sat at `approved` forever, so the open
 * collaborative curriculum was aspirational — not for want of contributors,
 * but because the door was shut at the far end.
 *
 * The assertion that matters is the last one: a learner opens a quiz and gets
 * the teacher's question.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signToken } from '../api/_lib/auth.js';
import { executeSql } from '../api/_lib/db.js';
import { conceptContentHash, refreshCurriculum } from '../api/_lib/curriculum.js';
import { createUser, resetDatabase } from './helpers/database.js';

/** A signed-in teacher: reviewing publishes, so it needs the staff role. */
async function staffToken(): Promise<string> {
  const userId = await createUser('parent');
  await executeSql("INSERT INTO staff_roles (user_id, role) VALUES ($1, 'teacher')", [userId]);
  return signToken({ userId, role: 'parent' });
}

async function contributorToken(): Promise<string> {
  return signToken({ userId: await createUser('parent'), role: 'parent' });
}

/** The model fills whatever the authored pool does not. */
const generateQuizQuestions = vi.hoisted(() => vi.fn());
vi.mock('../api/_lib/llm.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/_lib/llm.js')>()),
  generateQuizQuestions,
}));

const SUBJECT = 'contribution-test';
const CONCEPT = 'photosynthesis-basics';

function contributedQuestion(id: string, stem: string) {
  return {
    id,
    question: stem,
    options: ['A) Sunlight', 'B) Moonlight', 'C) Darkness', 'D) Wind'],
    correctAnswer: 'A',
    explanation: 'Photosynthesis is driven by light from the sun.',
    distractorErrorCode: {
      'B': 'confuses_reflected_with_source_light',
      'C': 'believes_plants_grow_without_light',
      'D': 'confuses_air_movement_with_energy',
    },
  };
}

async function seedConcept(): Promise<void> {
  await executeSql(
    `INSERT INTO curriculum_subjects (id, name, description, status)
     VALUES ($1, 'Contribution test', 'seeded', 'published')`,
    [SUBJECT]
  );
  const content = {};
  await executeSql(
    `INSERT INTO curriculum_concepts
       (subject_id, concept_id, name, description, level, prerequisites, content, content_hash, status)
     VALUES ($1, $2, 'Photosynthesis', 'How plants eat', 4, '[]', $3, $4, 'published')`,
    [SUBJECT, CONCEPT, JSON.stringify(content), conceptContentHash({
      name: 'Photosynthesis', description: 'How plants eat',
      gradeLevel: 4, prerequisites: [], content,
    })]
  );
}

async function contribute(questions: unknown[], token?: string): Promise<number> {
  const { POST } = await import('../api/contribute/quiz.js');
  // The contribute endpoint checks the concept exists via the loaded
  // curriculum, not the database, so the seed has to be visible first.
  await refreshCurriculum({ force: true });
  const response = await POST(new Request('https://test.local/api/contribute/quiz', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token ?? await contributorToken()}`,
    },
    body: JSON.stringify({ subjectId: SUBJECT, conceptId: CONCEPT, questions }),
  }));
  const body = await response.json() as { contributionId?: number; error?: string };
  if (body.contributionId === undefined) {
    throw new Error(`contribution refused: ${body.error ?? JSON.stringify(body)}`);
  }
  return body.contributionId;
}

async function review(contributionId: number, token: string, decision = 'approve') {
  const { POST } = await import('../api/quality/review.js');
  return POST(new Request('https://test.local/api/quality/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contributionId,
      decision,
      feedback: 'Clear question, the distractors map to real misunderstandings.',
    }),
  }));
}

async function statusOf(contributionId: number): Promise<string> {
  const row = await executeSql<{ status: string }>(
    'SELECT status FROM contributions WHERE id = $1',
    [contributionId]
  );
  return row.rows[0].status;
}

/**
 * The curriculum is cached in module scope, and this file forces it to load a
 * seeded subject from the database. Leaving it there hands the next file a
 * curriculum containing only this test's concept — which is how it broke
 * placement.test.ts, in a suite that shares one process.
 */
afterAll(async () => {
  await executeSql('DELETE FROM curriculum_concepts WHERE subject_id = $1', [SUBJECT]);
  await executeSql('DELETE FROM curriculum_subjects WHERE id = $1', [SUBJECT]);
  await refreshCurriculum({ force: true });
});

beforeEach(async () => {
  await resetDatabase();
  await executeSql('DELETE FROM contribution_reviews');
  await executeSql('DELETE FROM contributions');
  await seedConcept();
  generateQuizQuestions.mockImplementation(async (_s, _c, _g, count: number) =>
    JSON.stringify({
      questions: Array.from({ length: count }, (_, index) => ({
        question: `Generated filler ${index}`,
        options: ['A) Sunlight', 'B) Moonlight', 'C) Darkness', 'D) Wind'],
        correctAnswer: 'A',
        explanation: 'Filler.',
      })),
    })
  );
});

describe('a question a teacher wrote', () => {
  it('reaches a student after two approvals', async () => {
    const contributionId = await contribute([
      contributedQuestion('ana-1', 'What powers photosynthesis?'),
    ]);

    // One approval is not enough — the threshold is deliberate.
    await review(contributionId, await staffToken());
    expect(await statusOf(contributionId)).not.toBe('deployed');

    const second = await review(contributionId, await staffToken());
    const body = await second.json() as { newStatus: string; publication?: { published: boolean } };

    expect(body.publication?.published).toBe(true);
    // 'deployed' was in the schema from the start and nothing ever wrote it.
    expect(await statusOf(contributionId)).toBe('deployed');

    // The assertion this whole item exists for: it is in the curriculum a
    // learner is served, not merely in a table marked approved.
    await refreshCurriculum({ force: true });
    const stored = await executeSql<{ content: string }>(
      'SELECT content FROM curriculum_concepts WHERE subject_id = $1 AND concept_id = $2',
      [SUBJECT, CONCEPT]
    );
    const questions = JSON.parse(stored.rows[0].content).masteryCheck.questions as { id: string }[];
    expect(questions.map(q => q.id)).toContain('ana-1');
  });

  it('replaces the question it revises instead of duplicating it', async () => {
    const first = await contribute([contributedQuestion('ana-1', 'First wording?')]);
    await review(first, await staffToken());
    await review(first, await staffToken());

    const revised = await contribute([contributedQuestion('ana-1', 'Clearer wording?')]);
    await review(revised, await staffToken());
    await review(revised, await staffToken());

    const stored = await executeSql<{ content: string }>(
      'SELECT content FROM curriculum_concepts WHERE subject_id = $1 AND concept_id = $2',
      [SUBJECT, CONCEPT]
    );
    const questions = JSON.parse(stored.rows[0].content).masteryCheck.questions as
      { id: string; question: string }[];

    // A second submission is a correction, not a second copy.
    expect(questions.filter(q => q.id === 'ana-1')).toHaveLength(1);
    expect(questions[0].question).toBe('Clearer wording?');
  });
});

describe('and actually reaches one', () => {
  /**
   * The test this file is named after, and the one it did not contain.
   *
   * The old version asserted the question was in `curriculum_concepts.content`
   * and called that "the curriculum a learner is served". It is not. The quiz
   * endpoint used to require five authored mastery items before it would touch
   * the bank, so a single contributed question was ignored and the model wrote
   * five from scratch: `deployed` meant "in the database" and nothing more.
   *
   * An external audit caught it. Verified empirically before this fix: status
   * `deployed`, and the learner received five generated questions.
   */
  it('serves the contributed question alongside generated ones', async () => {
    const contributionId = await contribute([
      contributedQuestion('ana-1', 'What powers photosynthesis?'),
    ]);
    await review(contributionId, await staffToken());
    await review(contributionId, await staffToken());
    await refreshCurriculum({ force: true });

    const { POST: quiz } = await import('../api/tutor/quiz.js');
    const learner = signToken({ userId: await createUser('student'), role: 'student' });
    const response = await quiz(new Request('https://test.local/api/tutor/quiz', {
      method: 'POST',
      headers: { authorization: `Bearer ${learner}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: SUBJECT, conceptId: CONCEPT }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { questions: { question: string }[] };

    // One authored plus four generated: a teacher's first question counts from
    // the moment it clears review, instead of waiting for a pool of five.
    expect(body.questions).toHaveLength(5);
    expect(body.questions.map(q => q.question)).toContain('What powers photosynthesis?');
  });

  it('records that the attempt was mixed, not purely generated', async () => {
    const contributionId = await contribute([
      contributedQuestion('ana-2', 'What powers photosynthesis?'),
    ]);
    await review(contributionId, await staffToken());
    await review(contributionId, await staffToken());
    await refreshCurriculum({ force: true });

    const { POST: quiz } = await import('../api/tutor/quiz.js');
    const learner = signToken({ userId: await createUser('student'), role: 'student' });
    await quiz(new Request('https://test.local/api/tutor/quiz', {
      method: 'POST',
      headers: { authorization: `Bearer ${learner}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: SUBJECT, conceptId: CONCEPT }),
    }));

    const event = await executeSql<{ payload: string }>(
      "SELECT payload FROM learning_events WHERE event_type = 'quiz_start' ORDER BY id DESC LIMIT 1"
    );
    // The stream says how the attempt was composed, so "did contributions
    // reach anyone" is answerable from evidence rather than from belief.
    expect(JSON.parse(event.rows[0].payload)).toMatchObject({ source: 'mixed', authored: 1 });
  });
});

describe('who may contribute and who may review', () => {
  it('refuses an unauthenticated contribution', async () => {
    const { POST } = await import('../api/contribute/quiz.js');
    const response = await POST(new Request('https://test.local/api/contribute/quiz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectId: SUBJECT, conceptId: CONCEPT, questions: [] }),
    }));
    expect(response.status).toBe(401);
  });

  it('refuses a review from someone who is not staff', async () => {
    const contributionId = await contribute([contributedQuestion('ana-3', 'Q?')]);
    const notStaff = signToken({ userId: await createUser('student'), role: 'student' });

    // Approving publishes into the curriculum, which admin/curriculum already
    // requires staff to do. The contribution path now matches that privilege.
    expect((await review(contributionId, notStaff)).status).toBe(403);
  });

  it('cannot be approved by its own contributor', async () => {
    const ana = await contributorToken();
    const contributionId = await contribute([contributedQuestion('ana-4', 'Q?')], ana);

    // Identities are real now, so this guard means something: it used to
    // compare two strings the caller chose.
    await executeSql(
      "INSERT INTO staff_roles (user_id, role) SELECT id, 'teacher' FROM users ORDER BY id DESC LIMIT 1"
    );
    const response = await review(contributionId, ana);
    expect([403, 409]).toContain(response.status);
  });
});

describe('approval is not a rubber stamp', () => {
  it('refuses to publish a question nobody can pass', async () => {
    const contributionId = await contribute([
      { ...contributedQuestion('ana-bad', 'Which one?'), correctAnswer: 'E' },
    ]);

    await review(contributionId, await staffToken());
    const second = await review(contributionId, await staffToken());
    const body = await second.json() as { publication?: { published: boolean; reason?: string } };

    // Two reviewers approving does not make a broken item answerable, and the
    // engine would read every failure as a knowledge gap.
    expect(body.publication?.published).toBe(false);
    expect(body.publication?.reason).toMatch(/matches none of its options/);
    expect(await statusOf(contributionId)).toBe('approved');
  });

  it('says why, instead of failing quietly', async () => {
    const contributionId = await contribute([
      contributedQuestion('ana-2', 'What powers photosynthesis?'),
    ]);
    await executeSql(
      'DELETE FROM curriculum_concepts WHERE subject_id = $1 AND concept_id = $2',
      [SUBJECT, CONCEPT]
    );

    await review(contributionId, await staffToken());
    const second = await review(contributionId, await staffToken());
    const body = await second.json() as { publication?: { reason?: string }; message: string };

    // Silently dropping a teacher's accepted work is the worst outcome here.
    expect(body.publication?.reason).toMatch(/not in the database/);
    expect(body.message).toMatch(/not published/);
  });
});
