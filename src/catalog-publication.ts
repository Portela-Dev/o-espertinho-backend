import type {Express} from 'express';
import type {Database} from './db.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {catalogTransaction} from './catalog-runs.js';
import {marketUrl} from './scraping.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {recordDailyPrice} from './price-history.js';
export const publishBatchInput=z.strictObject({authorizedContent:z.literal(true),items:z.array(z.strictObject({id:z.uuid(),version:z.number().int().nonnegative()})).min(1).max(100)});
const publishInput=z.strictObject({version:z.number().int().nonnegative(),authorizedContent:z.literal(true)});
async function publishCandidate(db:Database,userId:string,id:string,version:number){
  return catalogTransaction(db,async c=>{
   const link=(await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!link)throw new HttpError(404,'Link não encontrado.');
   if(link.published_offer_id)return {offerId:link.published_offer_id,alreadyPublished:true};
   if(link.status!=='pending'||link.enrichment_version!==version||link.extraction_status!=='completed'||!link.confirmed_category_id||!link.product_id||!link.affiliate_url)throw new HttpError(409,'Confirme categoria, produto e informações antes de publicar.');
   const product=(await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE NOWAIT',[link.product_id])).rows[0];
   if(!product?.category_ids.includes(link.confirmed_category_id))throw new HttpError(409,'O produto não pertence à categoria confirmada.');
   const market=(await c.query('SELECT id,name,website_url,logo_url,allowed_hosts,scraping_enabled,url_normalization_rules,catalog_executor,updated_at FROM marketplaces WHERE id=$1 FOR SHARE',[link.marketplace_id])).rows[0];
   if(!market.scraping_enabled)throw new HttpError(409,'Marketplace desativado.');
   marketUrl(link.affiliate_url,market.allowed_hosts);marketUrl(link.url,market.allowed_hosts);
   const profile=(await c.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1',[market.id])).rows[0],data=link.enrichment_data;
   if(!profile||!data?.title||data.missing?.length||!Number.isInteger(data.priceCents)||data.priceCents<=0)throw new HttpError(409,'Os dados obrigatórios estão incompletos.');
   const expires=new Date(new Date(link.extracted_at).getTime()+profile.validity_minutes*60000);
   if(expires.getTime()<=Date.now())throw new HttpError(409,'Os dados perderam a validade. Extraia novamente antes de publicar.');
   const offerId=randomUUID();
   await c.query(`INSERT INTO offers(id,marketplace_id,external_id,title,description,category,subcategory,category_path,image_url,images,product_url,affiliate_url,price_cents,original_price_cents,source,status,published_at,conditions,expires_at,product_id,specifications,extraction_metadata,data_updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'scraped','published',clock_timestamp(),$15,$16,$17,$18,$19,$20)`,[offerId,market.id,link.id,data.title,data.description,product.category,product.subcategory,product.category_path,data.images[0]??null,JSON.stringify(data.images),link.url,link.affiliate_url,data.priceCents,data.originalPriceCents,data.conditions,expires,product.id,JSON.stringify(data.specifications),JSON.stringify({collectedAt:link.extracted_at,source:'extension'}),link.extracted_at]);
   await c.query('UPDATE discovery_links SET published_offer_id=$2,enrichment_version=enrichment_version+1 WHERE id=$1',[link.id,offerId]);
   await recordDailyPrice(c,offerId,product.id,data.priceCents,new Date(link.extracted_at).toISOString());
   await audit(c,userId,'discovery.published',link.id);return {offerId,alreadyPublished:false};
  });
}
export function registerCatalogPublication(app:Express,db:Database){
 app.post('/api/admin/discovery/enrichment/review/publish-batch',async(req,res)=>{
  const v=publishBatchInput.parse(req.body);
  if(new Set(v.items.map(i=>i.id)).size!==v.items.length)throw new HttpError(400,'Selecione cada link apenas uma vez.');
  const results=[];
  for(const item of v.items){
   try{results.push({id:item.id,ok:true,...await publishCandidate(db,req.user!.id,item.id,item.version)});}
   catch(error){if(!(error instanceof HttpError))throw error;results.push({id:item.id,ok:false,status:error.status,message:error.message});}
  }
  res.json({results,published:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length});
 });
 app.post('/api/admin/discovery/enrichment/review/:id/publish',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),input=publishInput.parse(req.body);
  res.json(await publishCandidate(db,req.user!.id,id,input.version));
 });
}
