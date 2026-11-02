import type { Express } from 'express';
import type { Database } from './db.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogTransaction } from './catalog-runs.js';
import { marketUrl } from './scraping.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
import { recordDailyPrice } from './price-history.js';
import { invalidAiReview } from './review-ai.js';
export const publishBatchInput = z.strictObject({
  authorizedContent: z.literal(true),
  items: z
    .array(
      z.strictObject({ id: z.uuid(), version: z.number().int().nonnegative() }),
    )
    .min(1)
    .max(100),
});
const publishInput = z.strictObject({
  version: z.number().int().nonnegative(),
  authorizedContent: z.literal(true),
});
async function existingPublication(c: Pick<Database, 'query'>, link: any) {
  return (await c.query(
    `SELECT id,status FROM offers WHERE marketplace_id=$1 AND (external_id=$2 OR affiliate_url=$3)
     ORDER BY CASE WHEN external_id=$2 THEN 0 ELSE 1 END,id LIMIT 1 FOR UPDATE`,
    [link.marketplace_id, link.id, link.affiliate_url],
  )).rows[0];
}
async function removeDuplicateReview(c: Pick<Database, 'query'>, userId: string, link: any, offer: any) {
  // Keep the URL as a tombstone so discovery cannot recreate the duplicate.
  await c.query(
    `UPDATE discovery_links SET status='archived',published_offer_id=$2,enrichment_version=enrichment_version+1,
     catalog_resolution=COALESCE(catalog_resolution,'{}'::jsonb)||jsonb_build_object('duplicatePublication',jsonb_build_object('offerId',$2::uuid)) WHERE id=$1`,
    [link.id, offer.id],
  );
  await audit(c, userId, 'discovery.publication_duplicate_removed', link.id);
  return { offerId: offer.id, alreadyPublished: true, duplicateRemoved: true };
}
async function publishCandidate(
  db: Database,
  userId: string,
  id: string,
  version: number,
) {
  return catalogTransaction(db, async (c) => {
    const link = (
      await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE', [
        id,
      ])
    ).rows[0];
    if (!link) throw new HttpError(404, 'Link não encontrado.');
    if (link.published_offer_id)
      return { offerId: link.published_offer_id, alreadyPublished: true, duplicateRemoved: !!link.catalog_resolution?.duplicatePublication };
    if (invalidAiReview(link))
      throw new HttpError(
        409,
        'Anúncio inválido. Confirme manualmente a categoria ou o produto, ou extraia os dados novamente e refaça a análise antes de publicar.',
      );
    if (link.enrichment_version !== version)
      throw new HttpError(409, 'A oferta foi alterada. Atualize a lista e confirme novamente.');
    if (
      link.status !== 'pending' ||
      link.extraction_status !== 'completed' ||
      !link.confirmed_category_id ||
      !link.product_id ||
      !link.affiliate_url
    )
      throw new HttpError(
        409,
        'Confirme categoria, produto e informações antes de publicar.',
      );
    // Offer insertion updates the product-presence marker. Serialize publications of
    // this product before taking share locks, avoiding competing lock upgrades.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['catalog-publication:' + link.product_id]);
    const product = (
      await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE NOWAIT', [
        link.product_id,
      ])
    ).rows[0];
    if (!product?.category_ids.includes(link.confirmed_category_id))
      throw new HttpError(
        409,
        'O produto não pertence à categoria confirmada.',
      );
    const market = (
      await c.query(
        'SELECT id,name,website_url,logo_url,allowed_hosts,scraping_enabled,url_normalization_rules,catalog_executor,updated_at FROM marketplaces WHERE id=$1 FOR SHARE',
        [link.marketplace_id],
      )
    ).rows[0];
    if (!market.scraping_enabled)
      throw new HttpError(409, 'Marketplace desativado.');
    marketUrl(link.affiliate_url, market.allowed_hosts);
    marketUrl(link.url, market.allowed_hosts);
    const profile = (
        await c.query(
          'SELECT * FROM scraping_profiles WHERE marketplace_id=$1',
          [market.id],
        )
      ).rows[0],
      data = link.enrichment_data;
    if (
      !profile ||
      !data?.title?.trim() ||
      data.missing?.length ||
      !Number.isInteger(data.priceCents) ||
      data.priceCents <= 0
    )
      throw new HttpError(409, 'Os dados obrigatórios estão incompletos.');
    if (data.availability === 'unavailable')
      throw new HttpError(409, 'A oferta está indisponível no marketplace.');
    const existing = await existingPublication(c, link);
    if (existing) return removeDuplicateReview(c, userId, link, existing);
    // Review duration does not invalidate data. Keep the actual collection timestamp.
    const expires = new Date(Date.now() + profile.validity_minutes * 60000);
    const offerId = randomUUID();
    const inserted = await c.query(
      `INSERT INTO offers(id,marketplace_id,external_id,title,description,category,subcategory,category_path,image_url,images,product_url,affiliate_url,price_cents,original_price_cents,source,status,published_at,conditions,expires_at,product_id,specifications,extraction_metadata,data_updated_at,rating,review_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'scraped','published',clock_timestamp(),$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT DO NOTHING RETURNING id`,
      [
        offerId,
        market.id,
        link.id,
        data.title,
        data.description,
        product.category,
        product.subcategory,
        product.category_path,
        data.images[0] ?? null,
        JSON.stringify(data.images),
        link.url,
        link.affiliate_url,
        data.priceCents,
        data.originalPriceCents,
        data.conditions,
        expires,
        product.id,
        JSON.stringify(data.specifications),
        JSON.stringify({ collectedAt: link.extracted_at, source: 'extension' }),
        link.extracted_at,
        data.rating ?? null,
        data.reviewCount ?? null,
      ],
    );
    if (!inserted.rows.length) {
      const concurrent = await existingPublication(c, link);
      if (!concurrent) throw new HttpError(409, 'A publicação mudou durante a confirmação. Atualize a lista.');
      return removeDuplicateReview(c, userId, link, concurrent);
    }
    await c.query(
      'UPDATE discovery_links SET published_offer_id=$2,enrichment_version=enrichment_version+1 WHERE id=$1',
      [link.id, offerId],
    );
    await recordDailyPrice(
      c,
      offerId,
      product.id,
      data.priceCents,
      new Date(link.extracted_at).toISOString(),
    );
    await audit(c, userId, 'discovery.published', link.id);
    return { offerId, alreadyPublished: false, duplicateRemoved: false };
  });
}
export function registerCatalogPublication(app: Express, db: Database) {
  app.post(
    '/api/admin/discovery/enrichment/review/publish-batch',
    async (req, res) => {
      const v = publishBatchInput.parse(req.body);
      if (new Set(v.items.map((i) => i.id)).size !== v.items.length)
        throw new HttpError(400, 'Selecione cada link apenas uma vez.');
      const results: Array<
        {id: string; ok: true; offerId: string; alreadyPublished: boolean; duplicateRemoved: boolean} |
        {id: string; ok: false; status: number; message: string}
      > = [];
      for (const item of v.items) {
        try {
          results.push({
            id: item.id,
            ok: true,
            ...(await publishCandidate(
              db,
              req.user!.id,
              item.id,
              item.version,
            )),
          });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          results.push({
            id: item.id,
            ok: false,
            status: error.status,
            message: error.message,
          });
        }
      }
      res.json({
        results,
        published: results.filter((r) => r.ok && !r.duplicateRemoved).length,
        deduplicated: results.filter((r) => r.ok && r.duplicateRemoved).length,
        failed: results.filter((r) => !r.ok).length,
      });
    },
  );
  app.post(
    '/api/admin/discovery/enrichment/review/:id/publish',
    async (req, res) => {
      const id = z.uuid().parse(req.params.id),
        input = publishInput.parse(req.body);
      res.json(await publishCandidate(db, req.user!.id, id, input.version));
    },
  );
}
