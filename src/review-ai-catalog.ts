import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
export type CatalogQuery = Pick<Database, 'query'>;
export const identityKey = (name: string, brand = '') =>
  [name, brand]
    .map((s) =>
      s
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    )
    .join('|');
export async function assignCatalogProduct(
  c: CatalogQuery,
  linkId: string,
  product: any,
  userId: string,
) {
  const categoryId = product.category_ids.at(-1);
  // Category changes invalidate assignment in a BEFORE trigger, so use two writes inside the transaction.
  await c.query(
    'UPDATE discovery_links SET confirmed_category_id=$2,category_confirmed_by=$3,category_confirmed_at=clock_timestamp() WHERE id=$1',
    [linkId, categoryId, userId],
  );
  await c.query(
    'UPDATE discovery_links SET catalog_resolution=jsonb_build_object(),product_id=$2,product_draft_id=NULL,product_assigned_by=$3,product_assigned_at=clock_timestamp(),enrichment_version=enrichment_version+1 WHERE id=$1',
    [linkId, product.id, userId],
  );
  await audit(c, userId, 'discovery.product.assigned', linkId);
}
export async function finalizeCatalogDraft(
  c: CatalogQuery,
  draftId: string,
  categoryId: string,
  userId: string,
) {
  const draft = (
    await c.query(
      'SELECT * FROM review_ai_product_drafts WHERE id=$1 FOR UPDATE',
      [draftId],
    )
  ).rows[0];
  if (!draft || draft.product_id)
    throw new HttpError(
      409,
      'O rascunho já foi resolvido. Atualize a revisão.',
    );
  const category = (
    await c.query('SELECT path FROM category_nodes WHERE id=$1', [categoryId])
  ).rows[0];
  if (!category) throw new HttpError(400, 'Categoria não encontrada.');
  let product = draft.personalized_kit
    ? null
    : (
        await c.query(
          'SELECT * FROM products WHERE personalized_kit=false ORDER BY id',
        )
      ).rows.find((p) => identityKey(p.name, p.brand) === draft.identity_key);
  if (!product) {
    product = (
      await c.query(
        'INSERT INTO products(id,name,description,brand,image_url,category_path,category,subcategory,personalized_kit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [
          randomUUID(),
          draft.name,
          draft.description,
          draft.brand,
          draft.image_url,
          category.path,
          category.path[0],
          category.path[1] ?? '',
          draft.personalized_kit,
        ],
      )
    ).rows[0];
    await audit(c, userId, 'product.created', product.id);
  }
  const links = (
    await c.query(
      "SELECT id FROM discovery_links WHERE product_draft_id=$1 AND product_id IS NULL AND status='pending' AND published_offer_id IS NULL AND extraction_status='completed' AND COALESCE(ai_resolution->'product'->>'action','')<>'invalid' AND COALESCE(ai_resolution->'category'->>'action','')<>'invalid' ORDER BY id FOR UPDATE",
      [draftId],
    )
  ).rows;
  for (const link of links)
    await assignCatalogProduct(c, link.id, product, userId);
  await c.query(
    'UPDATE discovery_links SET product_draft_id=NULL,enrichment_version=enrichment_version+1 WHERE product_draft_id=$1 AND product_id IS NULL',
    [draftId],
  );
  await c.query(
    'UPDATE review_ai_product_drafts SET product_id=$2,version=version+1 WHERE id=$1',
    [draftId, product.id],
  );
  await audit(c, userId, 'review_ai.draft_finalized', draftId);
  return {
    outcome: 'categorized',
    product,
    removeDraftIds: [draftId],
    affectedLinks: links.length,
  };
}
export async function resolveAiCategory(c: CatalogQuery, suggestion: any) {
  if (suggestion.action === 'use_category') {
    const category = (
      await c.query('SELECT id,path FROM category_nodes WHERE id=$1', [
        suggestion.categoryId,
      ])
    ).rows[0];
    if (!category)
      throw new HttpError(409, 'Categoria inexistente no inventário.');
    return category;
  }
  const path = z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(10)
    .parse(suggestion.category.split('>').map((p: string) => p.trim()));
  const existing = (
    await c.query('SELECT id,path FROM category_nodes WHERE catalog_category_key(path)=catalog_category_key($1::text[]) ORDER BY id LIMIT 1', [path])
  ).rows[0];
  if (existing) return existing;
  const registered = (
    await c.query('SELECT names,ids FROM register_category_path($1::text[])', [
      path,
    ])
  ).rows[0];
  return { id: registered.ids.at(-1), path: registered.names };
}
