import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import type { CatalogActor } from './catalog-contracts.js';
import { catalogTransaction } from './catalog-runs.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
import {
  assignCatalogProduct,
  resolveAiCategory,
} from './review-ai-catalog.js';
import {
  canonical,
  sourceData,
  sourceHash,
  digest,
  selectPolicy,
  deterministicIdentity,
  validateIdentity,
  type IdentityPolicy,
} from './catalog-identity.js';
type Query = Pick<Database, 'query'>;
export function resolverAllowed(actor: CatalogActor) {
  if (
    !actor.permissions.includes('catalog') ||
    !actor.permissions.includes('affiliate_links')
  )
    throw new HttpError(403, 'Permissões de catálogo e links necessárias.');
}
export async function resolverSettings(c: Query) {
  return (
    await c.query('SELECT * FROM catalog_resolver_settings WHERE id=true')
  ).rows[0];
}
export async function resolverPolicies(c: Query): Promise<IdentityPolicy[]> {
  return (
    await c.query(
      'SELECT * FROM catalog_identity_policies WHERE enabled ORDER BY id',
    )
  ).rows.map((p) => ({ ...p.definition, id: p.id, version: p.version }));
}
export async function prepareIdentities(
  c: Query,
  cursor: string | null = null,
) {
  const policies = await resolverPolicies(c),
    rows = (
      await c.query(
        'SELECT p.* FROM products p LEFT JOIN catalog_product_identities i ON i.product_id=p.id LEFT JOIN catalog_identity_policies pol ON pol.id=i.policy_id WHERE ($1::uuid IS NULL OR p.id>$1) AND (i.product_id IS NULL OR i.prepared_at<p.updated_at OR i.policy_version<>pol.version) ORDER BY p.id LIMIT 100',
        [cursor],
      )
    ).rows;
  let prepared = 0;
  for (const p of rows) {
    const data = sourceData(p),
      hash = sourceHash(p),
      policy = selectPolicy(data, policies);
    if (!policy) continue;
    const identity = deterministicIdentity(data, policy);
    await c.query(
      `INSERT INTO catalog_product_identities(product_id,policy_id,policy_version,fingerprint,identity,source_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product_id) DO UPDATE SET policy_id=$2,policy_version=$3,fingerprint=$4,identity=$5,source_hash=$6,prepared_at=clock_timestamp() WHERE catalog_product_identities.source_hash<>$6 OR catalog_product_identities.policy_version<>$3`,
      [
        p.id,
        policy.id,
        policy.version,
        identity.fingerprint,
        JSON.stringify({
          ...identity,
          preparation: identity.fingerprint ? 'completed' : 'pending',
        }),
        hash,
      ],
    );
    prepared++;
  }
  return {
    prepared,
    scanned: rows.length,
    nextCursor: rows.length === 100 ? rows.at(-1).id : null,
  };
}
export const startInput = z.strictObject({
  marketplaceId: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
  task: z.enum(['product', 'category']),
  limit: z.number().int().min(1).max(10000),
  requestKey: z.uuid(),
});
export async function startResolver(
  db: Database,
  actor: CatalogActor,
  input: unknown,
) {
  resolverAllowed(actor);
  const v = startInput.parse(input);
  return catalogTransaction(db, async (c) => {
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [actor.id]);
    const old = (
      await c.query(
        'SELECT * FROM catalog_resolver_runs WHERE created_by=$1 AND request_key=$2',
        [actor.id, v.requestKey],
      )
    ).rows[0];
    if (old) return old;
    const settings = await resolverSettings(c);
    if (settings.mode === 'legacy')
      throw new HttpError(409, 'Resolvedor estruturado desativado.');
    const existing = (
      await c.query(
        "SELECT * FROM catalog_resolver_runs WHERE created_by=$1 AND marketplace_id=$2 AND task=$3 AND status IN ('running','paused') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [actor.id, v.marketplaceId, v.task],
      )
    ).rows[0];
    if (existing) return existing;
    const run = (
      await c.query(
        'INSERT INTO catalog_resolver_runs(id,request_key,created_by,extension_session_id,marketplace_id,task,mode,settings_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [
          randomUUID(),
          v.requestKey,
          actor.id,
          actor.extension_session_id,
          v.marketplaceId,
          v.task,
          settings.mode,
          settings.version,
        ],
      )
    ).rows[0];
    await c.query(
      `INSERT INTO catalog_resolver_items(id,run_id,link_id) SELECT gen_random_uuid(),$1,l.id FROM discovery_links l WHERE l.marketplace_id=$2 AND l.status='pending' AND l.published_offer_id IS NULL AND l.extraction_status='completed' AND (($3='product' AND l.product_id IS NULL AND l.product_draft_id IS NULL) OR ($3='category' AND l.product_draft_id IS NOT NULL AND l.product_id IS NULL)) ORDER BY l.first_seen_at,l.id LIMIT $4`,
      [run.id, v.marketplaceId, v.task, v.limit],
    );
    if (v.task === 'product')
      await c.query(
        `INSERT INTO catalog_resolver_items(id,run_id,product_id) SELECT gen_random_uuid(),$1,p.id FROM catalog_product_identities i JOIN products p ON p.id=i.product_id JOIN catalog_identity_policies pol ON pol.id=i.policy_id WHERE i.fingerprint IS NULL AND coalesce(i.identity->>'preparation','')<>'completed' AND pol.enabled ORDER BY p.id`,
        [run.id],
      );
    await audit(c, actor.id, 'catalog_resolver.started', run.id);
    return run;
  });
}
export async function ownedRun(
  c: Query,
  actor: CatalogActor,
  id: string,
  lock = false,
) {
  resolverAllowed(actor);
  const run = (
    await c.query(
      'SELECT * FROM catalog_resolver_runs WHERE id=$1 AND created_by=$2' +
        (lock ? ' FOR UPDATE' : ''),
      [id, actor.id],
    )
  ).rows[0];
  if (!run) throw new HttpError(404, 'Execução não encontrada.');
  return run;
}
export async function runSummary(c: Query, run: any) {
  const stats = (
    await c.query(
      `SELECT count(*) FILTER(WHERE link_id IS NOT NULL)::int AS total,count(*) FILTER(WHERE product_id IS NOT NULL AND status IN ('accepted','excluded'))::int AS prepared,count(*) FILTER(WHERE status='accepted' AND link_id IS NOT NULL)::int AS accepted,count(*) FILTER(WHERE status='excluded' AND link_id IS NOT NULL)::int AS excluded,count(*) FILTER(WHERE status='failed' AND link_id IS NOT NULL)::int AS failed,sum(calls)::int AS calls,sum(tokens)::int AS tokens,sum(elapsed_ms)::int AS elapsed_ms,count(evaluation)::int AS evaluated,count(*) FILTER(WHERE evaluation='false_merge')::int AS false_merges,count(*) FILTER(WHERE evaluation='duplicate')::int AS duplicates,count(*) FILTER(WHERE evaluation='wrong_category')::int AS wrong_categories,count(*) FILTER(WHERE evaluation='excluded_valid')::int AS excluded_valid FROM catalog_resolver_items WHERE run_id=$1`,
      [run.id],
    )
  ).rows[0];
  return { ...run, stats };
}
export async function resolverAction(
  db: Database,
  actor: CatalogActor,
  id: string,
  action: 'pause' | 'resume' | 'cancel',
) {
  return catalogTransaction(db, async (c) => {
    const run = await ownedRun(c, actor, id, true);
    if (['cancelled', 'completed'].includes(run.status)) return run;
    const status = { pause: 'paused', resume: 'running', cancel: 'cancelled' }[
      action
    ];
    await c.query(
      'UPDATE catalog_resolver_runs SET status=$2,updated_at=clock_timestamp() WHERE id=$1',
      [id, status],
    );
    if (action !== 'resume')
      await c.query(
        "UPDATE catalog_resolver_items SET status='queued',lease_id=NULL,lease_until=NULL WHERE run_id=$1 AND status='leased'",
        [id],
      );
    await audit(c, actor.id, 'catalog_resolver.' + action, id);
    return { ...run, status };
  });
}
async function finishItem(c: Query, item: any, status: string, decision: any) {
  await c.query(
    'UPDATE catalog_resolver_items SET status=$2,decision=$3,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1',
    [item.id, status, JSON.stringify(decision)],
  );
}
async function excluded(
  c: Query,
  run: any,
  item: any,
  link: any,
  reason: string,
) {
  const result = {
    outcome: 'excluded',
    reason,
    applied: run.mode === 'active',
  };
  if (run.mode === 'active')
    await c.query(
      'UPDATE discovery_links SET catalog_resolution=$2 WHERE id=$1',
      [link.id, JSON.stringify({ ...result, sourceHash: sourceHash(link) })],
    );
  await finishItem(c, item, 'excluded', result);
  return result;
}
async function contextFor(c: Query, run: any, link: any) {
  const settings = (
      await c.query('SELECT * FROM review_ai_settings WHERE id=true')
    ).rows[0],
    policies = await resolverPolicies(c);
  if (run.task === 'category') {
    const draft = (
      await c.query(
        'SELECT d.*,i.identity,i.policy_id,i.policy_version FROM review_ai_product_drafts d LEFT JOIN catalog_resolver_drafts i ON i.draft_id=d.id WHERE d.id=$1',
        [link.product_draft_id],
      )
    ).rows[0];
    if (!draft) return { skip: true };
    if (draft.product_id) return { skip: true, productId: draft.product_id };
    const policy = policies.find((p) => p.id === draft.policy_id),
      terms = canonical(sourceData(draft).title)
        .split(' ')
        .filter((s) => s.length > 2)
        .slice(0, 12)
        .join(' | ');
    const categories = (
      await c.query(
        "SELECT id,path FROM category_nodes WHERE to_tsvector('simple',coalesce(path[array_length(path,1)],'')) @@ to_tsquery('simple',$1) ORDER BY cardinality(path) DESC,id LIMIT 25",
        [terms.replace(/[^\p{L}\p{N} |]/gu, '') || 'categoria'],
      )
    ).rows;
    const mapping = (
      await c.query(
        'SELECT n.id,n.path FROM category_mappings m JOIN category_nodes n ON n.id=m.category_id WHERE m.marketplace_id=$1 AND m.source_key=$2',
        [link.marketplace_id, link.source_category_key],
      )
    ).rows[0];
    if (policy?.categoryId) {
      const preset = (
        await c.query('SELECT id,path FROM category_nodes WHERE id=$1', [
          policy.categoryId,
        ])
      ).rows[0];
      if (preset && !categories.some((x) => x.id === preset.id))
        categories.push(preset);
    }
    if (mapping && !categories.some((x) => x.id === mapping.id))
      categories.push(mapping);
    return {
      stage: 'category',
      offer: {
        ...sourceData(draft),
        sourceCategory: (link.source_category_path ?? []).join(' > '),
      },
      categories,
      policy,
      defaultCategoryId: policy?.categoryId ?? null,
      draftId: draft.id,
      draftVersion: draft.version,
      prompt: settings.category_prompt,
      promptVersion: settings.category_version,
      enabled: settings.category_enabled,
    };
  }
  const offer = sourceData(link),
    policy = selectPolicy(offer, policies);
  return {
    stage: 'identity',
    offer,
    policy,
    prompt: settings.product_prompt,
    promptVersion: settings.product_version,
    enabled: settings.product_enabled,
  };
}
export async function claimResolver(
  db: Database,
  actor: CatalogActor,
  id: string,
) {
  return catalogTransaction(db, async (c) => {
    const run = await ownedRun(c, actor, id, true);
    if (run.status !== 'running')
      return { run: await runSummary(c, run), item: null };
    const settings = await resolverSettings(c);
    if (run.settings_version !== settings.version || run.mode !== settings.mode)
      throw new HttpError(
        409,
        'Configuração alterada; cancele esta execução e inicie outra.',
      );
    await c.query(
      "UPDATE catalog_resolver_items SET status=CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,lease_id=NULL WHERE run_id=$1 AND status='leased' AND lease_until<clock_timestamp()",
      [id, settings.max_attempts],
    );
    const item = (
      await c.query(
        "SELECT i.* FROM catalog_resolver_items i WHERE i.run_id=$1 AND i.status='queued' AND (i.retry_at IS NULL OR i.retry_at<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM catalog_resolver_items other WHERE other.link_id=i.link_id AND other.id<>i.id AND other.status='leased' AND other.lease_until>clock_timestamp()) ORDER BY (i.product_id IS NOT NULL) DESC,i.id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [id],
      )
    ).rows[0];
    if (!item) return emptyClaim(c, run);
    if (item.product_id) return claimPreparation(c, run, item);
    return claimLink(c, run, item, actor.id);
  });
}
async function emptyClaim(c: Query, run: any) {
  const pending = (
    await c.query(
      "SELECT count(*)::int AS n FROM catalog_resolver_items WHERE run_id=$1 AND status IN ('queued','leased')",
      [run.id],
    )
  ).rows[0].n;
  if (!pending) {
    run.status = 'completed';
    await c.query(
      "UPDATE catalog_resolver_runs SET status='completed',updated_at=clock_timestamp() WHERE id=$1",
      [run.id],
    );
  }
  return { run: await runSummary(c, run), item: null };
}
async function claimLink(c: Query, run: any, item: any, userId: string) {
  const link = (
    await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE', [
      item.link_id,
    ])
  ).rows[0];
  if (!link || link.status !== 'pending' || link.published_offer_id) {
    await finishItem(c, item, 'excluded', {
      outcome: 'excluded',
      reason: 'Item deixou a revisão.',
    });
    return { run: await runSummary(c, run), advance: true };
  }
  if (await otherLinkLease(c, link.id, item.id))
    return { run: await runSummary(c, run), item: null };
  if (run.task === 'product' && (link.product_id || link.product_draft_id)) {
    await finishItem(c, item, 'accepted', {
      outcome: 'reused',
      reason: 'Vínculo já confirmado.',
    });
    return { run: await runSummary(c, run), advance: true };
  }
  const context = await contextFor(c, run, link);
  if (context.skip) return reuseDraft(c, run, item, link, context, userId);
  if (context.stage === 'identity' && !context.policy) {
    await excluded(
      c,
      run,
      item,
      link,
      'Tipo ausente ou ambíguo nas políticas cadastradas.',
    );
    return { run: await runSummary(c, run), advance: true };
  }
  return leaseLink(c, run, item, link, context);
}
async function otherLinkLease(c: Query, linkId: string, itemId: string) {
  await c.query(
    "UPDATE catalog_resolver_items SET status='queued',lease_id=NULL,lease_until=NULL WHERE link_id=$1 AND status='leased' AND lease_until<clock_timestamp()",
    [linkId],
  );
  return (
    (
      await c.query(
        "SELECT id FROM catalog_resolver_items WHERE link_id=$1 AND id<>$2 AND status='leased'",
        [linkId, itemId],
      )
    ).rows.length > 0
  );
}
async function reuseDraft(
  c: Query,
  run: any,
  item: any,
  link: any,
  context: any,
  userId: string,
) {
  if (context.productId && run.mode === 'active') {
    const product = (
      await c.query('SELECT * FROM products WHERE id=$1', [context.productId])
    ).rows[0];
    if (product) await assignCatalogProduct(c, link.id, product, userId);
  }
  await finishItem(c, item, 'accepted', { outcome: 'reused' });
  return { run: await runSummary(c, run), advance: true };
}
async function leaseLink(
  c: Query,
  run: any,
  item: any,
  link: any,
  context: any,
) {
  const lease = randomUUID();
  await c.query(
    "UPDATE catalog_resolver_items SET status='leased',attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '5 minutes',source_hash=$3,context=$4 WHERE id=$1",
    [item.id, lease, sourceHash(link), JSON.stringify(context)],
  );
  const receipt = (
    await c.query(
      'SELECT * FROM catalog_resolver_receipts WHERE link_id=$1 AND task=$2',
      [link.id, run.task],
    )
  ).rows[0];
  const cached =
    receipt?.source_hash === sourceHash(link) &&
    receipt?.policy_version === context.policy?.version &&
    receipt?.result?.promptVersion === context.promptVersion
      ? receipt?.result.identity
      : null;
  const identity =
    context.policy && context.stage === 'identity'
      ? (cached ?? deterministicIdentity(context.offer, context.policy))
      : null;
  return {
    run: await runSummary(c, run),
    item: {
      id: item.id,
      leaseId: lease,
      context,
      deterministic: identity?.fingerprint
        ? {
            policyId: context.policy.id,
            facts: identity.facts,
            exclude: false,
            reason: '',
          }
        : null,
    },
  };
}

