import { resolverSettings } from './catalog-resolver.js';
import type { Express, Router } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';
import type { CatalogActor } from './catalog-contracts.js';
import { catalogTransaction } from './catalog-runs.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
type Query = Pick<Database, 'query'>;
export const reviewAiInput = z.strictObject({
  version: z.number().int().positive(),
  categoryEnabled: z.boolean(),
  productEnabled: z.boolean(),
  categoryPrompt: z.string().trim().min(1).max(10000),
  productPrompt: z.string().trim().min(1).max(10000),
});
export const invalidAiReview = (row: any) =>
  ['product', 'category'].some(
    (task) => row.ai_resolution?.[task]?.action === 'invalid',
  );
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
 count(*) FILTER(WHERE product_id IS NOT NULL OR product_draft_id IS NOT NULL)::int AS cataloged
 FROM discovery_links WHERE marketplace_id=$1 AND status='pending' AND published_offer_id IS NULL AND NULLIF(trim(affiliate_url),'') IS NOT NULL`,
        [marketplaceId],
      )
    ).rows[0];
    res.json({
      resolver: await resolverSettings(db),
      settings: await reviewAiSettings(db),
      category: { completed: stats.categorized, total: stats.cataloged },
      product: { completed: stats.cataloged, total: stats.total },
    });
  });
}
