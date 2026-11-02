import type { Database } from './db.js';

// The caller holds the run lock. The limit includes completed/reserved work;
// lowering it may remove only queue entries that have never been attempted.
export async function resizeResolverQueue(c: Pick<Database, 'query'>, run: any, limit: number) {
  if (!['running', 'paused'].includes(run.status)) return run;
  const retained = (await c.query(
    `SELECT count(*)::int AS n FROM catalog_resolver_items WHERE run_id=$1 AND link_id IS NOT NULL AND (status<>'queued' OR attempts>0 OR context IS NOT NULL)`,
    [run.id],
  )).rows[0].n;
  await c.query(
    `DELETE FROM catalog_resolver_items WHERE id IN (
      SELECT i.id FROM catalog_resolver_items i JOIN discovery_links l ON l.id=i.link_id
      WHERE i.run_id=$1 AND i.status='queued' AND i.attempts=0 AND i.context IS NULL
      ORDER BY l.first_seen_at,l.id OFFSET $2
    )`,
    [run.id, Math.max(0, limit - retained)],
  );
  const total = (await c.query('SELECT count(*)::int AS n FROM catalog_resolver_items WHERE run_id=$1 AND link_id IS NOT NULL', [run.id])).rows[0].n;
  await c.query(
    `INSERT INTO catalog_resolver_items(id,run_id,link_id)
     SELECT gen_random_uuid(),$1,l.id FROM discovery_links l
     WHERE l.marketplace_id=$2 AND l.status='pending' AND l.published_offer_id IS NULL
       AND NULLIF(trim(l.affiliate_url),'') IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM catalog_resolver_items i WHERE i.run_id=$1 AND i.link_id=l.id)
       AND (($3='product' AND l.product_id IS NULL AND l.product_draft_id IS NULL)
         OR ($3='category' AND l.product_id IS NULL AND (l.product_draft_id IS NOT NULL
           OR ($5='shadow' AND EXISTS(SELECT 1 FROM catalog_resolver_receipts receipt WHERE receipt.link_id=l.id AND receipt.task='product' AND receipt.result->>'mode'='shadow' AND receipt.result->>'outcome'='drafted')))))
     ORDER BY l.first_seen_at,l.id LIMIT $4`,
    [run.id, run.marketplace_id, run.task, Math.max(0, limit - total), run.mode],
  );
  return run;
}
