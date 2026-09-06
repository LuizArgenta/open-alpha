/**
 * Mapping the api/ directory to routes, the way Vercel does.
 *
 * Every endpoint in api/ is a file exporting `GET`, `POST` and friends that
 * take a `Request` and return a `Response`. On Vercel the file's path *is* the
 * route; nothing in the repository writes that mapping down, because the
 * platform supplies it. Running the same handlers in a container means
 * supplying it here instead.
 *
 * Kept apart from the server so the part with actual rules — index files,
 * dynamic segments, which of two candidates wins — can be tested without
 * opening a socket.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface ApiRoute {
  /** Path relative to the repository root, e.g. `api/tutor/quiz/answer.ts`. */
  file: string;
  /** URL path, e.g. `/api/tutor/quiz/answer`. */
  pattern: string;
  /** The segments, with dynamic ones marked. */
  segments: { value: string; dynamic: boolean }[];
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // Shared modules, not endpoints. Vercel skips underscore-prefixed
      // directories for the same reason.
      return entry.startsWith('_') ? [] : walk(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Turns `api/parent/children/[childId]/progress.ts` into
 * `/api/parent/children/:childId/progress`, and `api/interests/index.ts` into
 * `/api/interests` — a directory's index file answers for the directory.
 */
export function routeFor(file: string): ApiRoute {
  const withoutExtension = file.replace(/\.ts$/, '');
  const parts = withoutExtension.split('/').filter(part => part.length > 0);
  if (parts[parts.length - 1] === 'index') parts.pop();

  const segments = parts.map(part => {
    const dynamic = part.startsWith('[') && part.endsWith(']');
    return { value: dynamic ? part.slice(1, -1) : part, dynamic };
  });

  const pattern = '/' + segments.map(s => (s.dynamic ? `:${s.value}` : s.value)).join('/');
  return { file, pattern, segments };
}

/**
 * Every endpoint under `apiDir`, ordered so a literal segment is tried before
 * a dynamic one.
 *
 * Without that order `/api/tutor/quiz` could be answered by
 * `tutor/[subject].ts` depending on how the directory happened to be read,
 * and which endpoint runs would depend on filesystem order rather than on
 * anything anyone decided.
 */
export function collectRoutes(apiDir = 'api'): ApiRoute[] {
  return walk(apiDir)
    .map(routeFor)
    .sort((left, right) => {
      if (left.segments.length !== right.segments.length) {
        return left.segments.length - right.segments.length;
      }
      for (let index = 0; index < left.segments.length; index += 1) {
        const leftDynamic = left.segments[index].dynamic ? 1 : 0;
        const rightDynamic = right.segments[index].dynamic ? 1 : 0;
        if (leftDynamic !== rightDynamic) return leftDynamic - rightDynamic;
      }
      return left.pattern.localeCompare(right.pattern);
    });
}

/** The first route whose shape matches this path, or undefined. */
export function matchRoute(routes: ApiRoute[], pathname: string): ApiRoute | undefined {
  const parts = pathname.split('/').filter(part => part.length > 0);
  return routes.find(route => {
    if (route.segments.length !== parts.length) return false;
    return route.segments.every(
      (segment, index) => segment.dynamic || segment.value === parts[index]
    );
  });
}
