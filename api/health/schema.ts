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
 */

import { schemaStatus } from '../_lib/db.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { staffRolesOf } from '../_lib/staff.js';

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);
  if (!auth) return unauthorized();

  const isStaff = (await staffRolesOf(auth.userId)).length > 0;

  return Response.json(
    {
      ok: schemaStatus.ready,
      checkedAt: schemaStatus.checkedAt,
      appliedThisStart: schemaStatus.applied,
      ...(schemaStatus.failed ? { failedMigration: schemaStatus.failed } : {}),
      // The underlying error names infrastructure: staff can act on it, a
      // student has no use for it and no business seeing it.
      ...(isStaff && schemaStatus.error ? { error: schemaStatus.error } : {}),
    },
    // A migration that did not finish is an outage, not a degradation: what
    // the instance serves on top of a half-applied schema is not trustworthy.
    { status: schemaStatus.ready ? 200 : 503 }
  );
}
