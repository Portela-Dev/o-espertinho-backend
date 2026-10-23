import {
  inventoryPage,
  inventoryRevision,
  inventoryDelta,
  catalogDraft,
  assignCatalogProduct,
  finalizeCatalogDraft,
  resolveAiCategory,
} from './review-ai-catalog.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Express, Router } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';
import type { CatalogActor } from './catalog-contracts.js';
import { catalogTransaction } from './catalog-runs.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
const taskSchema = z.enum(['category', 'product']);
export const reviewAiInput = z.strictObject({
  version: z.number().int().positive(),
  categoryEnabled: z.boolean(),
  productEnabled: z.boolean(),
  categoryPrompt: z.string().trim().min(1).max(10000),
  productPrompt: z.string().trim().min(1).max(10000),
});
const productSchema = z.strictObject({
  name: z.string().trim().min(1).max(300),
  description: z.string().max(4000),
  brand: z.string().max(120),
  personalizedKit: z.boolean().default(false),
});
export const reviewAiResult = z.strictObject({
  requestId: z.uuid(),
  model: z.string().min(1).max(200),
  suggestion: z.strictObject({
    action: z.enum([
      'link_existing',
      'create_new',
      'use_category',
      'create_category',
      'needs_review',
      'invalid',
    ]),
    category: z.string().max(1000).default(''),
    categoryId: z.uuid().nullable().default(null),
    categoryExists: z.boolean().optional(),
    productId: z.uuid().nullable(),
    product: productSchema.nullable(),
    reason: z.string().min(1).max(3000),
  }),
});
export const invalidAiReview = (row: any) =>
  ['product', 'category'].some(
    (task) => row.ai_resolution?.[task]?.action === 'invalid',
  );
