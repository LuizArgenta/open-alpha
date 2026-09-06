/**
 * POST /api/progress/events — what the browser saw.
 *
 * The counterpart to the server's own writes: lesson starts and ends, hint
 * requests and idle timeouts are things only the client is in a position to
 * observe. It is a *report*, and the row records that in `source`.
 *
 * Three things were wrong with the previous version, and all three were
 * invisible.
 *
 * It kept its own list of valid event types, seven where the rest of the
 * system has eight — a browser could not report `quiz_expired`, and nothing
 * anywhere compared the two lists. The vocabulary now comes from
 * `event-contract.ts`, which is also what the CHECK constraint is built from,
 * so the two cannot disagree again.
 *
 * It wrote with a bare `executeSql`, outside the write queue. That is the
 * SQLITE_BUSY that PR #46 fixed for the answer insert and that I reintroduced
 * once already in `events.ts`; here it was a request the browser fires and
 * forgets, so the collision showed up as an event that silently never existed.
 *
 * And it had no idempotency, while being called by a `fetch(...).catch(() =>
 * {})` — the one shape where a retry is both likely and unaccounted for. A
 * client that resends now sends the same `dedupeKey` and the second write is a
 * no-op instead of a second lesson start.
 */

import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { credibleOccurredAt, isLearningEventType } from '../_lib/event-contract.js';
import { recordEvent } from '../_lib/events.js';

export async function POST(request: Request) {
  try {
    const auth = getAuthFromRequest(request);
    if (!auth || auth.role !== 'student') return unauthorized();

    const body = await request.json() as {
      subject?: string;
      conceptId?: string;
      eventType?: string;
      payload?: Record<string, unknown>;
      occurredAt?: string;
      dedupeKey?: string;
    };

    const { subject, conceptId, eventType, payload } = body;

    if (!subject || !conceptId || !eventType) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!isLearningEventType(eventType)) {
      return Response.json({ error: `Invalid event type: ${eventType}` }, { status: 400 });
    }

    const recorded = await recordEvent({
      studentId: auth.userId,
      subject,
      conceptId,
      type: eventType,
      source: 'browser',
      // The client knows when the person did the thing; the server knows
      // whether to believe it. See credibleOccurredAt.
      occurredAt: credibleOccurredAt(body.occurredAt),
      dedupeKey: typeof body.dedupeKey === 'string' && body.dedupeKey.trim().length > 0
        ? body.dedupeKey.trim().slice(0, 100)
        : undefined,
      payload: payload ?? {},
    });

    // Answering "success" for a write that failed is what makes a retry
    // impossible. The dedupe key is what makes the retry safe.
    if (!recorded) {
      return Response.json({ error: 'Failed to record event' }, { status: 500 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Record event error:', error);
    return Response.json({ error: 'Failed to record event' }, { status: 500 });
  }
}