async function candidateProducts(
  c: Query,
  identity: any,
  policy: IdentityPolicy,
) {
  // Exact prepared identities are indexed. Legacy candidates are bounded by brand/model tokens globally, never category.
  const exact = (
    await c.query(
      'SELECT p.*,i.identity,i.source_hash,i.policy_version FROM catalog_product_identities i JOIN products p ON p.id=i.product_id WHERE i.fingerprint=$1 ORDER BY p.id LIMIT 3',
      [identity.fingerprint],
    )
  ).rows;
  const valid = exact.filter(
    (p) =>
      p.source_hash === sourceHash(p) && p.policy_version === policy.version,
  );
  if (valid.length) return { exact: valid, unknown: [] };
  const terms = [identity.attrs.brand, identity.attrs.model]
    .filter(Boolean)
    .join(' ');
  if (!terms) return { exact: [], unknown: [] };
  const unknown = (
    await c.query(
      "SELECT p.*,i.identity,i.source_hash FROM products p LEFT JOIN catalog_product_identities i ON i.product_id=p.id WHERE NOT p.personalized_kit AND to_tsvector('simple',coalesce(p.name,'')||' '||coalesce(p.brand,'')||' '||coalesce(p.model,'')) @@ plainto_tsquery('simple',$1) ORDER BY p.id LIMIT 21",
      [terms],
    )
  ).rows;
  return {
    exact: [],
    unknown: unknown.filter(
      (p) =>
        !p.identity?.fingerprint ||
        p.source_hash !== sourceHash(p) ||
        Object.entries(identity.attrs).every(
          ([key, value]) =>
            !p.identity.attrs[key] || p.identity.attrs[key] === value,
        ),
    ),
  };
}
async function acceptProduct(
  c: Query,
  run: any,
  item: any,
  link: any,
  context: any,
  raw: any,
) {
  const identity = validateIdentity(
    raw,
    context.offer,
    context.policy,
    link.id,
  );
  if (identity.exclude || !identity.fingerprint)
    return excluded(
      c,
      run,
      item,
      link,
      identity.reason ||
        'Identidade incompleta: ' + identity.missing.join(', '),
    );
  const policy = context.policy as IdentityPolicy,
    candidates = policy.exclusive
      ? { exact: [], unknown: [] }
      : await candidateProducts(c, identity, policy);
  if (candidates.exact.length > 1 || candidates.unknown.length)
    return excluded(
      c,
      run,
      item,
      link,
      'Candidatos existentes precisam de identidade completa; criação automática bloqueada para evitar duplicação.',
    );
  const known = candidates.exact[0];
  if (run.mode === 'shadow')
    return {
      outcome: known ? 'linked' : 'drafted',
      applied: false,
      identity,
      productId: known?.id ?? null,
    };
  if (known) {
    await assignCatalogProduct(c, link.id, known, run.created_by);
    return { outcome: 'linked', applied: true, productId: known.id, identity };
  }
  const title = [
      policy.name,
      ...policy.attributes
        .filter((a) => a.required)
        .map((a) => identity.facts[a.key]?.value)
        .filter(Boolean),
    ]
      .join(' ')
      .slice(0, 300),
    description = policy.attributes
      .filter((a) => identity.facts[a.key])
      .map((a) => a.label + ': ' + identity.facts[a.key].value)
      .join('. ')
      .slice(0, 4000),
    brand = String(
      identity.facts.brand?.value ?? link.enrichment_data.brand ?? '',
    ).slice(0, 120),
    image =
      (link.enrichment_data.images ?? []).find((x: string) =>
        x.startsWith('https://'),
      ) ?? null;
  const draft = (
    await c.query(
      `INSERT INTO review_ai_product_drafts(id,identity_key,name,description,brand,image_url,created_by,personalized_kit) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(identity_key) DO UPDATE SET identity_key=EXCLUDED.identity_key RETURNING *`,
      [
        randomUUID(),
        'structured:' + identity.fingerprint,
        title,
        description,
        brand,
        image,
        run.created_by,
        policy.exclusive,
      ],
    )
  ).rows[0];
  await c.query(
    'INSERT INTO catalog_resolver_drafts(draft_id,fingerprint,identity,policy_id,policy_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(draft_id) DO NOTHING',
    [
      draft.id,
      identity.fingerprint,
      JSON.stringify(identity),
      policy.id,
      policy.version,
    ],
  );
  if (draft.product_id) {
    const p = (
      await c.query('SELECT * FROM products WHERE id=$1', [draft.product_id])
    ).rows[0];
    await assignCatalogProduct(c, link.id, p, run.created_by);
    return { outcome: 'linked', applied: true, productId: p.id, identity };
  }
  await c.query(
    'UPDATE discovery_links SET product_draft_id=$2,enrichment_version=enrichment_version+1 WHERE id=$1',
    [link.id, draft.id],
  );
  return { outcome: 'drafted', applied: true, draftId: draft.id, identity };
}
const categoryResult = z.strictObject({
  categoryId: z.uuid().nullable(),
  path: z.array(z.string().trim().min(1).max(80)).max(10),
  exclude: z.boolean(),
  reason: z.string().max(240),
});
async function acceptCategory(
  c: Query,
  run: any,
  item: any,
  link: any,
  context: any,
  raw: any,
) {
  const value = categoryResult.parse(raw);
  if (value.exclude)
    return excluded(
      c,
      run,
      item,
      link,
      value.reason || 'Categoria sem evidência suficiente.',
    );
  if (
    value.categoryId &&
    !context.categories.some((x: any) => x.id === value.categoryId) &&
    context.defaultCategoryId !== value.categoryId
  )
    throw new HttpError(400, 'Categoria fora dos candidatos.');
  if (value.categoryId) {
    const current = (
        await c.query('SELECT path FROM category_nodes WHERE id=$1 FOR SHARE', [
          value.categoryId,
        ])
      ).rows[0],
      snapshot = context.categories.find((x: any) => x.id === value.categoryId);
    if (!current || !snapshot || digest(current.path) !== digest(snapshot.path))
      throw new HttpError(409, 'Categoria alterada durante a análise.');
  }
  if (!value.categoryId && !value.path.length)
    throw new HttpError(400, 'Categoria vazia.');
  if (run.mode === 'shadow')
    return { outcome: 'categorized', applied: false, ...value };
  const draft = (
    await c.query(
      'SELECT * FROM review_ai_product_drafts WHERE id=$1 FOR UPDATE',
      [context.draftId],
    )
  ).rows[0];
  if (!draft) throw new HttpError(409, 'Rascunho removido.');
  let product = draft.product_id
    ? (await c.query('SELECT * FROM products WHERE id=$1', [draft.product_id]))
        .rows[0]
    : null;
  if (!product) {
    if (draft.version !== context.draftVersion)
      throw new HttpError(409, 'Rascunho alterado.');
    const category = await resolveAiCategory(c, {
      action: value.categoryId ? 'use_category' : 'create_category',
      categoryId: value.categoryId,
      category: value.path.join(' > '),
    });
    product = (
      await c.query(
        'INSERT INTO products(id,name,description,brand,image_url,category_path,personalized_kit,category,subcategory) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          randomUUID(),
          draft.name,
          draft.description,
          draft.brand,
          draft.image_url,
          category.path,
          draft.personalized_kit,
          category.path[0],
          category.path[1] ?? '',
        ],
      )
    ).rows[0];
    const identity = (
      await c.query('SELECT * FROM catalog_resolver_drafts WHERE draft_id=$1', [
        draft.id,
      ])
    ).rows[0];
    if (identity)
      await c.query(
        'INSERT INTO catalog_product_identities(product_id,policy_id,policy_version,fingerprint,identity,source_hash) VALUES($1,$2,$3,$4,$5,$6)',
        [
          product.id,
          identity.policy_id,
          identity.policy_version,
          identity.fingerprint,
          JSON.stringify(identity.identity),
          sourceHash(product),
        ],
      );
    await c.query(
      'UPDATE review_ai_product_drafts SET product_id=$2,version=version+1 WHERE id=$1',
      [draft.id, product.id],
    );
  }
  await assignCatalogProduct(c, link.id, product, run.created_by);
  return { outcome: 'categorized', applied: true, productId: product.id };
}
export const completeInput = z.strictObject({
  runId: z.uuid(),
  itemId: z.uuid(),
  leaseId: z.uuid(),
  decision: z.unknown().optional(),
  error: z.enum(['technical', 'cancelled']).optional(),
  model: z.string().max(200).default(''),
  tokens: z.number().int().min(0).max(1000000).default(0),
  elapsedMs: z.number().int().min(0).max(300000).default(0),
});
export async function completeResolver(
  db: Database,
  actor: CatalogActor,
  input: unknown,
) {
  const v = completeInput.parse(input);
  return catalogTransaction(db, async (c) => {
    const run = await ownedRun(c, actor, v.runId, true),
      item = (
        await c.query(
          'SELECT * FROM catalog_resolver_items WHERE id=$1 AND run_id=$2 FOR UPDATE',
          [v.itemId, run.id],
        )
      ).rows[0],
      hash = digest(v);
    if (!item || item.lease_id !== v.leaseId)
      throw new HttpError(409, 'Reserva inválida.');
    if (item.result_hash === hash) return item.decision;
    if (
      item.status !== 'leased' ||
      run.status !== 'running' ||
      new Date(item.lease_until).getTime() < Date.now()
    )
      throw new HttpError(409, 'Reserva expirada ou execução interrompida.');
    const settings = await resolverSettings(c);
    if (item.product_id)
      return completePreparation(c, run, item, v, hash, settings);
    const link = (
      await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE', [
        item.link_id,
      ])
    ).rows[0];
    if (settings.version !== run.settings_version || settings.mode !== run.mode)
      throw new HttpError(409, 'Configuração alterada. Inicie nova execução.');
    if (v.error) return technicalRetry(c, item, v, settings);
    validateLinkSnapshot(run, item, link, settings);
    const context = item.context;
    await validateContext(c, run, context);
    const result =
      run.task === 'product'
        ? await acceptProduct(c, run, item, link, context, v.decision)
        : await acceptCategory(c, run, item, link, context, v.decision);
    if (result.outcome !== 'excluded')
      await finishItem(c, item, 'accepted', result);
    if (run.mode === 'active' && result.outcome !== 'excluded')
      await c.query(
        "UPDATE discovery_links SET catalog_resolution='{}',ai_resolution='{}' WHERE id=$1",
        [link.id],
      );
    await c.query(
      'UPDATE catalog_resolver_items SET result_hash=$2,calls=calls+$3,tokens=tokens+$4,elapsed_ms=elapsed_ms+$5 WHERE id=$1',
      [item.id, hash, v.model ? 1 : 0, v.tokens, v.elapsedMs],
    );
    await c.query(
      'INSERT INTO catalog_resolver_receipts(link_id,task,source_hash,policy_version,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT(link_id,task) DO UPDATE SET source_hash=$3,policy_version=$4,result=$5,created_at=clock_timestamp()',
      [
        link.id,
        run.task,
        item.source_hash,
        context.policy?.version ?? 0,
        JSON.stringify({
          ...result,
          mode: run.mode,
          promptVersion: context.promptVersion,
        }),
      ],
    );
    await audit(c, actor.id, 'catalog_resolver.' + result.outcome, link.id);
    return result;
  });
}

