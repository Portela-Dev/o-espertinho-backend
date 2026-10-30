import { publicHttpsUrlSchema } from './public-url.js';
import {
  finalizeCatalogDraft,
  assignCatalogProduct,
} from './review-ai-catalog.js';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
import { pagedQuery } from './pagination.js';
import { requiredCategory } from './classifications.js';
import { invalidAiReview } from './review-ai.js';
import { reviewStates, reviewStatusSql } from './review-status.js';
const uuid = z.uuid();
const marketId = z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
const newProduct = z.strictObject({
  name: z.string().trim().min(1).max(300),
  description: z.string().max(4000).default(''),
  brand: z.string().trim().max(120).default(''),
  imageUrl: publicHttpsUrlSchema.nullable().default(null),
});
const assignment = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('existing'),
    version: z.number().int().nonnegative(),
    productId: uuid,
  }),
  z.strictObject({
    mode: z.literal('new'),
    version: z.number().int().nonnegative(),
    product: newProduct,
  }),
]);
async function reviewableLink(
  db: Pick<Database, 'query'>,
  id: string,
  lock = false,
) {
  const row = (
    await db.query(
      'SELECT * FROM discovery_links WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [id],
    )
  ).rows[0];
  if (!row) {
    throw new HttpError(404, 'Link não encontrado.');
  }
  if (
    row.status !== 'pending' ||
    row.published_offer_id ||
    row.extraction_status !== 'completed'
  ) {
    throw new HttpError(
      409,
      'Conclua a extração de um link pendente e não publicado antes de atribuir um produto.',
    );
  }
  return row;
}
export const categoryKey = (path: string[]) =>
  JSON.stringify(
    path.map((s) =>
      s.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase(),
    ),
  );
