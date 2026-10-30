import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogFixture } from './catalog-helpers.mjs';
import {
  defaultPolicies,
  sourceData,
  validateIdentity,
  deterministicIdentity,
  normalizeAttribute,
  selectPolicy,
} from '../dist/catalog-identity.js';
const policy = defaultPolicies.find((p) => p.id === 'smartphone');
const data = {
  title: 'Celular Marca Modelo X 128 GB 8 GB',
  brand: 'Marca',
  description: 'Modelo X, armazenamento 128 GB, RAM física 8 GB.',
  specifications: [
    { name: 'Modelo', value: 'Modelo X' },
    { name: 'Armazenamento', value: '128 GB' },
    { name: 'RAM', value: '8 GB' },
  ],
  priceCents: 12345,
  images: ['https://example.com/image.jpg'],
  availability: 'available',
  missing: [],
};
const input = {
  policyId: 'smartphone',
  facts: {
    brand: { value: 'Marca', evidence: 'Marca' },
    model: { value: 'Modelo X', evidence: 'Modelo X' },
    storage: { value: '128 GB', evidence: '128 GB' },
    ram: { value: '8 GB', evidence: '8 GB' },
  },
  exclude: false,
  reason: '',
};
async function seed(f, d = data) {
  const id = randomUUID(),
    url = 'https://www.amazon.com.br/product/' + id;
  await f.db.query(
    "INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,extracted_at) VALUES($1,'amazon',$2,$2,'completed',$3,clock_timestamp())",
    [id, url, JSON.stringify(d)],
  );
  return id;
}
async function mode(f, mode = 'active') {
  const r = await f.browser.get(
    '/api/admin/discovery/enrichment/resolver/settings',
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await f.browser.mutate(
    'put',
    '/api/admin/discovery/enrichment/resolver/settings',
    { version: r.body.settings.version, mode, maxAttempts: 2, concurrency: 1 },
  );
  assert.equal(s.status, 200, JSON.stringify(s.body));
}
async function start(f, task = 'product') {
  const r = await f.call('post', '/catalog/resolver/start', {
    marketplaceId: 'amazon',
    task,
    limit: 100,
    requestKey: randomUUID(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function claim(f, run) {
  const r = await f.call('post', '/catalog/resolver/claim', { runId: run.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function complete(f, run, item, decision, extra = {}) {
  return f.call('post', '/catalog/resolver/complete', {
    runId: run.id,
    itemId: item.id,
    leaseId: item.leaseId,
    decision,
    model: '',
    ...extra,
  });
}
async function category(f) {
  return (
    await f.db.query(
      "SELECT ids FROM register_category_path(ARRAY['Tecnologia','Celulares'])",
    )
  ).rows[0].ids.at(-1);
}
test('identidade tipada normaliza unidades, exige evidência e separa modelos/armazenamento; acessórios e kits não viram telefones', () => {
  assert.equal(normalizeAttribute('1 TB', 'gb'), '1024');
  assert.equal(normalizeAttribute('128/256 GB', 'gb'), '');
  const a = validateIdentity(input, sourceData(data), policy, 'a');
  assert.ok(a.fingerprint);
  const changed = { ...data, description: 'Modelo X 256 GB, RAM física 8 GB.' };
  const b = validateIdentity(
    {
      ...input,
      facts: {
        ...input.facts,
        storage: { value: '256 GB', evidence: '256 GB' },
      },
    },
    sourceData(changed),
    policy,
    'b',
  );
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.throws(
    () =>
      validateIdentity(
        {
          ...input,
          facts: { model: { value: 'Inventado', evidence: 'Inventado' } },
        },
        sourceData(data),
        policy,
        'a',
      ),
    /evidência/,
  );
  assert.ok(deterministicIdentity(sourceData(data), policy).fingerprint);
  assert.equal(
    selectPolicy(sourceData({ title: 'Capa para iPhone' }), defaultPolicies).id,
    'accessory',
  );
  assert.equal(
    selectPolicy(sourceData({ title: 'Kit iPhone celular' }), defaultPolicies)
      .id,
    'kit',
  );
  const kit = defaultPolicies.find((p) => p.id === 'kit'),
    k = {
      policyId: 'kit',
      facts: { composition: { value: '2 cabos', evidence: '2 cabos' } },
      exclude: false,
      reason: '',
    };
  assert.notEqual(
    validateIdentity(k, sourceData({ title: 'Kit 2 cabos' }), kit, 'a')
      .fingerprint,
    validateIdentity(k, sourceData({ title: 'Kit 2 cabos' }), kit, 'b')
      .fingerprint,
  );
});
test('simulação é padrão e não cria rascunhos, produtos, categorias ou vínculos', async (t) => {
  const f = await catalogFixture(t),
    id = await seed(f),
    run = await start(f),
    first = await claim(f, run);
  assert.equal(run.mode, 'shadow');
  const done = await complete(f, run, first.item, input);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.applied, false);
  const row = (
    await f.db.query('SELECT * FROM discovery_links WHERE id=$1', [id])
  ).rows[0];
  assert.equal(row.product_draft_id, null);
  assert.deepEqual(row.catalog_resolution, {});
  assert.equal(
    (
      await f.db.query(
        'SELECT count(*)::int AS n FROM review_ai_product_drafts',
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await claim(f, run)).run.status, 'completed');
});
test('fluxo ativo cria rascunho único por identidade, conta links e categoriza sem publicar; replay não duplica', async (t) => {
  const f = await catalogFixture(t);
  await mode(f);
  const ids = [await seed(f), await seed(f)],
    run = await start(f);
  for (let i = 0; i < 2; i++) {
    const { item } = await claim(f, run),
      r = await complete(f, run, item, input);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await complete(f, run, item, input)).status, 200);
  }
  assert.equal((await claim(f, run)).run.stats.accepted, 2);
  assert.equal(
    (
      await f.db.query(
        'SELECT count(*)::int AS n FROM review_ai_product_drafts',
      )
    ).rows[0].n,
    1,
  );
  const categoryId = await category(f),
    categorize = await start(f, 'category');
  for (let i = 0; i < 2; i++) {
    const claimed = await claim(f, categorize);
    if (claimed.advance) continue;
    const { item } = claimed;
    assert.ok(item, JSON.stringify(claimed));
    // Context candidate search is deterministic and includes the configured default category.
    await f.db.query(
      "UPDATE catalog_resolver_items SET context=jsonb_set(context,'{defaultCategoryId}',to_jsonb($2::text)) WHERE id=$1",
      [item.id, categoryId],
    );
    const r = await complete(f, categorize, item, {
      categoryId,
      path: [],
      exclude: false,
      reason: '',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const rows = (
    await f.db.query(
      'SELECT product_id,published_offer_id FROM discovery_links WHERE id=ANY($1::uuid[])',
      [ids],
    )
  ).rows;
  assert.equal(new Set(rows.map((r) => r.product_id)).size, 1);
  assert.ok(rows[0].product_id);
  assert.ok(rows.every((r) => !r.published_offer_id));
  assert.equal(
    (await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,
    1,
  );
});
test('ambiguidade é exclusão explícita, não inválido/revisão, e publicação não avança; nova extração remove exclusão', async (t) => {
  const f = await catalogFixture(t);
  await mode(f);
  const id = await seed(f, {
      ...data,
      title: 'Produto sem tipo identificável',
    }),
    run = await start(f);
  const r = await claim(f, run);
  assert.equal(r.advance, true);
  let row = (
    await f.db.query('SELECT * FROM discovery_links WHERE id=$1', [id])
  ).rows[0];
  assert.equal(row.catalog_resolution.outcome, 'excluded');
  assert.deepEqual(row.ai_resolution, {});
  await f.db.query(
    "UPDATE discovery_links SET enrichment_data=jsonb_set(enrichment_data,'{title}','\"Novo título\"') WHERE id=$1",
    [id],
  );
  row = (await f.db.query('SELECT * FROM discovery_links WHERE id=$1', [id]))
    .rows[0];
  assert.deepEqual(row.catalog_resolution, {});
});
test('alteração irrelevante no catálogo não invalida; fonte/política alterada e evidência inventada são recusadas', async (t) => {
  const f = await catalogFixture(t);
  await mode(f);
  const id = await seed(f),
    run = await start(f),
    { item } = await claim(f, run);
  await category(f);
  let r = await complete(f, run, item, {
    ...input,
    facts: { brand: { value: 'Fraude', evidence: 'Fraude' } },
  });
  assert.equal(r.status, 400);
  r = await complete(f, run, item, input);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await claim(f, run);
  const second = await seed(f),
    run2 = await start(f),
    next = await claim(f, run2);
  await f.db.query(
    "UPDATE discovery_links SET enrichment_data=jsonb_set(enrichment_data,'{brand}','\"Outra\"') WHERE id=$1",
    [second],
  );
  r = await complete(f, run2, next.item, input);
  assert.equal(r.status, 409);
  assert.ok(id);
});
test('pausa/cancelamento invalidam reservas, retomada é persistente e falhas técnicas têm tentativas limitadas', async (t) => {
  const f = await catalogFixture(t);
  await mode(f);
  await seed(f);
  const run = await start(f),
    first = await claim(f, run);
  assert.equal(
    (
      await f.call('post', '/catalog/resolver/action', {
        runId: run.id,
        action: 'pause',
      })
    ).status,
    200,
  );
  assert.equal((await complete(f, run, first.item, input)).status, 409);
  await f.call('post', '/catalog/resolver/action', {
    runId: run.id,
    action: 'resume',
  });
  let next = await claim(f, run);
  const body = {
    runId: run.id,
    itemId: next.item.id,
    leaseId: next.item.leaseId,
    error: 'technical',
  };
  const r = await f.call('post', '/catalog/resolver/complete', body);
  assert.equal(r.status, 200); // second lease already reaches max_attempts
  const end = await claim(f, run);
  assert.equal(end.run.stats.failed, 1);
  assert.equal(end.run.status, 'completed');
});
test('configurações protegidas por sessão/CSRF, contratos estritos e políticas versionadas', async (t) => {
  const f = await catalogFixture(t),
    base = '/api/admin/discovery/enrichment/resolver';
  assert.equal(
    (await f.browser.agent.put(base + '/settings').send({ mode: 'active' }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.call('post', '/catalog/resolver/start', {
        marketplaceId: 'amazon',
        task: 'product',
        limit: 1,
        requestKey: randomUUID(),
        token: 'not accepted',
      })
    ).status,
    400,
  );
  const config = (await f.browser.get(base + '/settings')).body;
  const p = config.policies[0];
  let { id, version, ...definition } = p.definition;
  let r = await f.browser.mutate('put', base + '/policies/' + p.id, {
    version: p.version,
    enabled: true,
    definition,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await f.browser.mutate('put', base + '/policies/' + p.id, {
    version: p.version,
    enabled: true,
    definition,
  });
  assert.equal(r.status, 409);
});

test('preparação incremental, reutilização global, cache e candidatos incompletos nunca duplicam catálogo antigo', async (t) => {
  const f = await catalogFixture(t);
  await mode(f);
  const categoryId = await category(f),
    productId = randomUUID();
  await f.db.query(
    "INSERT INTO products(id,name,description,brand,category_path,category) VALUES($1,$2,$3,$4,ARRAY['Tecnologia','Celulares'],'Tecnologia')",
    [productId, data.title, data.description, data.brand],
  );
  let r = await f.call('post', '/catalog/resolver/prepare', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.prepared, 1);
  await seed(f);
  let run = await start(f),
    first = await claim(f, run);
  assert.equal(first.item.context.preparation, true);
  r = await complete(f, run, first.item, input, {
    model: 'fixture',
    tokens: 15,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  first = await claim(f, run);
  r = await complete(f, run, first.item, input);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.productId, productId);
  await claim(f, run);
  assert.equal(
    (await f.db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,
    1,
  );
  // A second ad uses the prepared index; a changed unrelated category does not invalidate it.
  await seed(f);
  run = await start(f);
  first = await claim(f, run);
  assert.equal(first.item.context.preparation, undefined);
  r = await complete(f, run, first.item, input);
  assert.equal(r.body.productId, productId);
  await claim(f, run);
  const all = await f.browser.get(
    '/api/admin/discovery/enrichment/resolver/runs?pageSize=5',
  );
  assert.equal(all.status, 200);
  assert.ok(all.body.items.length >= 2);
  const detail = await f.browser.get(
    '/api/admin/discovery/enrichment/resolver/runs/' + run.id,
  );
  assert.equal(detail.body.stats.accepted, 1);
  const items = await f.browser.get(
    '/api/admin/discovery/enrichment/resolver/items?runId=' +
      run.id +
      '&status=accepted&pageSize=5',
  );
  assert.equal(items.body.total, 1);
  assert.equal(
    (
      await f.browser.get(
        '/api/admin/discovery/enrichment/resolver/runs/' + randomUUID(),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.browser.mutate(
        'post',
        '/api/admin/discovery/enrichment/resolver/prepare',
        {},
      )
    ).status,
    200,
  );
  assert.ok(categoryId);
});
test('IDs e categorias fora do contexto, alterações de política e controle de execução são validados', async (t) => {
  const f = await catalogFixture(t);
  await mode(f);
  await seed(f);
  let run = await start(f),
    first = await claim(f, run);
  const wrong = await complete(
    f,
    run,
    { ...first.item, leaseId: randomUUID() },
    input,
  );
  assert.equal(wrong.status, 409);
  await f.db.query(
    "UPDATE catalog_identity_policies SET version=version+1 WHERE id='smartphone'",
  );
  assert.equal((await complete(f, run, first.item, input)).status, 409);
  const base = '/api/admin/discovery/enrichment/resolver';
  assert.equal(
    (
      await f.browser.mutate('post', base + '/runs/' + run.id + '/action', {
        action: 'cancel',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.browser.mutate(
        'post',
        base + '/runs/' + randomUUID() + '/action',
        { action: 'cancel' },
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call('post', '/catalog/resolver/claim', { runId: randomUUID() }))
      .status,
    404,
  );
  await mode(f, 'legacy');
  assert.equal(
    (
      await f.call('post', '/catalog/resolver/start', {
        marketplaceId: 'amazon',
        task: 'product',
        limit: 1,
        requestKey: randomUUID(),
      })
    ).status,
    409,
  );
});
