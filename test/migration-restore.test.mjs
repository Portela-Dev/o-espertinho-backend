import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { testDatabase } from './helpers.mjs';

test('backup isolado restaura configurações e migrations sem tocar o banco de desenvolvimento', async () => {
  const { db, pg } = await testDatabase();
  let restored;
  try {
    const before = (await db.query('SELECT id,name FROM marketplaces ORDER BY id')).rows;
    const archive = await pg.dumpDataDir();
    restored = await PGlite.create({ loadDataDir: archive });
    assert.deepEqual((await restored.query('SELECT id,name FROM marketplaces ORDER BY id')).rows, before);
    assert.ok((await restored.query("SELECT tablename FROM pg_tables WHERE tablename='discovery_links'")).rows.length);
  } finally {
    await restored?.close();
    await db.end();
  }
});
