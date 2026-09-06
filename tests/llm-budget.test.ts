/**
 * There was nothing between the model calls and the bill.
 *
 * Every lesson and quiz on 94% of the curriculum is generated on demand, and
 * `demo/chat.ts` does it for anyone with the URL and no account. For a test
 * deployment the failure mode is not subtle: one loop, or one person with a
 * script, and the budget for the whole test is gone by lunch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSql } from '../api/_lib/db.js';
import {
  BUDGET_WINDOW_HOURS,
  LlmUnavailableError,
  assertLlmAvailable,
  demoModeIsEnabled,
  llmIsEnabled,
  recordUsage,
  tokenBudget,
  unavailableResponse,
  usageInWindow,
} from '../api/_lib/llm-budget.js';
import { POST as demoChat } from '../api/demo/chat.js';
import { resetDatabase } from './helpers/database.js';

const ORIGINAL = { ...process.env };

function demoRequest(): Request {
  return new Request('https://test.local/api/demo/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi', subject: 'math', conceptId: 'math-fractions-intro' }),
  });
}

/**
 * The refusal, or a failure saying the call was not refused at all — a test
 * that silently accepts "it was allowed" is not testing a limit.
 */
async function refusalFrom(call: Promise<unknown>): Promise<LlmUnavailableError> {
  try {
    await call;
  } catch (error) {
    return error as LlmUnavailableError;
  }
  throw new Error('Expected the call to be refused, but it was allowed.');
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('the kill switch', () => {
  it('is on unless switched off, so nothing changes by default', () => {
    delete process.env.LLM_ENABLED;
    expect(llmIsEnabled()).toBe(true);
  });

  it('refuses every call when switched off, before spending anything', async () => {
    process.env.LLM_ENABLED = 'false';
    await expect(assertLlmAvailable()).rejects.toThrow(LlmUnavailableError);
    await expect(assertLlmAvailable()).rejects.toThrow(/switched off/);
  });

  it('says it was switched off rather than that something broke', async () => {
    process.env.LLM_ENABLED = 'false';
    const error = await refusalFrom(assertLlmAvailable());
    expect(error.reason).toBe('disabled');
    expect(unavailableResponse(error).status).toBe(503);
  });
});

describe('the token budget', () => {
  it('has no ceiling unless one is configured', async () => {
    delete process.env.LLM_DAILY_TOKEN_BUDGET;
    expect(tokenBudget()).toBeUndefined();
    await recordUsage('quiz_generation', 'test-model', { total_tokens: 10_000_000 });
    // Unset means unlimited: a default that silently capped generation would
    // be its own kind of surprise.
    await expect(assertLlmAvailable()).resolves.toBeUndefined();
  });

  it('refuses once the window is spent', async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = '1000';
    await recordUsage('lesson_generation', 'test-model', { total_tokens: 1000 });

    const error = await refusalFrom(assertLlmAvailable());
    expect(error).toBeInstanceOf(LlmUnavailableError);
    expect(error.reason).toBe('budget');
  });

  it('allows calls while the budget still has room', async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = '1000';
    await recordUsage('lesson_generation', 'test-model', { total_tokens: 999 });
    await expect(assertLlmAvailable()).resolves.toBeUndefined();
  });

  it('counts tokens rather than calls, since they differ by an order of magnitude', async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = '1000';
    // Twenty cheap chat turns must not lock out what one lesson would allow.
    for (let index = 0; index < 20; index += 1) {
      await recordUsage('tutor_chat', 'test-model', { total_tokens: 10 });
    }
    const usage = await usageInWindow();
    expect(usage.calls).toBe(20);
    expect(usage.tokens).toBe(200);
    await expect(assertLlmAvailable()).resolves.toBeUndefined();
  });

  it('ignores spending from outside the window', async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = '1000';
    await executeSql(
      `INSERT INTO llm_usage (purpose, model, total_tokens, created_at)
       VALUES ('lesson_generation', 'test-model', 5000, datetime('now', $1))`,
      [`-${BUDGET_WINDOW_HOURS + 1} hours`]
    );

    expect((await usageInWindow()).tokens).toBe(0);
    await expect(assertLlmAvailable()).resolves.toBeUndefined();
  });

  it('refuses a budget that is not a number rather than treating it as none', async () => {
    process.env.LLM_DAILY_TOKEN_BUDGET = 'muito';
    expect(() => tokenBudget()).toThrow(/not a number/);
  });
});

describe('recording what a call cost', () => {
  it('keeps the purpose and model, so spending can be attributed', async () => {
    await recordUsage('quiz_generation', 'claude-sonnet-4-6', {
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
    });

    const rows = await executeSql<{ purpose: string; model: string; total_tokens: number }>(
      'SELECT purpose, model, total_tokens FROM llm_usage'
    );
    expect(rows.rows[0]).toEqual({
      purpose: 'quiz_generation',
      model: 'claude-sonnet-4-6',
      total_tokens: 200,
    });
  });

  it('survives a provider that reports no usage', async () => {
    await recordUsage('tutor_chat', 'test-model', undefined);
    expect((await usageInWindow()).calls).toBe(1);
  });

  it('never throws, because losing accounting must not fail a learner', async () => {
    await executeSql('DROP TABLE llm_usage');
    // The row is lost and the window understates spending, which the next
    // window corrects. Failing the request instead would be worse.
    await expect(recordUsage('tutor_chat', 'test-model', { total_tokens: 5 })).resolves
      .toBeUndefined();
  });
});

describe('demo mode', () => {
  it('is on unless switched off', () => {
    delete process.env.DEMO_MODE_ENABLED;
    expect(demoModeIsEnabled()).toBe(true);
  });

  it('answers 503 when switched off, without reaching a model', async () => {
    process.env.DEMO_MODE_ENABLED = 'false';
    const response = await demoChat(demoRequest());

    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toMatch(/switched off/);
    // Nothing was spent proving it.
    expect((await usageInWindow()).calls).toBe(0);
  });

  it('is independent of the tutor, so one can be off with the other on', () => {
    process.env.DEMO_MODE_ENABLED = 'false';
    delete process.env.LLM_ENABLED;
    expect(demoModeIsEnabled()).toBe(false);
    expect(llmIsEnabled()).toBe(true);
  });
});