async function claimPreparation(c: Query, run: any, item: any) {
  const product = (
      await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [
        item.product_id,
      ])
    ).rows[0],
    policies = await resolverPolicies(c),
    data = sourceData(product),
    policy = selectPolicy(data, policies);
  await c.query(
    "UPDATE catalog_resolver_items SET status='queued',lease_id=NULL,lease_until=NULL WHERE product_id=$1 AND status='leased' AND lease_until<clock_timestamp()",
    [item.product_id],
  );
  if (
    (
      await c.query(
        "SELECT id FROM catalog_resolver_items WHERE product_id=$1 AND id<>$2 AND status='leased'",
        [item.product_id, item.id],
      )
    ).rows.length
  )
    return { run: await runSummary(c, run), item: null };
  if (!policy) {
    await finishItem(c, item, 'excluded', {
      outcome: 'excluded',
      reason: 'Tipo do produto existente sem política.',
    });
    return { run: await runSummary(c, run), advance: true };
  }
  const settings = (
      await c.query('SELECT * FROM review_ai_settings WHERE id=true')
    ).rows[0],
    context = {
      stage: 'identity',
      offer: data,
      policy,
      prompt: settings.product_prompt,
      promptVersion: settings.product_version,
      enabled: settings.product_enabled,
      preparation: true,
    };
  const lease = randomUUID();
  await c.query(
    "UPDATE catalog_resolver_items SET status='leased',attempts=attempts+1,lease_id=$2,lease_until=clock_timestamp()+interval '5 minutes',source_hash=$3,context=$4 WHERE id=$1",
    [item.id, lease, sourceHash(product), JSON.stringify(context)],
  );
  return {
    run: await runSummary(c, run),
    item: { id: item.id, leaseId: lease, context, deterministic: null },
  };
}
async function completePreparation(
  c: Query,
  run: any,
  item: any,
  v: any,
  hash: string,
  settings: any,
) {
  const product = (
      await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE', [
        item.product_id,
      ])
    ).rows[0],
    policy = (
      await c.query(
        'SELECT version FROM catalog_identity_policies WHERE id=$1 AND enabled',
        [item.context.policy.id],
      )
    ).rows[0],
    prompt = (
      await c.query(
        'SELECT product_version FROM review_ai_settings WHERE id=true',
      )
    ).rows[0];
  if (
    !product ||
    sourceHash(product) !== item.source_hash ||
    policy?.version !== item.context.policy.version ||
    prompt.product_version !== item.context.promptVersion ||
    settings.version !== run.settings_version
  )
    throw new HttpError(
      409,
      'Produto ou política alterada durante a preparação.',
    );
  if (v.error) {
    await c.query(
      "UPDATE catalog_resolver_items SET status=$2,lease_id=NULL,lease_until=NULL,retry_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
      [item.id, item.attempts >= settings.max_attempts ? 'failed' : 'queued'],
    );
    return { outcome: 'retry' };
  }
  const identity = validateIdentity(
      v.decision,
      item.context.offer,
      item.context.policy,
      product.id,
    ),
    result = {
      outcome: identity.fingerprint ? 'prepared' : 'excluded',
      reason: identity.reason || identity.missing.join(', '),
      applied: false,
    };
  await c.query(
    'UPDATE catalog_product_identities SET fingerprint=$2,identity=$3,source_hash=$4,policy_version=$5,prepared_at=clock_timestamp() WHERE product_id=$1',
    [
      product.id,
      identity.fingerprint,
      JSON.stringify({ ...identity, preparation: 'completed' }),
      item.source_hash,
      policy.version,
    ],
  );
  await finishItem(
    c,
    item,
    identity.fingerprint ? 'accepted' : 'excluded',
    result,
  );
  await c.query(
    'UPDATE catalog_resolver_items SET result_hash=$2,calls=calls+$3,tokens=tokens+$4,elapsed_ms=elapsed_ms+$5 WHERE id=$1',
    [item.id, hash, v.model ? 1 : 0, v.tokens, v.elapsedMs],
  );
  return result;
}

