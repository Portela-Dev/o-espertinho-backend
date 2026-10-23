import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';
import { equal, HttpError } from './security.js';
import { audit } from './offers.js';

type Query = Pick<Database, 'query'>;
export const purgeCriteria = z
  .strictObject({
    links: z.boolean().default(true),
    products: z.boolean().default(true),
    linksDays: z.number().int().min(1).max(3650).default(30),
    productsDays: z.number().int().min(1).max(3650).default(30),
  })
  .refine((v) => v.links || v.products, 'Selecione links ou produtos.');
export const purgeExecute = z.strictObject({
  previewToken: z.string().min(1).max(6000),
  confirmed: z.literal(true),
});
const tokenData = z.strictObject({
  id: z.uuid(),
  userId: z.uuid(),
  criteria: purgeCriteria,
  asOf: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
type Criteria = z.infer<typeof purgeCriteria>;
const ids = (rows: any[]) => rows.map((r) => r.id as string);
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = (body: string, key: string) =>
  createHmac('sha256', Buffer.from(key, 'base64'))
    .update('catalog-purge:' + body)
    .digest('hex');
function decodeToken(token: string, key: string, userId: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !equal(signature(parts[0], key), parts[1]))
      throw new Error('Invalid operation data.');
    const value = tokenData.parse(
      JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
    );
    if (value.userId !== userId || Date.parse(value.expiresAt) <= Date.now())
      throw new Error('Invalid operation data.');
    return value;
  } catch {
    throw new HttpError(
      409,
      'Prévia inválida ou expirada. Gere uma nova prévia do expurgo.',
    );
  }
}
async function transaction<T>(
  db: Database,
  work: (c: Query) => Promise<T>,
  write = false,
) {
  const c = await db.connect();
  try {
    await c.query(
      write ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    await c.query("SET LOCAL lock_timeout='3s'");
    await c.query("SET LOCAL statement_timeout='30s'");
    if (write)
      await c.query(
        'LOCK TABLE products,offers,discovery_links,review_ai_product_drafts,offer_import_previews,extension_catalog_runs,extension_catalog_items,review_ai_suggestions,offer_price_history,favorites,collection_items,click_events,discovery_link_sources,audit_logs IN SHARE ROW EXCLUSIVE MODE',
      );
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    if (['55P03', '40P01', '57014'].includes((error as any).code))
      throw new HttpError(
        409,
        'O catálogo está ocupado. Tente novamente e gere outra prévia.',
      );
    throw error;
  } finally {
    c.release();
  }
}
async function assertIdle(c: Query) {
  const active = (
    await c.query(
      "SELECT EXISTS(SELECT 1 FROM extension_catalog_runs WHERE status NOT IN ('completed','failed','cancelled') AND expires_at>clock_timestamp()) OR EXISTS(SELECT 1 FROM review_ai_suggestions WHERE suggestion IS NULL AND expires_at>clock_timestamp()) AS active",
    )
  ).rows[0].active;
  if (active)
    throw new HttpError(
      409,
      'Conclua ou cancele as execuções e análises em andamento antes do expurgo.',
    );
}
async function selection(c: Query, criteria: Criteria, asOf: string) {
  const offers = criteria.links
    ? (
        await c.query(
          `SELECT id,updated_at,unavailable_since,failure_since FROM offers WHERE
 (availability_status='unavailable' AND unavailable_since<=$1::timestamptz-$2*interval '1 day') OR
 (refresh_status='pending' AND NULLIF(last_refresh_error,'') IS NOT NULL AND failure_since<=$1::timestamptz-$2*interval '1 day') ORDER BY id`,
          [asOf, criteria.linksDays],
        )
      ).rows
    : [];
  const products = criteria.products
    ? (
        await c.query(
          "SELECT id,updated_at,no_offers_since FROM products p WHERE no_offers_since<=$1::timestamptz-$2*interval '1 day' AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id) ORDER BY id",
          [asOf, criteria.productsDays],
        )
      ).rows
    : [];
  const offerIds = ids(offers),
    productIds = ids(products);
  const links = (
    await c.query(
      `SELECT id,enrichment_version,product_draft_id,published_offer_id,unavailable_since,failure_since FROM discovery_links WHERE
 published_offer_id=ANY($1::uuid[]) OR product_id=ANY($2::uuid[]) OR product_draft_id IN(SELECT id FROM review_ai_product_drafts WHERE product_id=ANY($2::uuid[])) OR
 ($3 AND published_offer_id IS NULL AND ((enrichment_data->>'availability'='unavailable' AND unavailable_since<=$4::timestamptz-$5*interval '1 day') OR (extraction_status='failed' AND failure_since<=$4::timestamptz-$5*interval '1 day'))) ORDER BY id`,
      [offerIds, productIds, criteria.links, asOf, criteria.linksDays],
    )
  ).rows;
  const linkIds = ids(links);
  const drafts = (
    await c.query(
      `SELECT id FROM review_ai_product_drafts d WHERE (product_id=ANY($1::uuid[]) OR id IN(SELECT product_draft_id FROM discovery_links WHERE id=ANY($2::uuid[]))) AND NOT EXISTS(SELECT 1 FROM discovery_links l WHERE l.product_draft_id=d.id AND NOT l.id=ANY($2::uuid[])) ORDER BY id`,
      [productIds, linkIds],
    )
  ).rows;
  const previews = (
    await c.query(
      `SELECT id FROM offer_import_previews p WHERE p.product_id=ANY($1::uuid[]) OR p.offer_id=ANY($2::uuid[])
 OR EXISTS(SELECT 1 FROM offers o WHERE o.id=ANY($2::uuid[]) AND o.marketplace_id=p.marketplace_id AND (p.source_url IN(o.product_url,o.affiliate_url) OR p.affiliate_url IN(o.product_url,o.affiliate_url)))
 OR EXISTS(SELECT 1 FROM discovery_links l WHERE l.id=ANY($3::uuid[]) AND l.marketplace_id=p.marketplace_id AND (p.source_url IN(l.url,l.affiliate_url) OR p.affiliate_url IN(l.url,l.affiliate_url))) ORDER BY id`,
      [productIds, offerIds, linkIds],
    )
  ).rows;
  const items = (
    await c.query(
      "SELECT id,run_id FROM extension_catalog_items WHERE target_id=ANY($1::uuid[]) OR run_id=ANY($2::uuid[]) OR payload->>'productId'=ANY($3::text[]) ORDER BY id",
      [[...offerIds, ...linkIds], ids(previews), productIds],
    )
  ).rows;
  const runs = (
    await c.query(
      'SELECT id FROM extension_catalog_runs r WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM extension_catalog_items i WHERE i.run_id=r.id AND NOT i.id=ANY($2::uuid[])) ORDER BY id',
      [[...new Set(items.map((r) => r.run_id))], ids(items)],
    )
  ).rows;
  const history = (
    await c.query(
      'SELECT offer_id,day FROM offer_price_history WHERE offer_id=ANY($1::uuid[]) OR product_id=ANY($2::uuid[]) ORDER BY offer_id,day',
      [offerIds, productIds],
    )
  ).rows;
  const favorites = (
    await c.query(
      'SELECT user_id,offer_id FROM favorites WHERE offer_id=ANY($1::uuid[]) ORDER BY user_id,offer_id',
      [offerIds],
    )
  ).rows;
  const collections = (
    await c.query(
      'SELECT collection_id,offer_id FROM collection_items WHERE offer_id=ANY($1::uuid[]) ORDER BY collection_id,offer_id',
      [offerIds],
    )
  ).rows;
  const clicks = (
    await c.query(
      'SELECT id FROM click_events WHERE offer_id=ANY($1::uuid[]) ORDER BY id',
      [offerIds],
    )
  ).rows;
  const suggestions = (
    await c.query(
      'SELECT request_id AS id FROM review_ai_suggestions WHERE link_id=ANY($1::uuid[]) ORDER BY request_id',
      [linkIds],
    )
  ).rows;
  const sources = (
    await c.query(
      'SELECT link_id,source_id FROM discovery_link_sources WHERE link_id=ANY($1::uuid[]) ORDER BY link_id,source_id',
      [linkIds],
    )
  ).rows;
  const entityIds = [
    ...offerIds,
    ...productIds,
    ...linkIds,
    ...ids(drafts),
    ...ids(previews),
    ...ids(items),
    ...ids(runs),
    ...ids(suggestions),
  ];
  const audits = (
    await c.query(
      'SELECT id FROM audit_logs WHERE entity_id=ANY($1::text[]) ORDER BY id',
      [entityIds],
    )
  ).rows;
  const all = {
    offers,
    products,
    links,
    drafts,
    previews,
    items,
    runs,
    history,
    favorites,
    collections,
    clicks,
    suggestions,
    sources,
    audits,
  };
  return {
    all,
    entityIds,
    digest: digest(all),
    counts: {
      offers: offers.length,
      discoveredLinks: links.length,
      products: products.length,
      productDrafts: drafts.length,
      previews: previews.length,
      processingItems: items.length,
      processingRuns: runs.length,
      priceHistory: history.length,
      favorites: favorites.length,
      collectionItems: collections.length,
      clicks: clicks.length,
      aiSuggestions: suggestions.length,
      sourceAssociations: sources.length,
      auditEntries: audits.length,
    },
  };
}
export async function previewPurge(
  db: Database,
  key: string,
  userId: string,
  input: unknown,
) {
  const criteria = purgeCriteria.parse(input);
  return transaction(db, async (c) => {
    await assertIdle(c);
    const asOf = new Date().toISOString(),
      selected = await selection(c, criteria, asOf);
    const value = {
      id: randomUUID(),
      userId,
      criteria,
      asOf,
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      digest: selected.digest,
    };
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return {
      criteria,
      asOf,
      expiresAt: value.expiresAt,
      counts: selected.counts,
      previewToken: body + '.' + signature(body, key),
    };
  });
}
export async function executePurge(
  db: Database,
  key: string,
  userId: string,
  input: unknown,
) {
  const request = purgeExecute.parse(input),
    value = decodeToken(request.previewToken, key, userId);
  return transaction(
    db,
    async (c) => {
      await assertIdle(c);
      const selected = await selection(c, value.criteria, value.asOf);
      if (selected.digest !== value.digest)
        throw new HttpError(
          409,
          'O catálogo mudou desde a prévia. Gere uma nova prévia antes de excluir.',
        );
      const a = selected.all;
      if (!a.offers.length && !a.products.length && !a.links.length)
        throw new HttpError(409, 'Nenhum registro elegível para expurgo.');
      await c.query('DELETE FROM audit_logs WHERE id=ANY($1::uuid[])', [
        ids(a.audits),
      ]);
      await c.query(
        'DELETE FROM extension_catalog_items WHERE id=ANY($1::uuid[])',
        [ids(a.items)],
      );
      await c.query(
        'DELETE FROM extension_catalog_runs WHERE id=ANY($1::uuid[])',
        [ids(a.runs)],
      );
      await c.query(
        'DELETE FROM offer_import_previews WHERE id=ANY($1::uuid[])',
        [ids(a.previews)],
      );
      await c.query(
        'DELETE FROM offer_price_history WHERE offer_id=ANY($1::uuid[]) OR product_id=ANY($2::uuid[])',
        [ids(a.offers), ids(a.products)],
      );
      await c.query('DELETE FROM discovery_links WHERE id=ANY($1::uuid[])', [
        ids(a.links),
      ]);
      await c.query(
        'DELETE FROM review_ai_product_drafts WHERE id=ANY($1::uuid[])',
        [ids(a.drafts)],
      );
      await c.query('DELETE FROM offers WHERE id=ANY($1::uuid[])', [
        ids(a.offers),
      ]);
      await c.query('DELETE FROM products WHERE id=ANY($1::uuid[])', [
        ids(a.products),
      ]);
      // Keep only an independent summary event, without IDs/URLs of purged records.
      await audit(
        c,
        userId,
        'catalog.purged',
        JSON.stringify({
          operation: value.id,
          counts: selected.counts,
          criteria: value.criteria,
        }),
      );
      return { ok: true, counts: selected.counts };
    },
    true,
  );
}
export function registerCatalogPurge(app: Express, db: Database) {
  // Previews are short-lived and deliberately invalidated by a backend restart.
  const key = randomBytes(32).toString('base64');
  app.post('/api/admin/purge/preview', async (req, res) =>
    res.json(await previewPurge(db, key, req.user!.id, req.body)),
  );
  app.post('/api/admin/purge/execute', async (req, res) =>
    res.json(await executePurge(db, key, req.user!.id, req.body)),
  );
}
