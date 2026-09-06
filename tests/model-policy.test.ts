/**
 * Asking for a capability instead of naming a vendor.
 *
 * Two things were hardcoded and had to move together: the gateway URL was a
 * constant, and `claude-sonnet-4-6` appeared in six places. Changing only the
 * URL would have been worse than changing neither — the client would reach the
 * right server and ask for a model it does not serve, failing every request
 * while looking configurable. That was the review finding on #51.
 *
 * The acceptance case is a school saying "use our endpoint", where the model
 * has a name we have never heard.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { type Capability, modelEndpoint, modelFor, modelPolicy } from '../api/_lib/model-policy.js';

const ORIGINAL = { ...process.env };

const CAPABILITIES: Capability[] = [
  'tutor_chat', 'coach_chat', 'lesson_generation', 'lesson_translation', 'quiz_generation',
];

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function clear(): void {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  for (const capability of CAPABILITIES) {
    delete process.env[`LLM_MODEL_${capability.toUpperCase()}`];
  }
}

describe('with nothing configured', () => {
  it('behaves exactly as before', () => {
    clear();
    expect(modelEndpoint()).toBe('https://llm.atxp.ai/v1');
    for (const capability of CAPABILITIES) {
      expect(modelFor(capability)).toBe('claude-sonnet-4-6');
    }
  });

  it('treats a blank variable as unset rather than as an empty endpoint', () => {
    clear();
    process.env.LLM_BASE_URL = '   ';
    process.env.LLM_MODEL = '';
    expect(modelEndpoint()).toBe('https://llm.atxp.ai/v1');
    expect(modelFor('tutor_chat')).toBe('claude-sonnet-4-6');
  });
});

describe('a school that brings its own endpoint', () => {
  it('gets both the endpoint and the model it actually serves', () => {
    clear();
    // The case the URL alone could not satisfy: a local server exposing a
    // model whose name we have never heard.
    process.env.LLM_BASE_URL = 'http://gpu-01.escola.internal:8000/v1';
    process.env.LLM_MODEL = 'escola-tutor-7b';

    expect(modelEndpoint()).toBe('http://gpu-01.escola.internal:8000/v1');
    for (const capability of CAPABILITIES) {
      expect(modelFor(capability)).toBe('escola-tutor-7b');
    }
  });
});

describe('one model per capability', () => {
  it('lets tutoring and item generation differ', () => {
    clear();
    process.env.LLM_MODEL = 'house-default';
    process.env.LLM_MODEL_TUTOR_CHAT = 'careful-and-slow';
    process.env.LLM_MODEL_QUIZ_GENERATION = 'fast-and-structured';

    // This is what makes the resolution capability-shaped rather than one
    // global switch: the same deployment wants different things from a
    // conversation and from item generation.
    expect(modelFor('tutor_chat')).toBe('careful-and-slow');
    expect(modelFor('quiz_generation')).toBe('fast-and-structured');
    expect(modelFor('coach_chat')).toBe('house-default');
  });

  it('reports what the deployment resolved to', () => {
    clear();
    process.env.LLM_MODEL_LESSON_TRANSLATION = 'translator-1';

    const policy = modelPolicy();
    expect(policy.endpoint).toBe('https://llm.atxp.ai/v1');
    expect(policy.models.lesson_translation).toBe('translator-1');
    expect(policy.models.tutor_chat).toBe('claude-sonnet-4-6');
  });
});

describe('the pedagogical code', () => {
  it('names no vendor or model anywhere', async () => {
    const { readFile } = await import('fs/promises');
    const { readdirSync, statSync } = await import('fs');
    const { join } = await import('path');

    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap(entry => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith('.ts') ? [path] : [];
      });
    }

    const offenders: string[] = [];
    for (const file of walk('api')) {
      if (file.endsWith('model-policy.ts')) continue;
      const source = await readFile(file, 'utf-8');
      if (/claude-sonnet|gpt-4|gemini-|grok-/i.test(source)) offenders.push(file);
    }

    // The rule the architecture rests on: the engine asks for a capability, and
    // something else decides who answers. A model id in a handler is that rule
    // being quietly broken.
    expect(offenders).toEqual([]);
  });
});
