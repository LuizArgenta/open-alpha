/**
 * A healthcheck that cannot fail is not a healthcheck.
 *
 * The container's HEALTHCHECK is a bare fetch from inside the container, with
 * no credentials, and it reads the status code: 503 means unhealthy, anything
 * else means up. While this endpoint required authentication that fetch got
 * 401 — not 503 — so it reported healthy on every instance, including one
 * whose migration had failed. It passed unconditionally, which looks exactly
 * like passing correctly.
 *
 * These tests hold the two halves apart: the status code is for whoever asks,
 * the details are not.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaStatus } from '../api/_lib/db.js';
import { GET as health } from '../api/health/schema.js';
import { resetDatabase } from './helpers/database.js';

function anonymousRequest(): Request {
  return new Request('https://test.local/api/health/schema');
}

const ORIGINAL = { ...schemaStatus };

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  Object.assign(schemaStatus, ORIGINAL);
});

describe('the schema healthcheck', () => {
  it('answers an unauthenticated caller, because the orchestrator is one', async () => {
    const response = await health(anonymousRequest());
    expect(response.status).toBe(200);
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
  });

  it('reports 503 to that caller when a migration did not finish', async () => {
    schemaStatus.ready = false;
    schemaStatus.failed = '004-assessment-responses-unique';
    schemaStatus.error = 'SQLITE_CONSTRAINT: UNIQUE constraint failed';

    const response = await health(anonymousRequest());

    // The whole point: an instance serving on a half-applied schema has to be
    // distinguishable from a healthy one by a caller with no credentials.
    expect(response.status).toBe(503);
  });

  it('tells an anonymous caller whether, and nothing more', async () => {
    schemaStatus.ready = false;
    schemaStatus.failed = '004-assessment-responses-unique';
    schemaStatus.error = 'SQLITE_CONSTRAINT: UNIQUE constraint failed';

    const body = await (await health(anonymousRequest())).json() as Record<string, unknown>;

    expect(body).toEqual({ ok: false });
    // Which migration broke and why names this deployment's internals.
    expect(body.failedMigration).toBeUndefined();
    expect(body.error).toBeUndefined();
    expect(body.appliedThisStart).toBeUndefined();
  });
});
