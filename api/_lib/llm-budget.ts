/**
 * A ceiling on what this deployment can spend on model calls, and a switch to
 * stop them entirely.
 *
 * Every lesson, quiz and chat message on 94% of the curriculum is generated on
 * demand, and `demo/chat.ts` does it for anyone with the URL and no account.
 * There was nothing between that and the bill. For a test deployment the
 * failure mode is not subtle: one loop, or one person with a script, and the
 * budget for the whole test is gone by lunch.
 *
 * Counted in the database rather than in memory, for the same reason the login
 * limit is: serverless has no shared memory, and two instances each holding
 * half a budget enforce neither.
 *
 * Tokens, not calls. A call is not a unit of cost — a chat turn and a full
 * lesson generation differ by an order of magnitude — and the provider tells
 * us the real number, so there is no reason to guess with a proxy.
 */

import { executeSql } from './db.js';

export const BUDGET_WINDOW_HOURS = 24;

/** Why a model call was refused, so the caller can say something useful. */
export type UnavailableReason = 'disabled' | 'budget';

export class LlmUnavailableError extends Error {
  constructor(readonly reason: UnavailableReason, message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/** Off by configuration, for when the answer to a runaway bill is "stop". */
export function llmIsEnabled(): boolean {
  return process.env.LLM_ENABLED !== 'false';
}

/**
 * The demo endpoint answers anyone, with no account and no cost to them.
 * It is the largest exposure on the deployment and the least necessary during
 * a closed test, so it can be turned off on its own without disabling the
 * tutor for the people actually testing.
 */
export function demoModeIsEnabled(): boolean {
  return process.env.DEMO_MODE_ENABLED !== 'false';
}

/**
 * Unset means no ceiling, which is what this has always done — a default that
 * silently capped generation would be its own kind of surprise. Production
 * without one is worth saying out loud, once.
 */
let warnedAboutMissingBudget = false;

export function tokenBudget(): number | undefined {
  const configured = process.env.LLM_DAILY_TOKEN_BUDGET;
  if (configured === undefined || configured.trim() === '') {
    if (process.env.NODE_ENV === 'production' && !warnedAboutMissingBudget) {
      warnedAboutMissingBudget = true;
      console.warn(
        '[llm] LLM_DAILY_TOKEN_BUDGET is unset in production: model spending has no ceiling. ' +
        'Set it, or set LLM_ENABLED=false if this deployment should not generate at all.'
      );
    }
    return undefined;
  }

  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`LLM_DAILY_TOKEN_BUDGET is not a number: ${configured}`);
  }
  return parsed;
}

export interface WindowUsage {
  tokens: number;
  calls: number;
}

export async function usageInWindow(): Promise<WindowUsage> {
  const result = await executeSql<{ tokens: number; calls: number }>(
    `SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS calls
     FROM llm_usage WHERE created_at > datetime('now', $1)`,
    [`-${BUDGET_WINDOW_HOURS} hours`]
  );
  return {
    tokens: Number(result.rows[0]?.tokens ?? 0),
    calls: Number(result.rows[0]?.calls ?? 0),
  };
}

/**
 * Throws unless a model call is allowed right now.
 *
 * Checked before the call rather than after, because the point is to not spend
 * the money. The budget is a ceiling on the window, not a per-call limit, so a
 * single expensive call can carry usage past it — the next one is refused,
 * which is the behaviour that stops a loop rather than one that would have to
 * predict a call's cost before making it.
 */
export async function assertLlmAvailable(): Promise<void> {
  if (!llmIsEnabled()) {
    throw new LlmUnavailableError(
      'disabled',
      'Model generation is switched off for this deployment (LLM_ENABLED=false).'
    );
  }

  const budget = tokenBudget();
  if (budget === undefined) return;

  const { tokens } = await usageInWindow();
  if (tokens >= budget) {
    throw new LlmUnavailableError(
      'budget',
      `Model budget for the last ${BUDGET_WINDOW_HOURS}h is spent (${tokens} of ${budget} tokens).`
    );
  }
}

export interface CallUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * Records what a call actually cost.
 *
 * Never throws: losing a usage row is bad, but failing the learner's request
 * because the accounting write failed is worse. A dropped row understates
 * spending, which the next window corrects.
 */
export async function recordUsage(
  purpose: string,
  model: string,
  usage: CallUsage | undefined
): Promise<void> {
  try {
    await executeSql(
      `INSERT INTO llm_usage (purpose, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        purpose,
        model,
        usage?.prompt_tokens ?? 0,
        usage?.completion_tokens ?? 0,
        usage?.total_tokens ?? 0,
      ]
    );
  } catch (error) {
    console.error('Failed to record model usage:', error);
  }
}

/** 503 with why, so the interface can say something other than "error". */
export function unavailableResponse(error: LlmUnavailableError): Response {
  return Response.json(
    {
      error:
        error.reason === 'disabled'
          ? 'Generated content is switched off on this deployment.'
          : 'The generation budget for today is spent. It resets over the next 24 hours.',
      reason: error.reason,
    },
    { status: 503 }
  );
}