async function transaction<T>(
  db: Database,
  work: (c: Pick<Database, 'query'>) => Promise<T>,
) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function acceptManualReview(
  c: Pick<Database, 'query'>,
  row: any,
  userId: string,
  task: 'category' | 'product',
) {
  if (!invalidAiReview(row)) return;
  const resolution = { ...row.ai_resolution };
  for (const key of ['product', 'category']) {
    if (resolution[key]?.action !== 'invalid') continue;
    resolution[key] = {
      action: 'manual_confirmed',
      automatic: false,
      reviewedBy: userId,
      reviewedAt: new Date().toISOString(),
      confirmedTask: task,
      reason: 'Marcação da IA substituída pela revisão manual.',
      previousDecision: resolution[key],
    };
  }
  await c.query('UPDATE discovery_links SET ai_resolution=$2 WHERE id=$1', [
    row.id, JSON.stringify(resolution),
  ]);
  await audit(c, userId, 'discovery.invalid.overridden', row.id);
}
async function createManualProductDraft(
  c: Pick<Database, 'query'>,
  row: any,
  product: z.infer<typeof newProduct>,
  userId: string,
) {
  const id = randomUUID();
  // A manual "new" decision must not silently match another product by name.
  const draft = (await c.query(
    'INSERT INTO review_ai_product_drafts(id,identity_key,name,description,brand,image_url,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [id, 'manual:' + id, product.name, product.description, product.brand, product.imageUrl, userId],
  )).rows[0];
  await acceptManualReview(c, row, userId, 'product');
  const link = (await c.query(
    'UPDATE discovery_links SET product_id=NULL,product_draft_id=$2,product_assigned_by=NULL,product_assigned_at=NULL,enrichment_version=enrichment_version+1 WHERE id=$1 RETURNING *',
    [row.id, draft.id],
  )).rows[0];
  await audit(c, userId, 'discovery.product.drafted', row.id);
  return {draft, link, status: 'awaiting_category'};
}
async function confirmUnassignedCategory(
  c: Pick<Database, 'query'>,
  row: any,
  categoryId: string,
  userId: string,
) {
  if (row.product_draft_id) {
    await finalizeCatalogDraft(c, row.product_draft_id, categoryId, userId);
  } else {
    await c.query(
      'UPDATE discovery_links SET catalog_resolution=jsonb_build_object(),confirmed_category_id=$2,category_confirmed_by=$3,category_confirmed_at=clock_timestamp(),enrichment_version=enrichment_version+1 WHERE id=$1',
      [row.id, categoryId, userId],
    );
  }
}
async function applyMappingToPending(
  c: Pick<Database, 'query'>,
  source: any,
  categoryId: string,
  userId: string,
) {
  const candidates = (
    await c.query(
      `SELECT id FROM discovery_links WHERE marketplace_id=$1 AND source_category_key=$2
     AND status='pending' AND published_offer_id IS NULL AND extraction_status='completed'
     AND confirmed_category_id IS NULL AND product_id IS NULL ORDER BY id`,
      [source.marketplace_id, source.source_category_key],
    )
  ).rows;
  for (const candidate of candidates) {
    // Recheck after locking: another confirmation or a shared draft may have resolved this link.
    const row = (
      await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE', [candidate.id])
    ).rows[0];
    if (
      row?.status !== 'pending' || row.published_offer_id ||
      row.extraction_status !== 'completed' || row.confirmed_category_id ||
      row.product_id || invalidAiReview(row) ||
      row.source_category_key !== source.source_category_key ||
      row.marketplace_id !== source.marketplace_id
    ) continue;
    await confirmUnassignedCategory(c, row, categoryId, userId);
    await audit(c, userId, 'discovery.category.mapping_applied', row.id);
  }
}
export function registerEnrichmentAdmin(app: Express, db: Database) {
  const base = '/api/admin/discovery/enrichment';
  app.post(base + '/review/:id/retry', async (req, res) => {
    z.strictObject({}).parse(req.body ?? {});
    const id = uuid.parse(req.params.id);
    const link = (
      await db.query('SELECT marketplace_id FROM discovery_links WHERE id=$1', [
        id,
      ])
    ).rows[0];
    if (!link) {
      throw new HttpError(404, 'Link não encontrado.');
    }

    const updated = await db.query(
      "UPDATE discovery_links SET extraction_status='pending',extraction_error=NULL,enrichment_version=enrichment_version+1 WHERE id=$1 AND status='pending' AND (extraction_status='failed' OR (extraction_status='completed' AND (ai_resolution->'product'->>'action'='invalid' OR ai_resolution->'category'->>'action'='invalid'))) AND published_offer_id IS NULL RETURNING id",
      [id],
    );
    if (!updated.rows.length) {
      throw new HttpError(409, 'Não há falha elegível para retentativa.');
    }
    await audit(db, req.user!.id, 'discovery.retry_marked', id);
    res.status(202).json({ id, status: 'pending', executor: 'extension' });
  });
  app.post(base + '/review/:id/archive', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await transaction(db, async (c) => {
      if (
        !(
          await c.query(
            "UPDATE discovery_links SET status='archived' WHERE id=$1 RETURNING id",
            [id],
          )
        ).rows.length
      ) {
        throw new HttpError(404, 'Link não encontrado.');
      }
      await audit(c, req.user!.id, 'discovery.link.archived', id);
    });
    res.json({ ok: true });
  });
  app.get(base + '/categories', async (_req, res) =>
    res.json(
      (
        await db.query(
          'SELECT id,path FROM category_nodes ORDER BY normalized_path',
        )
      ).rows,
    ),
  );
  app.post(base + '/categories', async (req, res) => {
    const { categoryPath } = z
      .strictObject({ categoryPath: z.array(requiredCategory).min(1).max(10) })
      .parse(req.body);
    const result = await transaction(db, async (c) => {
      const row = (
        await c.query(
          'SELECT names,ids FROM register_category_path($1::text[])',
          [categoryPath],
        )
      ).rows[0];
      const nodes = (row.ids as string[]).map((id, index) => ({
        id,
        path: (row.names as string[]).slice(0, index + 1),
      }));
      const leaf = nodes.at(-1)!;
      await audit(c, req.user!.id, 'discovery.category_tree.created', leaf.id);
      return { ...leaf, nodes };
    });
    res.status(201).json(result);
  });
  app.get(base + '/review', async (req, res) => {
    const f = z
      .object({
        marketplaceId: marketId.or(z.literal('')).default(''),
        sourceCategory: z.string().max(1000).default(''),
        state: z
          .enum(['', ...reviewStates])
          .default(''),
      })
      .parse(req.query);
    res.json(
      await pagedQuery(
        db,
        { ...req.query, paginate: 'true' },
        `SELECT l.*,${reviewStatusSql} AS review_status,p.name AS product_name,p.sku AS product_sku,d.name AS draft_name,d.description AS draft_description,d.brand AS draft_brand,d.image_url AS draft_image_url,m.name AS marketplace_name,ac.suggestion AS ai_category,ac.request_id AS ai_category_request,ap.suggestion AS ai_product,ap.request_id AS ai_product_request,cm.id AS mapping_id,cm.category_id AS suggested_category_id,n.path AS suggested_category_path,confirmed.path AS confirmed_category_path
   FROM discovery_links l
 LEFT JOIN review_ai_suggestions ac ON ac.link_id=l.id AND ac.task='category' AND ac.link_version=l.enrichment_version AND ac.settings_version=(SELECT category_version FROM review_ai_settings WHERE id=true)
 LEFT JOIN review_ai_suggestions ap ON ap.link_id=l.id AND ap.task='product' AND ap.link_version=l.enrichment_version AND ap.settings_version=(SELECT product_version FROM review_ai_settings WHERE id=true)
 LEFT JOIN review_ai_product_drafts d ON d.id=l.product_draft_id
 JOIN marketplaces m ON m.id=l.marketplace_id LEFT JOIN category_mappings cm ON cm.marketplace_id=l.marketplace_id AND cm.source_key=l.source_category_key
   LEFT JOIN category_nodes n ON n.id=cm.category_id LEFT JOIN category_nodes confirmed ON confirmed.id=l.confirmed_category_id LEFT JOIN products p ON p.id=l.product_id
   LEFT JOIN offers publication ON publication.id=l.published_offer_id
   LEFT JOIN scraping_profiles profile ON profile.marketplace_id=l.marketplace_id
   WHERE (l.status<>'archived' OR $2='archived') AND ($1='' OR l.marketplace_id=$1)
 AND ($2='' OR (${reviewStatusSql})=$2)
 AND ($3='' OR position(lower($3) in lower(array_to_string(l.source_category_path,' > ')))>0) ORDER BY l.first_seen_at,l.id`,
        [f.marketplaceId, f.state, f.sourceCategory],
      ),
    );
  });
  app.get(base + '/review/:id/products', async (req, res) => {
    await reviewableLink(db, uuid.parse(req.params.id));
    const q = z.string().max(160).default('').parse(req.query.q);
    const search =
      '%' +
      q
        .replaceAll('\\', '\\\\')
        .replaceAll('%', String.raw`\%`)
        .replaceAll('_', String.raw`\_`) +
      '%';
    res.json(
      await pagedQuery(
        db,
        { ...req.query, paginate: 'true' },
        'SELECT p.* FROM products p WHERE p.name ILIKE $1 OR p.sku ILIKE $1 ORDER BY p.name,p.id',
        [search],
      ),
    );
  });
  app.post(base + '/review/:id/product', async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = assignment.parse(req.body);
    const result = await transaction(db, async (c) => {
      const row = await reviewableLink(c, id, true);
      if (row.enrichment_version !== v.version) {
        throw new HttpError(
          409,
          'Os dados foram atualizados. Reabra a revisão.',
        );
      }
      const category = (
        await c.query('SELECT path FROM category_nodes WHERE id=$1', [
          row.confirmed_category_id,
        ])
      ).rows[0];
      if (v.mode === 'new' && !category)
        return createManualProductDraft(c, row, v.product, req.user!.id);
      let product;
      if (v.mode === 'existing') {
        // NOWAIT avoids a lock cycle with catalog recategorization, which also invalidates assignments.
        try {
          product = (
            await c.query(
              'SELECT * FROM products WHERE id=$1 FOR SHARE NOWAIT',
              [v.productId],
            )
          ).rows[0];
        } catch (error) {
          if ((error as { code?: string }).code === '55P03') {
            throw new HttpError(
              409,
              'O produto está sendo alterado. Tente novamente.',
            );
          }
          throw error;
        }
        if (!product) {
          throw new HttpError(404, 'Produto não encontrado.');
        }
      } else {
        const p = v.product,
          path = category.path;
        product = (
          await c.query(
            'INSERT INTO products(id,name,description,brand,category,subcategory,image_url,category_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
            [
              randomUUID(),
              p.name,
              p.description,
              p.brand,
              path[0],
              path[1] ?? '',
              p.imageUrl,
              path,
            ],
          )
        ).rows[0];
        await audit(c, req.user!.id, 'product.created', product.id);
      }
      await acceptManualReview(c, row, req.user!.id, 'product');
      await assignCatalogProduct(c, id, product, req.user!.id);
      return { product, status: 'ready_for_review' };
    });
    res.json(result);
  });
  app.post(base + '/review/:id/category', async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z
        .strictObject({
          categoryId: uuid,
          version: z.number().int().nonnegative(),
          saveMapping: z.boolean().default(false),
        })
        .parse(req.body);
    await transaction(db, async (c) => {
      // Serialize manual confirmations before taking link locks, including overlapping mappings.
      await c.query('SELECT pg_advisory_xact_lock(73914203)');
      // Same lock order as the worker prevents a confirmation/extraction race.
      const row = (
        await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (
        row?.status !== 'pending' ||
        row.published_offer_id ||
        row.extraction_status !== 'completed'
      ) {
        throw new HttpError(
          409,
          'Conclua a extração de um link pendente e não publicado antes de categorizar.',
        );
      }
      if (row.enrichment_version !== v.version) {
        throw new HttpError(
          409,
          'Os dados foram atualizados. Reabra a revisão.',
        );
      }
      if (
        !(
          await c.query('SELECT id FROM category_nodes WHERE id=$1', [
            v.categoryId,
          ])
        ).rows.length
      ) {
        throw new HttpError(400, 'Categoria não encontrada.');
      }
      if (v.saveMapping && !row.source_category_path.length) {
        throw new HttpError(
          400,
          'Sem árvore de origem; aplique apenas neste item.',
        );
      }
      await acceptManualReview(c, row, req.user!.id, 'category');
      if (v.saveMapping) {
        await c.query(
          'INSERT INTO category_mappings(id,marketplace_id,source_path,source_key,category_id,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(marketplace_id,source_key) DO UPDATE SET category_id=$5,updated_by=$6,updated_at=clock_timestamp()',
          [
            randomUUID(),
            row.marketplace_id,
            row.source_category_path,
            row.source_category_key,
            v.categoryId,
            req.user!.id,
          ],
        );
      }
      if (row.product_id) {
        const category = (
          await c.query('SELECT path FROM category_nodes WHERE id=$1', [
            v.categoryId,
          ])
        ).rows[0];
        const affected = (
          await c.query(
            'SELECT id FROM discovery_links WHERE product_id=$1 ORDER BY id FOR UPDATE',
            [row.product_id],
          )
        ).rows;
        const product = (
          await c.query(
            'UPDATE products SET category_path=$2,category=$3,subcategory=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING *',
            [
              row.product_id,
              category.path,
              category.path[0],
              category.path[1] ?? '',
            ],
          )
        ).rows[0];
        for (const link of affected)
          await assignCatalogProduct(c, link.id, product, req.user!.id);
      } else {
        await confirmUnassignedCategory(c, row, v.categoryId, req.user!.id);
      }
      if (v.saveMapping)
        await applyMappingToPending(c, row, v.categoryId, req.user!.id);
      await audit(c, req.user!.id, 'discovery.category.confirmed', id);
    });
    res.json({ ok: true });
  });
  app.get(base + '/mappings', async (req, res) =>
    res.json(
      await pagedQuery(
        db,
        { ...req.query, paginate: 'true' },
        `SELECT cm.*,m.name AS marketplace_name,n.path AS category_path FROM category_mappings cm JOIN marketplaces m ON m.id=cm.marketplace_id JOIN category_nodes n ON n.id=cm.category_id WHERE ($1='' OR cm.marketplace_id=$1) ORDER BY cm.updated_at DESC,cm.id`,
        [marketId.or(z.literal('')).default('').parse(req.query.marketplaceId)],
      ),
    ),
  );
  app.put(base + '/mappings/:id', async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z.strictObject({ categoryId: uuid }).parse(req.body);
    await transaction(db, async (c) => {
      if (
        !(
          await c.query('SELECT id FROM category_nodes WHERE id=$1', [
            v.categoryId,
          ])
        ).rows.length
      ) {
        throw new HttpError(400, 'Categoria não encontrada.');
      }
      if (
        !(
          await c.query(
            'UPDATE category_mappings SET category_id=$2,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING id',
            [id, v.categoryId, req.user!.id],
          )
        ).rows.length
      ) {
        throw new HttpError(404, 'Mapeamento não encontrado.');
      }
      await audit(c, req.user!.id, 'discovery.mapping.updated', id);
    });
    res.json({ ok: true });
  });
  app.delete(base + '/mappings/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    await transaction(db, async (c) => {
      if (
        !(
          await c.query(
            'DELETE FROM category_mappings WHERE id=$1 RETURNING id',
            [id],
          )
        ).rows.length
      ) {
        throw new HttpError(404, 'Mapeamento não encontrado.');
      }
      await audit(c, req.user!.id, 'discovery.mapping.deleted', id);
    });
    res.json({ ok: true });
  });
}
