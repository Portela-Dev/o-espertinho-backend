import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogFixture } from './catalog-helpers.mjs';

async function setup(t, count = 1100) {
  const f = await catalogFixture(t);
  await f.db.query("UPDATE catalog_resolver_settings SET mode='active'");
  await f.db.query(`INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url)
    SELECT gen_random_uuid(),'amazon','https://www.amazon.com.br/product/'||n,'https://www.amazon.com.br/product/'||n FROM generate_series(1,$1::int) n`, [count]);
  const start = async (limit, requestKey = randomUUID(), task = 'product') => {
    const r = await f.call('post', '/catalog/resolver/start', { marketplaceId: 'amazon', task, limit, requestKey });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const total = async id => (await f.db.query('SELECT count(*)::int AS n FROM catalog_resolver_items WHERE run_id=$1', [id])).rows[0].n;
  return { ...f, start, total };
}

test('retomar com a mesma chave ou outra amplia 100 para 1000 sem duplicar nem perder trabalho', async t => {
  const f = await setup(t), key = randomUUID(), run = await f.start(100, key);
  assert.equal(await f.total(run.id), 100);
  const item = (await f.db.query('SELECT id FROM catalog_resolver_items WHERE run_id=$1 ORDER BY id LIMIT 1', [run.id])).rows[0];
  await f.db.query("UPDATE catalog_resolver_items SET status='accepted',decision=$2 WHERE id=$1", [item.id, JSON.stringify({ saved: true })]);
  await f.call('post', '/catalog/resolver/action', { runId: run.id, action: 'pause' });
  assert.equal((await f.start(1000, key)).id, run.id);
  assert.equal(await f.total(run.id), 1000);
  assert.equal((await f.start(1000)).id, run.id);
  assert.equal(await f.total(run.id), 1000);
  const saved = (await f.db.query('SELECT status,decision FROM catalog_resolver_items WHERE id=$1', [item.id])).rows[0];
  assert.equal(saved.status, 'accepted'); assert.deepEqual(saved.decision, { saved: true });
  assert.equal((await f.db.query('SELECT count(DISTINCT link_id)::int AS n FROM catalog_resolver_items WHERE run_id=$1', [run.id])).rows[0].n, 1000);
  const mismatch = await f.call('post', '/catalog/resolver/start', { marketplaceId: 'amazon', task: 'category', limit: 1000, requestKey: key });
  assert.equal(mismatch.status, 409);
});

test('reduzir limita a fila sem apagar resultados, reservas ou trabalho já iniciado; esgotamento não inventa itens', async t => {
  const f = await setup(t, 12), run = await f.start(10);
  const rows = (await f.db.query('SELECT id FROM catalog_resolver_items WHERE run_id=$1 ORDER BY id LIMIT 3', [run.id])).rows;
  await f.db.query("UPDATE catalog_resolver_items SET status='accepted' WHERE id=$1", [rows[0].id]);
  await f.db.query("UPDATE catalog_resolver_items SET status='leased',lease_id=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1", [rows[1].id, randomUUID()]);
  await f.db.query("UPDATE catalog_resolver_items SET attempts=1,context=$2 WHERE id=$1", [rows[2].id, JSON.stringify({ stage: 'match' })]);
  assert.equal((await f.start(5)).id, run.id); assert.equal(await f.total(run.id), 5);
  await f.start(1); assert.equal(await f.total(run.id), 3);
  for (const row of rows) assert.equal((await f.db.query('SELECT id FROM catalog_resolver_items WHERE id=$1', [row.id])).rows.length, 1);
  await f.start(1000); assert.equal(await f.total(run.id), 12);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM discovery_links')).rows[0].n, 12);
  await f.call('post', '/catalog/resolver/action', { runId: run.id, action: 'cancel' });
  const other = await f.start(5); assert.notEqual(other.id, run.id); assert.equal(await f.total(other.id), 5);
  assert.equal(await f.total(run.id), 12);
});

test('categorização aplica o novo limite e execuções concluídas não são reabertas por repetição', async t => {
  const f = await setup(t, 4);
  // Shadow receipts are an existing supported source of category candidates.
  await f.db.query("UPDATE catalog_resolver_settings SET mode='shadow'");
  await f.db.query(`INSERT INTO catalog_resolver_receipts(link_id,task,source_hash,policy_version,result) SELECT id,'product','test',1,'{"mode":"shadow","outcome":"drafted"}'::jsonb FROM discovery_links`);
  const key = randomUUID(), run = await f.start(1, key, 'category');
  assert.equal(await f.total(run.id), 1);
  assert.equal((await f.start(4, key, 'category')).id, run.id); assert.equal(await f.total(run.id), 4);
  await f.db.query("UPDATE catalog_resolver_runs SET status='completed' WHERE id=$1", [run.id]);
  const completed = await f.start(1, key, 'category'); assert.equal(completed.status, 'completed'); assert.equal(await f.total(run.id), 4);
  const cancelledKey = randomUUID(), cancelled = await f.start(2, cancelledKey, 'category');
  await f.call('post', '/catalog/resolver/action', { runId: cancelled.id, action: 'cancel' });
  assert.equal((await f.start(4, cancelledKey, 'category')).status, 'cancelled');
  assert.equal(await f.total(cancelled.id), 2);
  const rejected = await f.call('post', '/catalog/resolver/start', { marketplaceId: 'amazon', task: 'category', limit: 10001, requestKey: key });
  assert.equal(rejected.status, 400);
});
