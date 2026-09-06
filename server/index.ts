/**
 * The container's HTTP server.
 *
 * On Vercel each file in api/ is its own function and the platform routes to
 * it; the built frontend is served as static files, with everything that is
 * not /api/* falling back to index.html so the SPA can route it. That is what
 * vercel.json describes, and this reproduces it in one process so the same
 * handlers can run on a plain VPS.
 *
 * The handlers are untouched: they take a `Request` and return a `Response`,
 * and they read their own path, query and body out of it. Nothing here parses
 * on their behalf, so there is no second interpretation of a request to drift
 * from the first.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFile, stat } from 'fs/promises';
import { extname, join, normalize } from 'path';
import { initializeSchema, schemaStatus } from '../api/_lib/db.js';
import { requireEnvironment } from './environment.js';
import { collectRoutes, matchRoute } from './routes.js';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR ?? 'frontend/dist';
const API_DIR = 'api';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function readBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
  if (incoming.method === 'GET' || incoming.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

/** A Node request as the Web `Request` the handlers were written against. */
async function toWebRequest(incoming: IncomingMessage): Promise<Request> {
  const host = incoming.headers.host ?? `localhost:${PORT}`;
  const protocol = incoming.headers['x-forwarded-proto'] ?? 'http';
  const url = new URL(incoming.url ?? '/', `${protocol}://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
  }

  return new Request(url, {
    method: incoming.method ?? 'GET',
    headers,
    body: await readBody(incoming),
  });
}

async function send(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = name.toLowerCase() === 'set-cookie' ? [value] : value;
  });
  outgoing.writeHead(response.status, headers);
  outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

/**
 * A static file, or undefined if the path does not name one.
 *
 * `normalize` before joining, and a prefix check afterwards, so a request for
 * `../../etc/passwd` cannot read its way out of the build output.
 */
async function staticFile(pathname: string): Promise<{ body: Buffer; type: string } | undefined> {
  const root = normalize(STATIC_DIR);
  const candidate = normalize(join(root, pathname));
  if (!candidate.startsWith(root)) return undefined;

  try {
    if (!(await stat(candidate)).isFile()) return undefined;
    return {
      body: await readFile(candidate),
      type: CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    };
  } catch {
    return undefined;
  }
}

const routes = collectRoutes(API_DIR);

async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const rawUrl = incoming.url ?? '/';
  const pathname = new URL(rawUrl, 'http://localhost').pathname;

  if (pathname.startsWith('/api/')) {
    const route = matchRoute(routes, pathname);
    if (!route) {
      outgoing.writeHead(404, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const module = await import(`../${route.file}`) as Record<string, unknown>;
    const method = (incoming.method ?? 'GET').toUpperCase();
    const handler = module[method];

    if (typeof handler !== 'function') {
      outgoing.writeHead(405, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const request = await toWebRequest(incoming);
    await send(await (handler as (r: Request) => Promise<Response>)(request), outgoing);
    return;
  }

  const asset = await staticFile(pathname);
  if (asset) {
    outgoing.writeHead(200, { 'content-type': asset.type });
    outgoing.end(asset.body);
    return;
  }

  // Anything else is a route the SPA owns, so it gets the shell and decides.
  const shell = await staticFile('/index.html');
  if (!shell) {
    outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    outgoing.end(`No frontend build found in ${STATIC_DIR}. Run: npm run build --workspace=frontend`);
    return;
  }
  outgoing.writeHead(200, { 'content-type': shell.type });
  outgoing.end(shell.body);
}

export async function start(): Promise<void> {
  // Refusing to boot beats booting wrong: a container that comes up without
  // its database or its secret would serve requests it cannot answer, and the
  // curriculum would quietly fall back to the seed files.
  requireEnvironment();

  await initializeSchema();
  if (!schemaStatus.ready) {
    throw new Error('Schema migrations did not complete; refusing to serve.');
  }

  createServer((incoming, outgoing) => {
    handle(incoming, outgoing).catch(error => {
      console.error('Unhandled request error:', error);
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
      }
      outgoing.end(JSON.stringify({ error: 'Internal server error' }));
    });
  }).listen(PORT, () => {
    console.log(`open-alpha listening on :${PORT} (${routes.length} api routes)`);
  });
}

start().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
