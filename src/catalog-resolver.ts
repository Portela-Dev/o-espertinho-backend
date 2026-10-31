import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import type { CatalogActor } from './catalog-contracts.js';
import { catalogTransaction } from './catalog-runs.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
import { catalogIdentity, catalogOffer, inferCatalogPolicy, policyChoices, titleProvesIdentity } from './catalog-type.js';
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
export async function resolverSettings(c: Query, lock = false) {
  const row = (
    await c.query(
      'SELECT * FROM catalog_resolver_settings WHERE id=true' +
        (lock ? ' FOR SHARE' : ''),
    )
  ).rows[0];
  return { ...row, protocolVersion: 2 };
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
        `SELECT p.*,q.version AS pending_version,i.source_hash AS prior_hash,i.policy_id AS prior_policy,i.policy_version AS prior_version FROM catalog_identity_pending q JOIN products p ON p.id=q.product_id LEFT JOIN catalog_product_identities i ON i.product_id=p.id WHERE ($1::uuid IS NULL OR p.id>$1) ORDER BY p.id LIMIT 100`,
        [cursor],
      )
    ).rows;
  for (const product of rows) await prepareIdentity(c, product, policies);
  return {
    prepared: rows.length,
    scanned: rows.length,
    nextCursor: rows.length === 100 ? rows.at(-1).id : null,
  };
}
async function prepareIdentity(
  c: Query,
  product: any,
  policies: IdentityPolicy[],
) {
  const data = sourceData(product),
    hash = sourceHash(product),
    policy = policies.find(p => p.id === product.prior_policy && p.version === product.prior_version && product.prior_hash === hash) ?? selectPolicy(data, policies);
  if (
    product.prior_hash === hash &&
    product.prior_policy === (policy?.id ?? null) &&
    product.prior_version === (policy?.version ?? 0)
  ) {
    await c.query(
      'UPDATE catalog_product_identities SET prepared_at=clock_timestamp() WHERE product_id=$1',
      [product.id],
    );
  } else {
    const identity = policy
      ? deterministicIdentity(data, policy)
      : { fingerprint: null, missing: ['type'] };
    const preparation =
      policy && !identity.fingerprint ? 'pending' : 'completed';
    await c.query(
      `INSERT INTO catalog_product_identities(product_id,policy_id,policy_version,fingerprint,identity,source_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product_id) DO UPDATE SET policy_id=$2,policy_version=$3,fingerprint=$4,identity=$5,source_hash=$6,prepared_at=clock_timestamp()`,
      [
        product.id,
        policy?.id ?? null,
        policy?.version ?? 0,
        identity.fingerprint,
        JSON.stringify({ ...identity, preparation }),
        hash,
      ],
    );
  }
  // A concurrent edit increments the queue version and must remain pending.
  await c.query(
    'DELETE FROM catalog_identity_pending WHERE product_id=$1 AND version=$2',
    [product.id, product.pending_version],
  );
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
      `INSERT INTO catalog_resolver_items(id,run_id,link_id) SELECT gen_random_uuid(),$1,l.id FROM discovery_links l WHERE l.marketplace_id=$2 AND l.status='pending' AND l.published_offer_id IS NULL AND l.extraction_status='completed' AND (($3='product' AND l.product_id IS NULL AND l.product_draft_id IS NULL) OR ($3='category' AND l.product_id IS NULL AND (l.product_draft_id IS NOT NULL OR ($5='shadow' AND EXISTS(SELECT 1 FROM catalog_resolver_receipts receipt WHERE receipt.link_id=l.id AND receipt.task='product' AND receipt.result->>'mode'='shadow' AND receipt.result->>'outcome'='drafted'))))) ORDER BY l.first_seen_at,l.id LIMIT $4`,
      [run.id, v.marketplaceId, v.task, v.limit, run.mode],
    );
    // Existing products are prepared only when an actual link finds them as
    // candidates. A marketplace run must never first analyze the whole catalog.
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
      `SELECT count(*) FILTER(WHERE link_id IS NOT NULL)::int AS total,count(*) FILTER(WHERE product_id IS NOT NULL AND status IN ('accepted','excluded'))::int AS prepared,count(*) FILTER(WHERE status='accepted' AND link_id IS NOT NULL)::int AS accepted,count(*) FILTER(WHERE status='excluded' AND link_id IS NOT NULL)::int AS excluded,count(*) FILTER(WHERE status='skipped' AND link_id IS NOT NULL)::int AS skipped,count(*) FILTER(WHERE status='failed' AND link_id IS NOT NULL)::int AS failed,sum(calls)::int AS calls,sum(tokens)::int AS tokens,sum(elapsed_ms)::int AS elapsed_ms,count(evaluation)::int AS evaluated,count(*) FILTER(WHERE evaluation='false_merge')::int AS false_merges,count(*) FILTER(WHERE evaluation='duplicate')::int AS duplicates,count(*) FILTER(WHERE evaluation='wrong_category')::int AS wrong_categories,count(*) FILTER(WHERE evaluation='excluded_valid')::int AS excluded_valid FROM catalog_resolver_items WHERE run_id=$1`,
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
async function contextFor(c: Query, run: any, link: any) {
  const settings = (
      await c.query('SELECT * FROM review_ai_settings WHERE id=true')
    ).rows[0],
    policies = await resolverPolicies(c);
  if (run.task === 'category') {
    const draft = await categoryDraft(c, run, link);
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
        ...catalogOffer(draft),
        sourceCategory: (link.source_category_path ?? []).join(' > '),
      },
      categories,
      policy,
      defaultCategoryId: policy?.categoryId ?? null,
      draftId: draft.id ?? null,
      draftVersion: draft.version ?? null,
      prompt: settings.category_prompt,
      promptVersion: settings.category_version,
      enabled: settings.category_enabled,
    };
  }
  const offer = catalogOffer(link),
    policy = selectPolicy(offer, policies);
  return {
    stage: policy ? 'identity' : 'type',
    offer,
    policy,
    policies: policy ? undefined : policyChoices(policies, offer),
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
    const inFlight = (
      await c.query(
        "SELECT count(*)::int AS n FROM catalog_resolver_items WHERE run_id=$1 AND status='leased' AND lease_until>clock_timestamp()",
        [id],
      )
    ).rows[0].n;
    if (inFlight >= settings.concurrency)
      return { run: await runSummary(c, run), item: null };
    const item = (
      await c.query(
        "SELECT i.* FROM catalog_resolver_items i WHERE i.run_id=$1 AND i.status='queued' AND (i.retry_at IS NULL OR i.retry_at<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM catalog_resolver_items other WHERE other.link_id=i.link_id AND other.id<>i.id AND other.status='leased' AND other.lease_until>clock_timestamp()) ORDER BY (i.product_id IS NOT NULL) DESC,i.id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [id],
      )
    ).rows[0];
    if (!item) return emptyClaim(c, run);
    if (item.product_id) {
      await skipPreparation(c, item);
      return { run: await runSummary(c, run), advance: true };
    }
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
  if (link?.status !== 'pending' || link.published_offer_id) {
    await finishItem(c, item, 'skipped', {
      outcome: 'skipped',
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
  const fresh = await contextFor(c, run, link);
  const context = await resumeMatchingContext(c, item, link, fresh);
  if (context.skip) return reuseDraft(c, run, item, link, context, userId);
  return leaseLink(c, run, item, link, context);
}
async function resumeMatchingContext(c: Query, item: any, link: any, fresh: any) {
  const saved = item.context;
  if (saved?.stage !== 'match' || item.source_hash !== sourceHash(link) || saved.promptVersion !== fresh.promptVersion) return fresh;
  if (saved.ephemeralPolicy) return saved;
  const row = (await c.query('SELECT version FROM catalog_identity_policies WHERE id=$1 AND enabled', [saved.policy.id])).rows[0];
  return row?.version === saved.policy.version ? saved : fresh;
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
    receipt?.result?.contractVersion === 2 &&
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
      deterministic: identity?.fingerprint && (cached || titleProvesIdentity(identity, context.offer))
        ? {
            policyId: context.policy.id,
            facts: identity.facts,
            name: identity.name,
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
      'SELECT p.*,i.identity,i.source_hash,i.policy_version FROM catalog_product_identities i JOIN products p ON p.id=i.product_id WHERE i.fingerprint=$1 ORDER BY p.id LIMIT 3 FOR SHARE OF p',
      [identity.fingerprint],
    )
  ).rows;
  const valid = exact.filter(
    (p) =>
      p.source_hash === sourceHash(p) && p.policy_version === policy.version,
  );
  if (valid.length) return { exact: valid, unknown: [] };
  const preciseTerms = [identity.attrs.brand, identity.attrs.model]
    .filter(Boolean)
    .join(' ');
  const terms = preciseTerms || canonical(identity.name).split(' ').filter(w => w.length > 1).slice(0, 10).join(' | ');
  if (!terms) return { exact: [], unknown: [] };
  const unknown = (
    await c.query(
      "SELECT p.*,i.identity,i.source_hash,i.policy_version FROM products p LEFT JOIN catalog_product_identities i ON i.product_id=p.id WHERE NOT p.personalized_kit AND to_tsvector('simple',coalesce(p.name,'')||' '||coalesce(p.brand,'')||' '||coalesce(p.model,'')) @@ CASE WHEN $2 THEN plainto_tsquery('simple',$1) ELSE to_tsquery('simple',$1) END ORDER BY ts_rank_cd(to_tsvector('simple',coalesce(p.name,'')||' '||coalesce(p.brand,'')||' '||coalesce(p.model,'')),CASE WHEN $2 THEN plainto_tsquery('simple',$1) ELSE to_tsquery('simple',$1) END) DESC,p.id LIMIT 20",
      [terms, !!preciseTerms],
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
  const identity = catalogIdentity(
    raw,
    context.offer,
    context.policy,
    link.id,
  );
  const policy = context.policy as IdentityPolicy,
    candidates = policy.exclusive
      ? { exact: [], unknown: [] }
      : await candidateProducts(c, identity, policy);
  const known = candidates.exact[0];
  if (!known && candidates.unknown.length)
    return beginMatching(c, item, context, identity, candidates.unknown);
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
  return createProductDraft(c, run, link, context, identity);
}
async function createProductDraft(c: Query, run: any, link: any, context: any, identity: any) {
  const policy = context.policy as IdentityPolicy;
  if (run.mode === 'shadow') return { outcome: 'drafted', applied: false, identity, productId: null };
  const title = identity.name,
    description = policy.attributes
      .filter((a) => identity.facts[a.key])
      .map((a) => a.label + ': ' + identity.facts[a.key].value)
      .join('. ')
      .slice(0, 4000) || title,
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
  return {
    outcome: 'drafted',
    applied: true,
    draftId: draft.id ?? null,
    identity,
  };
}
async function beginMatching(c: Query, item: any, context: any, identity: any, candidates: any[]) {
  const next = { ...context, stage: 'match', policies: undefined, identity,
    candidates: candidates.map(p => ({ id: p.id, title: p.name, brand: p.brand ?? '', description: String(p.description ?? '').slice(0, 300), sourceHash: sourceHash(p) })) };
  await c.query("UPDATE catalog_resolver_items SET status='queued',lease_until=NULL,attempts=greatest(0,attempts-1),context=$2 WHERE id=$1", [item.id, JSON.stringify(next)]);
  return { outcome: 'matching', applied: false, identity };
}
async function acceptMatch(c: Query, run: any, link: any, context: any, raw: unknown) {
  const v = z.strictObject({ productId: z.uuid().nullable(), reason: z.string().max(240) }).parse(raw);
  if (!v.productId) return createProductDraft(c, run, link, context, context.identity);
  const candidate = context.candidates.find((p: any) => p.id === v.productId);
  if (!candidate) throw new HttpError(400, 'Produto fora dos candidatos da análise.');
  const product = (await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE', [v.productId])).rows[0];
  if (!product || sourceHash(product) !== candidate.sourceHash) throw new HttpError(409, 'Produto alterado durante a comparação.');
  if (run.mode === 'active') {
    const identity = context.identity;
    await c.query('INSERT INTO catalog_product_identities(product_id,policy_id,policy_version,fingerprint,identity,source_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product_id) DO UPDATE SET policy_id=$2,policy_version=$3,fingerprint=$4,identity=$5,source_hash=$6 WHERE catalog_product_identities.fingerprint IS NULL',
      [product.id, context.policy.id, context.policy.version, identity.fingerprint, JSON.stringify({ ...identity, preparation:'completed' }), sourceHash(product)]);
    await assignCatalogProduct(c, link.id, product, run.created_by);
  }
  return { outcome: 'linked', applied: run.mode === 'active', productId: product.id, identity: context.identity, reason: v.reason };
}
async function acceptProductStep(c: Query, run: any, item: any, link: any, context: any, raw: unknown) {
  if (context.stage === 'match') return acceptMatch(c, run, link, context, raw);
  let decision = raw;
  if (context.stage === 'type') {
    const inferred = await inferCatalogPolicy(c, context, raw, run.mode);
    Object.assign(context, { stage: 'identity', policy: inferred.policy, policies: undefined, ephemeralPolicy: inferred.ephemeralPolicy });
    decision = inferred.decision;
    await c.query('UPDATE catalog_resolver_items SET context=$2 WHERE id=$1', [item.id, JSON.stringify(context)]);
  }
  return acceptProduct(c, run, item, link, context, decision);
}
const categoryResult = z.strictObject({
  categoryId: z.uuid().nullable(),
  path: z.array(z.string().trim().min(1).max(80)).max(10),
  exclude: z.boolean().optional(),
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
  await validateCategoryChoice(c, value, context);
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
  errorCode: z.enum(['analysis_failed', 'result_rejected']).optional(),
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
    const settings = await resolverSettings(c, true);
    if (item.product_id)
      return skipPreparation(c, item);
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
        ? await acceptProductStep(c, run, item, link, context, v.decision)
        : await acceptCategory(c, run, item, link, context, v.decision);
    const resolved = result.outcome !== 'matching';
    if (resolved)
      await finishItem(c, item, 'accepted', result);
    if (run.mode === 'active' && resolved)
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
          contractVersion: 2,
          promptVersion: context.promptVersion,
        }),
      ],
    );
    await audit(c, actor.id, 'catalog_resolver.' + result.outcome, link.id);
    return result;
  });
}

