/**
 * Which endpoint and which model answer a given capability.
 *
 * The pedagogical engine should never name a vendor. It asks for a
 * *capability* — tutor a student, generate an item, translate a lesson — and
 * something else decides who answers. That separation is what keeps a model
 * swap from being a change to pedagogy.
 *
 * Two things were hardcoded and had to move together. `LLM_BASE_URL` was a
 * constant pointing at one gateway, and `claude-sonnet-4-6` appeared in six
 * places. Making only the URL configurable would have been worse than leaving
 * both alone: the client would reach the right server and ask for a model it
 * does not serve, failing every request while *looking* configurable.
 *
 * This is deployment-scoped on purpose. Policy per student, class or
 * organisation is a later wave and needs schools to exist before it pays for
 * itself; what this closes is the case of an institution saying "use our
 * endpoint", which needs no database at all.
 */

/** What the engine asks for. These are the purposes `llm.ts` already records. */
export type Capability =
  | 'tutor_chat'
  | 'coach_chat'
  | 'lesson_generation'
  | 'lesson_translation'
  | 'quiz_generation';

/** Unchanged behaviour when nothing is configured. */
const DEFAULT_BASE_URL = 'https://llm.atxp.ai/v1';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function modelEndpoint(): string {
  const configured = process.env.LLM_BASE_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_BASE_URL;
}

/**
 * The model for one capability.
 *
 * Resolved most specific first: a per-capability variable, then a deployment
 * default, then the built-in. A school can point tutoring at one model and item
 * generation at another without touching code — the case that makes this
 * capability-shaped rather than a single global switch.
 */
export function modelFor(capability: Capability): string {
  const specific = process.env[`LLM_MODEL_${capability.toUpperCase()}`]?.trim();
  if (specific) return specific;

  const fallback = process.env.LLM_MODEL?.trim();
  if (fallback) return fallback;

  return DEFAULT_MODEL;
}

/** What this deployment resolved to, for the health and admin surfaces. */
export function modelPolicy(): { endpoint: string; models: Record<Capability, string> } {
  const capabilities: Capability[] = [
    'tutor_chat', 'coach_chat', 'lesson_generation', 'lesson_translation', 'quiz_generation',
  ];
  return {
    endpoint: modelEndpoint(),
    models: Object.fromEntries(
      capabilities.map(capability => [capability, modelFor(capability)])
    ) as Record<Capability, string>,
  };
}
