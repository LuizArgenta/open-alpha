/**
 * Guards the global security headers declared in vercel.json. These aren't
 * exercised by any request in this test suite — Vercel applies them at the
 * edge, outside our serverless functions — so the only way to catch someone
 * silently dropping one while editing the file is to assert on it directly.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

interface HeaderEntry {
  key: string;
  value: string;
}

interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

const config = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf-8')) as {
  headers?: HeaderRule[];
};

function headersForAllRoutes(): Map<string, string> {
  const rule = config.headers?.find(r => r.source === '/(.*)');
  if (!rule) throw new Error('vercel.json has no headers rule matching all routes');
  return new Map(rule.headers.map(h => [h.key, h.value]));
}

describe('security headers (vercel.json)', () => {
  const headers = headersForAllRoutes();

  it('enables HSTS with a long max-age and includeSubDomains', () => {
    const hsts = headers.get('Strict-Transport-Security');
    expect(hsts).toBeDefined();
    expect(hsts).toMatch(/max-age=\d+/);
    expect(Number(hsts!.match(/max-age=(\d+)/)![1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toMatch(/includeSubDomains/);
  });

  it('blocks MIME sniffing', () => {
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('denies framing, both by legacy header and CSP frame-ancestors', () => {
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Content-Security-Policy')).toMatch(/frame-ancestors 'none'/);
  });

  it('restricts CSP default-src to self, with no wildcard or unsafe-inline', () => {
    const csp = headers.get('Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/unsafe-inline/);
    expect(csp).not.toMatch(/[^-]\*/); // no bare wildcard source (e.g. "src *")
  });

  it('sends a restrictive Referrer-Policy', () => {
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