async function skipPreparation(c: Query, item: any) {
  const result = { outcome: 'skipped', applied: false, reason: 'Preparação antiga substituída por comparação direta dos candidatos.' };
  await finishItem(c, item, 'skipped', result);
  return result;
}

async function technicalRetry(c: Query, item: any, v: any, settings: any) {
  await c.query(
    'UPDATE catalog_resolver_items SET calls=calls+$2,tokens=tokens+$3,elapsed_ms=elapsed_ms+$4 WHERE id=$1',
    [item.id, v.model ? 1 : 0, v.tokens, v.elapsedMs],
  );
  const failed = item.attempts >= settings.max_attempts;
  await c.query(
    "UPDATE catalog_resolver_items SET status=$2,lease_id=NULL,lease_until=NULL,retry_at=clock_timestamp()+interval '2 seconds',decision=$3,context=CASE WHEN $4='result_rejected' THEN NULL ELSE context END WHERE id=$1",
    [
      item.id,
      failed ? 'failed' : 'queued',
      JSON.stringify({
        outcome: 'technical_retry',
        reason: v.errorCode === 'result_rejected'
          ? 'O resultado não pôde ser validado ou salvo; repetição limitada.'
          : 'A análise de IA falhou; repetição automática limitada.',
        errorCode: v.errorCode ?? 'analysis_failed',
      }),
      v.errorCode ?? 'analysis_failed',
    ],
  );
  return { outcome: failed ? 'failed' : 'retry' };
}

