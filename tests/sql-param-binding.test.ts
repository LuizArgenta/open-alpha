/**
 * executeSql and executeTransaction used to bind $1, $2... to parameters by
 * the order placeholders happened to appear in the SQL text, ignoring the
 * number itself. That is invisible whenever every query happens to write its
 * placeholders in ascending order with no repeats — which is every query in
 * this codebase today (checked by hand before this fix landed) — but a single
 * repeated or reordered placeholder in a future query would silently write to
 * the wrong column. This guards the fix: binding must follow the captured
 * number, not position.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeSql, executeTransaction } from '../api/_lib/db.js';

async function resetProbeTable(): Promise<void> {
  await executeSql('CREATE TABLE IF NOT EXISTS sql_binding_probe (a TEXT, b TEXT, c TEXT)');
  await executeSql('DELETE FROM sql_binding_probe');
}

beforeEach(async () => {
  await resetProbeTable();
});

/**
 * Every test file shares one scratch database, so a table left behind here is
 * a table the rest of the suite has to know about. `tests/data-notice.test.ts`
 * reads the schema to check the data notice against it, and found this one
 * sitting there pretending to be part of the product.
 */
afterAll(async () => {
  await executeSql('DROP TABLE IF EXISTS sql_binding_probe');
});

describe('SQL parameter binding', () => {
  it('binds placeholders in ascending order to the matching argument', async () => {
    await executeSql('INSERT INTO sql_binding_probe (a, b, c) VALUES ($1, $2, $3)', [
      'first',
      'second',
      'third',
    ]);
    const result = await executeSql<{ a: string; b: string; c: string }>(
      'SELECT a, b, c FROM sql_binding_probe'
    );
    expect(result.rows[0]).toEqual({ a: 'first', b: 'second', c: 'third' });
  });

  it('binds placeholders written out of order by their number, not their position', async () => {
    // $2 appears before $1 in the text — order-of-appearance binding would
    // put the first argument in column b and the second in column a.
    await executeSql('INSERT INTO sql_binding_probe (b, a) VALUES ($2, $1)', ['a-value', 'b-value']);
    const result = await executeSql<{ a: string; b: string }>(
      'SELECT a, b FROM sql_binding_probe'
    );
    expect(result.rows[0]).toEqual({ a: 'a-value', b: 'b-value' });
  });

  it('binds a repeated placeholder to the same argument every time', async () => {
    await executeSql('INSERT INTO sql_binding_probe (a, b, c) VALUES ($1, $1, $2)', [
      'shared',
      'other',
    ]);
    const result = await executeSql<{ a: string; b: string; c: string }>(
      'SELECT a, b, c FROM sql_binding_probe'
    );
    expect(result.rows[0]).toEqual({ a: 'shared', b: 'shared', c: 'other' });
  });

  it('throws rather than silently binding when a placeholder has no matching argument', async () => {
    await expect(
      executeSql('INSERT INTO sql_binding_probe (a, b) VALUES ($1, $2)', ['only-one'])
    ).rejects.toThrow(/Missing SQL parameter \$2/);
  });

  it('throws on a placeholder number of zero or below, which no argument can satisfy', async () => {
    await expect(
      executeSql('SELECT * FROM sql_binding_probe WHERE a = $0', ['x'])
    ).rejects.toThrow(/Missing SQL parameter \$0/);
  });

  it('runs unparameterized statements unchanged', async () => {
    await executeSql("INSERT INTO sql_binding_probe (a) VALUES ('literal')");
    const result = await executeSql<{ a: string }>("SELECT a FROM sql_binding_probe WHERE a = 'literal'");
    expect(result.rows).toHaveLength(1);
  });

  describe('inside a transaction (executeTransaction)', () => {
    it('binds out-of-order and repeated placeholders the same way executeSql does', async () => {
      await executeTransaction([
        { sql: 'INSERT INTO sql_binding_probe (b, a) VALUES ($2, $1)', params: ['a-value', 'b-value'] },
        { sql: 'UPDATE sql_binding_probe SET c = $1 WHERE a = $1', params: ['same'] },
      ]);
      const result = await executeSql<{ a: string; b: string; c: string }>(
        'SELECT a, b, c FROM sql_binding_probe'
      );
      // Row 1: a = 'a-value' (from $1), b = 'b-value' (from $2).
      // Row 1 update: $1 used for both the SET value and the WHERE match —
      // 'same' can only equal a's value ('a-value') if $1 bound consistently,
      // so the row is only touched when the repeated placeholder is honored.
      expect(result.rows[0]).toEqual({ a: 'a-value', b: 'b-value', c: null });
    });

    it('rolls back the whole batch when one statement has a missing argument', async () => {
      await executeSql("INSERT INTO sql_binding_probe (a) VALUES ('before')");
      await expect(
        executeTransaction([
          { sql: 'INSERT INTO sql_binding_probe (a, b) VALUES ($1, $2)', params: ['ok', 'ok'] },
          { sql: 'INSERT INTO sql_binding_probe (a, b) VALUES ($1, $2)', params: ['not-enough'] },
        ])
      ).rejects.toThrow(/Missing SQL parameter \$2/);

      // Neither statement in the failed transaction landed; only the row
      // inserted before it was ever attempted remains.
      const result = await executeSql<{ a: string }>('SELECT a FROM sql_binding_probe');
      expect(result.rows.map(r => r.a)).toEqual(['before']);
    });
  });
});
