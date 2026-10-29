import type { Express } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';

export const sitemapPageSize = 1000;
const visible = "o.status='published' AND o.availability_status='available' AND o.affiliate_url IS NOT NULL";
// Only identifiers of publicly listed records. No drafts, tracking URLs or account data.
const entries = `WITH listed AS (
 SELECT p.id,p.category_ids,greatest(p.updated_at,(SELECT max(o.updated_at) FROM offers o WHERE o.product_id=p.id AND ${visible})) AS updated_at FROM products p
 WHERE EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id AND ${visible})
), entries AS (
 SELECT 'product' AS type,id,updated_at FROM listed
 UNION ALL
 SELECT 'category' AS type,c.id,max(p.updated_at) AS updated_at
 FROM category_nodes c JOIN listed p ON c.id=ANY(p.category_ids) GROUP BY c.id
) `;
export function registerPublicSeo(app: Express, db: Database) {
 app.get('/api/seo/sitemap', async (req,res) => {
  const page=z.coerce.number().int().min(1).max(10000).default(1).parse(req.query.page);
  const total=(await db.query(entries+'SELECT count(*)::int AS total FROM entries')).rows[0].total;
  const items=(await db.query(entries+'SELECT type,id,updated_at FROM entries ORDER BY type,id LIMIT $1 OFFSET $2',[sitemapPageSize,(page-1)*sitemapPageSize])).rows;
  res.set('Cache-Control','public, max-age=300').json({items,page,pageSize:sitemapPageSize,total,totalPages:Math.ceil(total/sitemapPageSize)});
 });
}