type Query = Pick<Database, 'query'>;
export async function reviewAiSettings(db: Query, lock = false) {
  const r = (
    await db.query(
      'SELECT * FROM review_ai_settings WHERE id=true' +
        (lock ? ' FOR SHARE' : ''),
    )
  ).rows[0];
  return {
    version: r.version,
    categoryEnabled: r.category_enabled,
    productEnabled: r.product_enabled,
    categoryPrompt: r.category_prompt,
    productPrompt: r.product_prompt,
  };
}
async function taskVersion(db: Query, task: 'category' | 'product') {
  const column = task === 'category' ? 'category_version' : 'product_version';
  return (
    await db.query(
      'SELECT ' + column + ' AS version FROM review_ai_settings WHERE id=true',
    )
  ).rows[0].version as number;
}
function allowed(actor: CatalogActor) {
  if (
    !actor.permissions.includes('affiliate_links') ||
    !actor.permissions.includes('catalog')
  )
    throw new HttpError(
      403,
      'Seu perfil precisa das permissões de catálogo e geração de links.',
    );
}
function enabled(
  settings: Awaited<ReturnType<typeof reviewAiSettings>>,
  task: 'category' | 'product',
) {
  if (!settings[task === 'category' ? 'categoryEnabled' : 'productEnabled'])
    throw new HttpError(409, 'Esta tarefa de IA está desativada no admin.');
}
async function eligible(
  db: Query,
  id: string,
  task: 'category' | 'product',
  lock = false,
) {
  const row = (
    await db.query(
      'SELECT * FROM discovery_links WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
  if (
    !row ||
    row.status !== 'pending' ||
    row.published_offer_id ||
    row.extraction_status !== 'completed' ||
    invalidAiReview(row) ||
    (task === 'product'
      ? !!row.product_id || !!row.product_draft_id
      : !row.product_draft_id || !!row.product_id)
  )
    throw new HttpError(
      409,
      'Link não elegível para esta tarefa. Anúncios inválidos precisam de nova extração.',
    );
  return row;
}
export async function aiQueue(db: Query, actor: CatalogActor, input: unknown) {
  allowed(actor);
  const v = z
      .strictObject({
        marketplaceId: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),
        task: taskSchema,
        retryReview: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(10000).default(100),
      })
      .parse(input),
    settings = await reviewAiSettings(db);
  enabled(settings, v.task);
  const revision = await taskVersion(db, v.task);
  const links = (
    await db.query(
      `SELECT DISTINCT ON (CASE WHEN $2='category' THEN l.product_draft_id ELSE l.id END) l.id,l.enrichment_data->>'title' AS title FROM discovery_links l
 WHERE l.marketplace_id=$1 AND l.status='pending' AND l.published_offer_id IS NULL AND l.extraction_status='completed'
 AND COALESCE(l.ai_resolution->'product'->>'action','')<>'invalid' AND COALESCE(l.ai_resolution->'category'->>'action','')<>'invalid'
 AND (($2='category' AND l.product_draft_id IS NOT NULL AND l.product_id IS NULL) OR ($2='product' AND l.product_id IS NULL AND l.product_draft_id IS NULL))
 AND (($5 AND l.ai_resolution->$2->>'action'='needs_review' AND NOT EXISTS(SELECT 1 FROM review_ai_suggestions s WHERE s.link_id=l.id AND s.task=$2 AND s.link_version=l.enrichment_version AND s.suggestion IS NULL AND s.expires_at>clock_timestamp()))
 OR (NOT $5 AND NOT EXISTS(SELECT 1 FROM review_ai_suggestions s WHERE s.link_id=l.id AND s.task=$2 AND s.link_version=l.enrichment_version AND s.settings_version=$3 AND (s.suggestion IS NOT NULL OR s.expires_at>clock_timestamp()))))
 ORDER BY (CASE WHEN $2='category' THEN l.product_draft_id ELSE l.id END),l.first_seen_at,l.id LIMIT $4`,
      [v.marketplaceId, v.task, revision, v.limit, v.retryReview === 'true'],
    )
  ).rows;
  return { items: links };
}
export async function aiContext(
  db: Database,
  actor: CatalogActor,
  id: string,
  task: 'category' | 'product',
  expectedInventory: string,
  retryReview = false,
) {
  allowed(actor);
  return catalogTransaction(db, async (c) => {
    const settings = await reviewAiSettings(c, true);
    enabled(settings, task);
    const revision = await taskVersion(c, task),
      link = await eligible(c, id, task, true);
    const inventory = await inventoryRevision(c);
    if (inventory !== expectedInventory)
      throw new HttpError(
        409,
        'O inventário mudou. Atualize o catálogo da extensão e reinicie o lote.',
      );
    const previous = (
      await c.query(
        'SELECT * FROM review_ai_suggestions WHERE link_id=$1 AND task=$2',
        [id, task],
      )
    ).rows[0];
    if (retryReview) {
      const leased =
        previous?.link_version === link.enrichment_version &&
        !previous.suggestion &&
        new Date(previous.expires_at).getTime() > Date.now();
      if (link.ai_resolution?.[task]?.action !== 'needs_review' || leased)
        throw new HttpError(
          409,
          'Este item não está mais aguardando revisão ou já está em análise.',
        );
      await audit(c, actor.id, 'review_ai.reprocessing', id);
    } else if (
      previous?.link_version === link.enrichment_version &&
      previous?.settings_version === revision &&
      (previous.suggestion ||
        new Date(previous.expires_at).getTime() > Date.now())
    )
      throw new HttpError(
        409,
        'Este item já tem análise pendente ou requer revisão manual.',
      );
    const draft = link.product_draft_id
      ? (
          await c.query('SELECT * FROM review_ai_product_drafts WHERE id=$1', [
            link.product_draft_id,
          ])
        ).rows[0]
      : null;
    const data =
      task === 'category'
        ? {
            title: draft.name,
            description: draft.description,
            brand: draft.brand,
          }
        : link.enrichment_data;
    const mapping = (
      await c.query(
        'SELECT n.id,n.path FROM category_mappings m JOIN category_nodes n ON n.id=m.category_id WHERE m.marketplace_id=$1 AND m.source_key=$2',
        [link.marketplace_id, link.source_category_key],
      )
    ).rows[0];
    const requestId = randomUUID(),
      context = {
        inventoryRevision: inventory,
        draftId: draft?.id ?? null,
        draftVersion: draft?.version ?? null,
      };
    await c.query(
      `INSERT INTO review_ai_suggestions(link_id,task,request_id,link_version,settings_version,created_by,request_context) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(link_id,task) DO UPDATE SET request_id=$3,link_version=$4,settings_version=$5,created_by=$6,request_context=$7,suggestion=NULL,expires_at=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()`,
      [
        id,
        task,
        requestId,
        link.enrichment_version,
        revision,
        actor.id,
        JSON.stringify(context),
      ],
    );
    return {
      requestId,
      task,
      instructions:
        task === 'category' ? settings.categoryPrompt : settings.productPrompt,
      offer: {
        title: String(data.title ?? '').slice(0, 500),
        brand: String(data.brand ?? '').slice(0, 200),
        description: String(data.description ?? '').slice(0, 8000),
        sourceCategory: (link.source_category_path ?? []).join(' > '),
        specifications: (link.enrichment_data.specifications ?? [])
          .slice(0, 80)
          .map((p: any) => ({
            name: String(p.name).slice(0, 200),
            value: String(p.value).slice(0, 2000),
          })),
      },
      mapping: task === 'category' && mapping ? mapping.path.join(' > ') : null,
    };
  });
}
function validDecision(task: string, s: any) {
  if (['needs_review', 'invalid'].includes(s.action)) {
    if (s.productId || s.product || s.categoryId)
      throw new HttpError(
        400,
        'Decisão pendente ou inválida não pode aplicar dados.',
      );
    return;
  }
  if (task === 'product') {
    if (
      !['link_existing', 'create_new'].includes(s.action) ||
      (s.action === 'link_existing') !== !!s.productId ||
      (s.action === 'create_new') !== !!s.product ||
      s.categoryId
    )
      throw new HttpError(400, 'Decisão de catalogação inconsistente.');
  } else if (
    !['use_category', 'create_category'].includes(s.action) ||
    s.productId ||
    s.product ||
    (s.action === 'use_category') !== !!s.categoryId
  )
    throw new HttpError(400, 'Decisão de categoria inconsistente.');
}
async function applyDecision(
  c: Query,
  link: any,
  context: any,
  s: any,
  userId: string,
) {
  if (s.action === 'needs_review')
    return { outcome: 'needs_review', applied: false };
  if (s.action === 'invalid') return { outcome: 'invalid', applied: false };
  if (s.action === 'create_new')
    return {
      ...(await catalogDraft(c, link, s.product, userId)),
      applied: true,
    };
  if (s.action === 'link_existing') {
    const product = (
      await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE NOWAIT', [
        s.productId,
      ])
    ).rows[0];
    if (product) {
      if (product.personalized_kit)
        throw new HttpError(
          400,
          'Kits personalizados exigem produto próprio por anúncio.',
        );
      await assignCatalogProduct(c, link.id, product, userId);
      return { outcome: 'linked', product, applied: true };
    }
    const draft = (
      await c.query(
        'SELECT * FROM review_ai_product_drafts WHERE id=$1 AND product_id IS NULL FOR UPDATE',
        [s.productId],
      )
    ).rows[0];
    if (!draft || draft.personalized_kit)
      throw new HttpError(
        400,
        'Identidade fora do inventário ou kit personalizado de outro anúncio.',
      );
    await c.query(
      'UPDATE discovery_links SET product_draft_id=$2,enrichment_version=enrichment_version+1 WHERE id=$1',
      [link.id, draft.id],
    );
    return { outcome: 'drafted', draft, applied: true };
  }
  const draft = (
    await c.query(
      'SELECT * FROM review_ai_product_drafts WHERE id=$1 FOR UPDATE',
      [context.draftId],
    )
  ).rows[0];
  if (!draft || draft.version !== context.draftVersion || draft.product_id)
    throw new HttpError(409, 'Rascunho atualizado. Recarregue o inventário.');
  const category = await resolveAiCategory(c, s);
  return {
    ...(await finalizeCatalogDraft(c, draft.id, category.id, userId)),
    applied: true,
  };
}
export async function saveAiSuggestion(
  db: Database,
  actor: CatalogActor,
  input: unknown,
) {
  allowed(actor);
  const v = reviewAiResult.parse(input),
    hash = createHash('sha256').update(JSON.stringify(v)).digest('hex');
  try {
    return await catalogTransaction(db, async (c) => {
      await c.query("SET LOCAL lock_timeout='2s'");
      await c.query(
        'SELECT id FROM review_ai_settings WHERE id=true FOR UPDATE',
      );
      const settings = await reviewAiSettings(c);
      const snapshot = (
        await c.query(
          'SELECT * FROM review_ai_suggestions WHERE request_id=$1',
          [v.requestId],
        )
      ).rows[0];
      if (!snapshot || snapshot.created_by !== actor.id)
        throw new HttpError(404, 'Solicitação de IA não encontrada.');
      if (snapshot.suggestion?.resultHash) {
        if (snapshot.suggestion.resultHash !== hash)
          throw new HttpError(
            409,
            'Solicitação já concluída com outro resultado.',
          );
        return snapshot.suggestion.application;
      }
      enabled(settings, snapshot.task);
      validDecision(snapshot.task, v.suggestion);
      const revision = await taskVersion(c, snapshot.task),
        inventory = await inventoryRevision(c, true),
        link = await eligible(c, snapshot.link_id, snapshot.task, true);
      if (
        snapshot.link_version !== link.enrichment_version ||
        snapshot.settings_version !== revision ||
        snapshot.request_context.inventoryRevision !== inventory
      )
        throw new HttpError(
          409,
          'Oferta, instruções ou inventário alterados. Recarregue e reinicie o lote.',
        );
      if (new Date(snapshot.expires_at).getTime() < Date.now())
        throw new HttpError(409, 'Solicitação expirada.');
      const result = await applyDecision(
          c,
          link,
          snapshot.request_context,
          v.suggestion,
          actor.id,
        ),
        delta = await inventoryDelta(c, result);
      const application = {
        outcome: result.outcome,
        applied: result.applied,
        inventory: delta,
      };
      await c.query(
        'UPDATE review_ai_suggestions SET suggestion=$2,updated_at=clock_timestamp() WHERE request_id=$1',
        [
          v.requestId,
          JSON.stringify({
            ...v.suggestion,
            model: v.model,
            resultHash: hash,
            application,
            categoryPath: v.suggestion.category
              ? v.suggestion.category.split('>').map((p) => p.trim())
              : [],
          }),
        ],
      );
      await c.query(
        `UPDATE discovery_links SET ai_resolution=jsonb_set(ai_resolution,ARRAY[$2]::text[],$3::jsonb) WHERE id=$1`,
        [
          link.id,
          snapshot.task,
          JSON.stringify({
            action: v.suggestion.action,
            reason: v.suggestion.reason,
            model: v.model,
            outcome: result.outcome,
            automatic: result.applied,
            at: new Date().toISOString(),
          }),
        ],
      );
      await audit(c, actor.id, 'review_ai.' + result.outcome, link.id);
      return application;
    });
  } catch (error) {
    if (['55P03', '40P01', '40001'].includes((error as any).code))
      throw new HttpError(
        409,
        'O catálogo está sendo alterado. Recarregue e reinicie o lote.',
      );
    throw error;
  }
}
export function registerReviewAiAdmin(app: Express, db: Database) {
  const base = '/api/admin/discovery/enrichment/ai';
  app.get(base + '/settings', async (_req, res) =>
    res.json(await reviewAiSettings(db)),
  );
  app.put(base + '/settings', async (req, res) => {
    const v = reviewAiInput.parse(req.body);
    const result = await catalogTransaction(db, async (c) => {
      const changed = await c.query(
        'UPDATE review_ai_settings SET category_enabled=$2,product_enabled=$3,category_version=category_version+CASE WHEN category_enabled IS DISTINCT FROM $2 OR category_prompt IS DISTINCT FROM $4 THEN 1 ELSE 0 END,product_version=product_version+CASE WHEN product_enabled IS DISTINCT FROM $3 OR product_prompt IS DISTINCT FROM $5 THEN 1 ELSE 0 END,category_prompt=$4,product_prompt=$5,version=version+1,updated_by=$6,updated_at=clock_timestamp() WHERE id=true AND version=$1 RETURNING version',
        [
          v.version,
          v.categoryEnabled,
          v.productEnabled,
          v.categoryPrompt,
          v.productPrompt,
          req.user!.id,
        ],
      );
      if (!changed.rows.length)
        throw new HttpError(
          409,
          'Configurações alteradas. Recarregue antes de salvar.',
        );
      await audit(c, req.user!.id, 'review_ai.settings', 'global');
      return reviewAiSettings(c);
    });
    res.json(result);
  });
  app.post(base + '/suggestions/:id/discard', async (req, res) => {
    z.strictObject({}).parse(req.body);
    const id = z.uuid().parse(req.params.id);
    await db.query('DELETE FROM review_ai_suggestions WHERE request_id=$1', [
      id,
    ]);
    await audit(db, req.user!.id, 'review_ai.discarded', id);
    res.json({ ok: true });
  });
}
export function registerReviewAiExtension(
  router: Router,
  db: Database,
  account: (req: any) => Promise<CatalogActor>,
) {
  router.get('/catalog/ai/config', async (req, res) => {
    const actor = await account(req);
    allowed(actor);
    const marketplaceId = z
      .string()
      .regex(/^[a-z][a-z0-9_-]{1,39}$/)
      .parse(req.query.marketplaceId);
    const stats = (
      await db.query(
        `SELECT count(*)::int AS total,
 count(*) FILTER(WHERE confirmed_category_id IS NOT NULL AND product_id IS NOT NULL)::int AS categorized,
 count(*) FILTER(WHERE product_id IS NOT NULL OR product_draft_id IS NOT NULL)::int AS cataloged,
 (SELECT count(*)::int FROM review_ai_suggestions s JOIN discovery_links d ON d.id=s.link_id WHERE d.marketplace_id=$1 AND d.status='pending' AND d.published_offer_id IS NULL AND s.link_version=d.enrichment_version AND s.settings_version=(SELECT CASE s.task WHEN 'category' THEN category_version ELSE product_version END FROM review_ai_settings WHERE id=true) AND s.suggestion IS NOT NULL) AS suggestions
 FROM discovery_links WHERE marketplace_id=$1 AND status='pending' AND published_offer_id IS NULL`,
        [marketplaceId],
      )
    ).rows[0];
    res.json({
      settings: await reviewAiSettings(db),
      category: { completed: stats.categorized, total: stats.cataloged },
      product: { completed: stats.cataloged, total: stats.total },
      pendingSuggestions: stats.suggestions,
    });
  });
  router.get('/catalog/ai/inventory', async (req, res) => {
    allowed(await account(req));
    res.json(await inventoryPage(db, req.query));
  });
  router.get('/catalog/ai/queue', async (req, res) =>
    res.json(await aiQueue(db, await account(req), req.query)),
  );
  router.post('/catalog/ai/context', async (req, res) => {
    const v = z
      .strictObject({
        id: z.uuid(),
        task: taskSchema,
        inventoryRevision: z.string().regex(/^\d+$/),
        retryReview: z.boolean().default(false),
      })
      .parse(req.body);
    res.json(
      await aiContext(
        db,
        await account(req),
        v.id,
        v.task,
        v.inventoryRevision,
        v.retryReview,
      ),
    );
  });
  router.post('/catalog/ai/suggestions', async (req, res) =>
    res.json(await saveAiSuggestion(db, await account(req), req.body)),
  );
  router.post('/catalog/ai/release', async (req, res) => {
    const actor = await account(req);
    allowed(actor);
    const { requestId } = z
      .strictObject({ requestId: z.uuid() })
      .parse(req.body);
    await db.query(
      'DELETE FROM review_ai_suggestions WHERE request_id=$1 AND created_by=$2 AND suggestion IS NULL',
      [requestId, actor.id],
    );
    res.json({ ok: true });
  });
}
