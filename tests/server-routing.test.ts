/**
 * On Vercel, a file's path in api/ *is* its route, and nothing in the
 * repository writes that mapping down because the platform supplies it.
 * Running the same handlers in a container means supplying it — and a mapping
 * that only exists in a running server is one nobody can check.
 *
 * The last test here is the one that earns its place: it compares the routes
 * the frontend actually calls against the endpoints api/ actually provides.
 * That comparison found /api/progress/gamification missing before this file
 * existed — called by the student dashboard, answered by nothing, and
 * unnoticed because the dashboard never checks that response.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { collectRoutes, matchRoute, routeFor } from '../server/routes.js';

const routes = collectRoutes('api');

describe('mapping a file to a route', () => {
  it('uses the path as the route', () => {
    expect(routeFor('api/tutor/quiz/answer.ts').pattern).toBe('/api/tutor/quiz/answer');
  });

  it('lets an index file answer for its directory', () => {
    // /api/interests, not /api/interests/index — the frontend calls the former.
    expect(routeFor('api/interests/index.ts').pattern).toBe('/api/interests');
  });

  it('reads a bracketed segment as a parameter', () => {
    const route = routeFor('api/parent/children/[childId]/progress.ts');
    expect(route.pattern).toBe('/api/parent/children/:childId/progress');
    expect(route.segments[3]).toEqual({ value: 'childId', dynamic: true });
  });
});

describe('collecting the endpoints', () => {
  it('finds the handlers and skips the shared modules', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some(route => route.file.includes('/_lib/'))).toBe(false);
  });

  it('prefers a literal segment over a parameter', () => {
    // Both api/tutor/quiz.ts and api/tutor/next/[subject].ts exist. Whichever
    // the filesystem happens to list first must not decide which one answers.
    const matched = matchRoute(routes, '/api/tutor/quiz');
    expect(matched?.file).toBe('api/tutor/quiz.ts');
  });

  it('tells apart a file and a directory of the same name', () => {
    expect(matchRoute(routes, '/api/tutor/quiz')?.file).toBe('api/tutor/quiz.ts');
    expect(matchRoute(routes, '/api/tutor/quiz/answer')?.file).toBe('api/tutor/quiz/answer.ts');
  });

  it('fills a parameter from the path', () => {
    expect(matchRoute(routes, '/api/tutor/concepts/math')?.file)
      .toBe('api/tutor/concepts/[subject].ts');
  });

  it('matches nothing for a path no file claims', () => {
    expect(matchRoute(routes, '/api/does/not/exist')).toBeUndefined();
    // A parameter matches one segment, never several.
    expect(matchRoute(routes, '/api/tutor/concepts/math/extra')).toBeUndefined();
  });
});

/** Every /api/... path the frontend fetches, without its query string. */
function endpointsTheFrontendCalls(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(path);
    }
  };
  walk('frontend/src');

  const found = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    for (const match of source.matchAll(/['"`](\/api\/[^'"`?\s]*)/g)) {
      // Template literals interpolate the rest of the path, so a fragment
      // ending in ${ tells us nothing and is skipped.
      const path = match[1].replace(/\/$/, '');
      if (!path.includes('${')) found.add(path);
    }
  }
  return [...found].sort();
}

describe('the frontend and the api agree on what exists', () => {
  /**
   * Called by the student dashboard, provided by nothing. It lived only in
   * the Express backend deleted alongside this change — which was six months
   * stale and graded quizzes from a score the browser sent, so it was never a
   * candidate to deploy. The endpoint has to be rewritten against api/ before
   * the dashboard shows whatever it was meant to show.
   *
   * Pinned rather than hidden: this test fails if the gap grows, and fails
   * again once it is closed and this entry goes stale.
   */
  const KNOWN_MISSING = ['/api/progress/gamification'];

  it('serves every endpoint the frontend calls, except the known gap', () => {
    const missing = endpointsTheFrontendCalls().filter(path => {
      // A call to /api/progress/map is completed at runtime with /:subject.
      return !matchRoute(routes, path) && !routes.some(r => r.pattern.startsWith(`${path}/:`));
    });

    expect(missing).toEqual(KNOWN_MISSING);
  });
});