async function validateContext(c: Query, run: any, context: any) {
  const current = (
    await c.query('SELECT * FROM review_ai_settings WHERE id=true FOR SHARE')
  ).rows[0];
  if (
    context.promptVersion !==
    current[run.task === 'product' ? 'product_version' : 'category_version']
  )
    throw new HttpError(409, 'Instrução alterada. Inicie nova execução.');
  if (context.policy && !context.ephemeralPolicy) {
    const p = (
      await c.query(
        'SELECT version FROM catalog_identity_policies WHERE id=$1 AND enabled FOR SHARE',
        [context.policy.id],
      )
    ).rows[0];
    if (p?.version !== context.policy.version)
      throw new HttpError(409, 'Política alterada.');
  }
}

function validateLinkSnapshot(run: any, item: any, link: any, settings: any) {
  if (
    link?.status !== 'pending' ||
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

async function categoryDraft(c: Query, run: any, link: any) {
  if (link.product_draft_id)
    return (
      await c.query(
        'SELECT d.*,i.identity,i.policy_id,i.policy_version FROM review_ai_product_drafts d LEFT JOIN catalog_resolver_drafts i ON i.draft_id=d.id WHERE d.id=$1',
        [link.product_draft_id],
      )
    ).rows[0];
  if (run.mode !== 'shadow') return null;
  const receipt = (
    await c.query(
      "SELECT * FROM catalog_resolver_receipts WHERE link_id=$1 AND task='product'",
      [link.id],
    )
  ).rows[0];
  if (
    receipt?.source_hash !== sourceHash(link) ||
    receipt?.result?.outcome !== 'drafted' ||
    receipt?.result?.mode !== 'shadow'
  )
    return null;
  return {
    ...sourceData(link),
    id: null,
    version: null,
    policy_id: receipt.result.identity.policyId,
    policy_version: receipt.policy_version,
  };
}

async function validateCategoryChoice(
  c: Query,
  value: z.infer<typeof categoryResult>,
  context: any,
) {
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
}
