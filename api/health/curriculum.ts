/**
 * GET /api/health/curriculum
 *
 * Whether this instance is serving the curriculum it was supposed to serve.
 *
 * Exists because the failure it reports is invisible from the outside: when
 * the database cannot be read, the seed files load, every page renders and
 * every quiz works — with a curriculum nobody published. Something has to be
 * able to answer "is this instance degraded?" without reading logs.
 */

import { curriculumStatus } from '../_lib/curriculum.js';
import { getAuthFromRequest, unauthorized } from '../_lib/auth.js';
import { staffRolesOf } from '../_lib/staff.js';

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);
  if (!auth) return unauthorized();

  const roles = await staffRolesOf(auth.userId);
  const isStaff = roles.length > 0;

  return Response.json(
    {
      ok: !curriculumStatus.degraded,
      origin: curriculumStatus.origin,
      degraded: curriculumStatus.degraded,
      reason: curriculumStatus.reason,
      loadedAt: curriculumStatus.loadedAt,
      // How current this particular instance is, which is the question when
      // one instance shows a concept and another does not.
      checkedAt: curriculumStatus.checkedAt,
      revision: curriculumStatus.revision,
      ...(isStaff && curriculumStatus.refreshError ? { refreshError: curriculumStatus.refreshError } : {}),
      subjects: curriculumStatus.subjects,
      concepts: curriculumStatus.concepts,
      // A concept stored but unusable is missing from the graph: a student
      // whose progress points at it has nowhere to go.
      invalidRecords: curriculumStatus.invalidRecords.length,
      ...(isStaff && curriculumStatus.invalidRecords.length > 0
        ? { problems: curriculumStatus.invalidRecords }
        : {}),
      // The underlying error names infrastructure. Staff are the ones who can
      // act on it; a student has no use for it and no business seeing it.
      ...(isStaff && curriculumStatus.error ? { error: curriculumStatus.error } : {}),
    },
    // A degraded instance answering 200 is how this went unnoticed in the
    // first place. 503 is what a monitor is already watching for. Dropped
    // records are not an outage — the published curriculum is being served —
    // so they are reported without failing the check.
    { status: curriculumStatus.degraded ? 503 : 200 }
  );
}
