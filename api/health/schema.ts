/**
 * GET /api/health/schema
 *
 * Whether this instance's database schema finished migrating.
 *
 * The failure it reports used to be invisible: every `ALTER TABLE` ran inside
 * a `catch {}` that discarded the exception, so a database that could not be
 * migrated — no permission, a failed constraint, a corrupt file — came up
 * looking healthy and started serving students against a schema that was
 * missing pieces. A monitor needs to be able to ask.
 *
 * The monitor is usually not a person and has no credentials: the container's
 * HEALTHCHECK is a bare fetch from inside the container. This endpoint used to
 * require authentication, so that fetch got 401 — and since 401 is not 503,
 * the healthcheck read it as "up". It passed unconditionally, including on an
 * instance whose migration had failed, which is the one case it existed to
 * catch. So the *status code* is public and the *details* are not: an
 * anonymous caller learns whether this instance is serving and nothing else.
 */

import { schemaStatus } from '../_lib/db.js';
import { getAuthFromRequest } from '../_lib/auth.js';
import { staffRolesOf } from '../_lib/staff.js';

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);
  const isStaff = auth ? (await staffRolesOf(auth.userId)).length > 0 : false;

  return Response.json(
    {
      ok: schemaStatus.ready,
      // Which migrations ran and when names this deployment's internals, and
      // an anonymous caller has the status code, which is all an orchestrator
      // needs. Signing in is what turns a yes/no into a diagnosis.
      ...(auth
        ? {
            checkedAt: schemaStatus.checkedAt,
            appliedThisStart: schemaStatus.applied,
            ...(schemaStatus.failed ? { failedMigration: schemaStatus.failed } : {}),
          }
        : {}),
      // The underlying error names infrastructure: staff can act on it, a
      // student has no use for it and no business seeing it.
      ...(isStaff && schemaStatus.error ? { error: schemaStatus.error } : {}),
    },
    // A migration that did not finish is an outage, not a degradation: what
    // the instance serves on top of a half-applied schema is not trustworthy.
    { status: schemaStatus.ready ? 200 : 503 }
  );
}