async function technicalRetry(c: Query, item: any, v: any, settings: any) {
  await c.query(
    'UPDATE catalog_resolver_items SET calls=calls+$2,tokens=tokens+$3,elapsed_ms=elapsed_ms+$4 WHERE id=$1',
    [item.id, v.model ? 1 : 0, v.tokens, v.elapsedMs],
  );
  const failed = item.attempts >= settings.max_attempts;
  await c.query(
    "UPDATE catalog_resolver_items SET status=$2,lease_id=NULL,lease_until=NULL,retry_at=clock_timestamp()+interval '2 seconds',decision=$3 WHERE id=$1",
    [
      item.id,
      failed ? 'failed' : 'queued',
      JSON.stringify({
        outcome: 'technical_retry',
        reason: 'Falha técnica; repetição automática limitada.',
      }),
    ],
  );
  return { outcome: failed ? 'failed' : 'retry' };
}

async function validateContext(c: Query, run: any, context: any) {
  const current = (
    await c.query('SELECT * FROM review_ai_settings WHERE id=true')
  ).rows[0];
  if (
    context.promptVersion !==
    current[run.task === 'product' ? 'product_version' : 'category_version']
  )
    throw new HttpError(409, 'Instrução alterada. Inicie nova execução.');
  if (context.policy) {
    const p = (
      await c.query(
        'SELECT version FROM catalog_identity_policies WHERE id=$1 AND enabled',
        [context.policy.id],
      )
    ).rows[0];
    if (p?.version !== context.policy.version)
      throw new HttpError(409, 'Política alterada.');
  }
}

function validateLinkSnapshot(run: any, item: any, link: any, settings: any) {
  if (
    !link ||
    link.status !== 'pending' ||
    link.published_offer_id ||
    sourceHash(link) !== item.source_hash ||
    settings.version !== run.settings_version ||
    settings.mode !== run.mode
  )
    throw new HttpError(
      409,
      'Fonte ou configuração alterada. Inicie nova execução.',
    );
  if (run.task === 'product' && (link.product_id || link.product_draft_id))
    throw new HttpError(409, 'Vínculo alterado durante a análise.');
}
