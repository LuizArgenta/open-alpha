/**
 * The API sends translation keys instead of sentences, which introduces a
 * failure the type system cannot see: a key the server emits and the client
 * has no entry for renders as nothing at all.
 *
 * Both sides are read as text rather than imported — the dictionaries live in
 * the frontend workspace, outside this tsconfig.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const API_DIR = join(process.cwd(), 'api');
const PT_BR = join(process.cwd(), 'frontend/src/i18n/pt-BR.ts');
const EN = join(process.cwd(), 'frontend/src/i18n/en.ts');

/** Namespaces the API is allowed to emit keys in. */
const SERVER_KEY_PATTERN = /'((?:alert|diagnosis|focus|remediation)\.[A-Za-z_.]+)'/g;
const DICTIONARY_KEY_PATTERN = /^\s*'([A-Za-z][A-Za-z_.-]*)':/gm;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function keysEmittedByApi(): Map<string, string[]> {
  const byKey = new Map<string, string[]>();

  for (const file of walk(API_DIR)) {
    const source = readFileSync(file, 'utf-8');
    for (const [, key] of source.matchAll(SERVER_KEY_PATTERN)) {
      byKey.set(key, [...(byKey.get(key) ?? []), file.replace(process.cwd() + '/', '')]);
    }
  }

  return byKey;
}

function keysIn(dictionaryPath: string): Set<string> {
  const source = readFileSync(dictionaryPath, 'utf-8');
  return new Set([...source.matchAll(DICTIONARY_KEY_PATTERN)].map(match => match[1]));
}

/**
 * XP reasons are a union in the API and become 'xp.reason.<value>' on the
 * client, so the key never appears as a literal anywhere and the scan above
 * cannot see it.
 */
function xpReasons(): string[] {
  const source = readFileSync(join(API_DIR, '_lib/xp.ts'), 'utf-8');
  const union = source.match(/export type XpReason =([\s\S]*?);/);
  if (!union) return [];
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
}

describe('translation keys', () => {
  it('finds the keys the API emits', () => {
    // Guards the regex itself: a rename that breaks it would otherwise make
    // every assertion below pass vacuously.
    expect(keysEmittedByApi().size).toBeGreaterThan(5);
  });

  it('has a Portuguese entry for every key the API emits', () => {
    const dictionary = keysIn(PT_BR);
    const missing = [...keysEmittedByApi().entries()]
      .filter(([key]) => !dictionary.has(key))
      .map(([key, files]) => `${key} (from ${files.join(', ')})`);

    expect(missing).toEqual([]);
  });

  it('has an English entry for every key the API emits', () => {
    const dictionary = keysIn(EN);
    const missing = [...keysEmittedByApi().keys()].filter(key => !dictionary.has(key));

    expect(missing).toEqual([]);
  });

  it('has an entry for every XP reason the API can return', () => {
    const reasons = xpReasons();
    expect(reasons.length).toBeGreaterThan(3);

    const ptBR = keysIn(PT_BR);
    const en = keysIn(EN);
    const missing = reasons.flatMap(reason => {
      const key = `xp.reason.${reason}`;
      return [
        ...(ptBR.has(key) ? [] : [`pt-BR ${key}`]),
        ...(en.has(key) ? [] : [`en ${key}`]),
      ];
    });

    expect(missing).toEqual([]);
  });

  it('keeps both dictionaries in step', () => {
    const ptBR = keysIn(PT_BR);
    const en = keysIn(EN);

    expect([...ptBR].filter(key => !en.has(key))).toEqual([]);
    expect([...en].filter(key => !ptBR.has(key))).toEqual([]);
  });
});
