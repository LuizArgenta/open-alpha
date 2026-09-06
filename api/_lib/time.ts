/**
 * Reading the database's timestamps as what they are.
 *
 * SQLite's `datetime('now')` writes UTC, in `YYYY-MM-DD HH:MM:SS` — a form
 * with no timezone marker at all. JavaScript reads that shape as *local* time,
 * so `new Date(row.next_review_at)` was silently off by the server's UTC
 * offset. Every timestamp this schema stores comes from `datetime('now')`, so
 * every such read was wrong by the same amount.
 *
 * It hid well. Two stored timestamps compared against each other are both
 * shifted by the same offset, which cancels: the diagnosis reading gaps
 * between answers was, and remains, correct. It only surfaces where a stored
 * timestamp meets real time — `Date.now()` — and there it moves decisions.
 * A review scheduled for midnight came due at 21:00 on a UTC-3 server, and an
 * inactivity alert counted nine days where the learner had been away ten.
 *
 * Three hours is not a rounding error when the thing being decided is whether
 * someone has forgotten a concept.
 */

/** Matches an explicit UTC marker or a ±HH:MM offset at the end of the string. */
const HAS_EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses a timestamp as stored by this schema.
 *
 * A string that already carries its own offset is trusted as-is — a caller
 * that went to the trouble of writing one means it. Anything else is treated
 * as UTC, because that is what the database writes and there is no other
 * convention in this codebase for it to be.
 */
export function parseDbTimestamp(value: string): Date {
  const trimmed = value.trim();
  if (HAS_EXPLICIT_ZONE.test(trimmed)) return new Date(trimmed);
  return new Date(`${trimmed.replace(' ', 'T')}Z`);
}

/** Whole days from a stored timestamp until `now`, floored. */
export function daysSince(from: string, now: Date = new Date()): number {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  return Math.floor((now.getTime() - parseDbTimestamp(from).getTime()) / MS_PER_DAY);
}

/**
 * Writes a timestamp in the one shape this schema uses.
 *
 * `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` in UTC, and every stored
 * timestamp is that. A client-supplied ISO string is the same instant in a
 * different notation, and storing it verbatim would put two notations in one
 * column: `date(...)` copes, but ordering does not — `'…T22:00:00Z'` sorts
 * after `'… 23:00:00'` on a plain string compare, so two rows a minute apart
 * could come back in the wrong order depending on which wrote them.
 */
export function toDbTimestamp(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 19);
}
