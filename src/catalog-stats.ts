import {z} from 'zod';
import type {Database} from './db.js';
import type {CatalogActor} from './catalog-contracts.js';
import {HttpError} from './security.js';
import {publishedPriceOfferSql,priceRefreshDueSql} from './catalog-price-policy.js';

export async function catalogStats(db:Pick<Database,'query'>,actor:CatalogActor,input:unknown){
 const query=z.strictObject({marketplaceId:z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),retryFailed:z.enum(['true','false']).default('false')}).parse(input);
 const market=(await db.query('SELECT id FROM marketplaces WHERE id=$1 AND scraping_enabled',[query.marketplaceId])).rows[0];
 if(!market)throw new HttpError(404,'Marketplace não encontrado.');
 const result=(await db.query(`WITH links AS (
  SELECT count(*)::int AS total_links,
   count(*) FILTER (WHERE affiliate_url IS NOT NULL)::int AS convert_completed,
   count(*) FILTER (WHERE extraction_status='completed')::int AS enrich_completed,
   count(*) FILTER (WHERE published_offer_id IS NULL AND affiliate_url IS NULL)::int AS convert_pending,
   count(*) FILTER (WHERE published_offer_id IS NULL AND affiliate_url IS NOT NULL AND (extraction_status='pending' OR ($2 AND extraction_status='failed')))::int AS enrich_pending
  FROM discovery_links WHERE marketplace_id=$1 AND status='pending'
 ), prices AS (
  SELECT count(*)::int AS total_prices,
   count(*) FILTER (WHERE ${priceRefreshDueSql})::int AS prices_pending
  FROM offers WHERE marketplace_id=$1 AND ${publishedPriceOfferSql}
 ) SELECT links.*,prices.*,clock_timestamp() AS observed_at FROM links CROSS JOIN prices`,[query.marketplaceId,query.retryFailed==='true'])).rows[0];
 return {
  marketplaceId:query.marketplaceId,retryFailed:query.retryFailed==='true',observedAt:result.observed_at,
  convert:{pending:result.convert_pending,completed:result.convert_completed,total:result.total_links},
  enrich:actor.permissions.includes('catalog')?{pending:result.enrich_pending,completed:result.enrich_completed,total:result.total_links}:null,
  prices:actor.permissions.includes('updates')?{pending:result.prices_pending,total:result.total_prices}:null
 };
}
