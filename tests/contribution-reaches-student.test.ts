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

import { beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import { signToken } from '../api/_lib/auth.js';
import { conceptContentHash, refreshCurriculum } from '../api/_lib/curriculum.js';
import { createUser, resetDatabase } from './helpers/database.js';

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

async function contribute(questions: unknown[]): Promise<number> {
  const { POST } = await import('../api/contribute/quiz.js');
  // The contribute endpoint checks the concept exists via the loaded
  // curriculum, not the database, so the seed has to be visible first.
  await refreshCurriculum({ force: true });
  const response = await POST(new Request('https://test.local/api/contribute/quiz', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contributorId: 'professora-ana',
      subjectId: SUBJECT,
      conceptId: CONCEPT,
      questions,
    }),
  }));
  const body = await response.json() as { contributionId?: number; error?: string };
  if (body.contributionId === undefined) {
    throw new Error(`contribution refused: ${body.error ?? JSON.stringify(body)}`);
  }
  return body.contributionId;
}

async function review(contributionId: number, reviewerId: string, decision = 'approve') {
  const { POST } = await import('../api/quality/review.js');
  return POST(new Request('https://test.local/api/quality/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contributionId,
      reviewerId,
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

beforeEach(async () => {
  await resetDatabase();
  await executeSql('DELETE FROM contribution_reviews');
  await executeSql('DELETE FROM contributions');
  await seedConcept();
});

describe('a question a teacher wrote', () => {
  it('reaches a student after two approvals', async () => {
    const contributionId = await contribute([
      contributedQuestion('ana-1', 'What powers photosynthesis?'),
    ]);

    // One approval is not enough — the threshold is deliberate.
    await review(contributionId, 'revisor-1');
    expect(await statusOf(contributionId)).not.toBe('deployed');

    const second = await review(contributionId, 'revisor-2');
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
    await review(first, 'revisor-1');
    await review(first, 'revisor-2');

    const revised = await contribute([contributedQuestion('ana-1', 'Clearer wording?')]);
    await review(revised, 'revisor-1');
    await review(revised, 'revisor-2');

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

describe('approval is not a rubber stamp', () => {
  it('refuses to publish a question nobody can pass', async () => {
    const contributionId = await contribute([
      { ...contributedQuestion('ana-bad', 'Which one?'), correctAnswer: 'E' },
    ]);

    await review(contributionId, 'revisor-1');
    const second = await review(contributionId, 'revisor-2');
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

    await review(contributionId, 'revisor-1');
    const second = await review(contributionId, 'revisor-2');
    const body = await second.json() as { publication?: { reason?: string }; message: string };

    // Silently dropping a teacher's accepted work is the worst outcome here.
    expect(body.publication?.reason).toMatch(/not in the database/);
    expect(body.message).toMatch(/not published/);
  });
});
