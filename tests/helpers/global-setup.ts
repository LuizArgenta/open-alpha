/**
 * Starts every run from an empty database.
 *
 * The suite shares one scratch file, and it used to survive between runs — so
 * a table created on one branch was still there after switching to another
 * that never creates it. That is not a hypothetical: `tests/data-notice.test.ts`
 * reads the live schema to check the data notice against it, and reported a
 * table the checked-out code does not define.
 *
 * The false red is the harmless half. The same leftover makes the opposite
 * check — that the notice describes only tables that exist — pass for a table
 * the code stopped creating, so a notice claiming something untrue about the
 * system would be waved through by the test written to catch exactly that.
 *
 * CI never saw either, because CI clones fresh. A test whose verdict depends
 * on the file's history rather than on the code is only trustworthy in the one
 * environment that has no history, which is the same shape as a timezone bug
 * that only hides in UTC.
 */

import { rm } from 'node:fs/promises';

const SCRATCH_DATABASE = 'tests/.tmp-test.db';

export async function setup(): Promise<void> {
  // The -wal and -shm siblings outlive the main file and carry committed
  // pages: deleting only the database leaves them to be replayed into the
  // new one, which is the same ghost by another route.
  await Promise.all(
    ['', '-wal', '-shm'].map(suffix =>
      rm(`${SCRATCH_DATABASE}${suffix}`, { force: true })
    )
  );
}
