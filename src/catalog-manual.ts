import type {Express} from 'express';
import type {Database} from './db.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {catalogTransaction,expireRuns,runView} from './catalog-runs.js';
import {getCatalogSettings,legacyBusy} from './catalog-settings.js';
import {marketUrl,type ScrapingProfile} from './scraping.js';
import {normalizeProductUrl} from './url-normalization.js';
import {resolveClassification} from './classifications.js';
import {HttpError} from './security.js';
export async function requestManualExtraction(db:Database,actorId:string,marketplaceId:string,url:string,profile:ScrapingProfile,details:{productId?:string;sellerName?:string}={}){
 return catalogTransaction(db,async c=>{
  const market=(await c.query('SELECT * FROM marketplaces WHERE id=$1 FOR UPDATE',[marketplaceId])).rows[0];
  if(!market?.scraping_enabled||market.catalog_executor!=='extension')throw new HttpError(409,'Ative a extração pela extensão.');
  marketUrl(url,market.allowed_hosts);await expireRuns(c);
  if(await legacyBusy(c,marketplaceId)||(await c.query("SELECT id FROM extension_catalog_runs WHERE marketplace_id=$1 AND status NOT IN ('completed','failed','cancelled')",[marketplaceId])).rows.length)throw new HttpError(409,'Já existe uma execução para este marketplace. Conclua ou cancele antes de solicitar a prévia.');
  const settings=await getCatalogSettings(c,marketplaceId),id=randomUUID();
  const product=details.productId?(await c.query('SELECT id,updated_at FROM products WHERE id=$1',[details.productId])).rows[0]:null;
  if(details.productId&&!product)throw new HttpError(404,'Produto não encontrado.');
  const snapshot={schemaVersion:1,market:{id:market.id,allowedHosts:market.allowed_hosts,normalizationRules:market.url_normalization_rules},settings:settings.config,profile};
  await c.query("INSERT INTO extension_catalog_runs(id,marketplace_id,created_by,step,snapshot,request_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '15 minutes')",[id,marketplaceId,actorId,product?'preview':'selector_test',JSON.stringify(snapshot),randomUUID()]);
  await c.query('INSERT INTO extension_catalog_items(id,run_id,payload) VALUES($1,$2,$3)',[randomUUID(),id,JSON.stringify({url,originalUrl:normalizeProductUrl(url,market.url_normalization_rules),...details,productUpdatedAt:product?.updated_at})]);
  return {executionId:id,status:'queued',expiresAt:new Date(Date.now()+900000).toISOString(),message:'Abra a extensão, carregue as execuções e selecione esta prévia.'};
 });
}
export function registerCatalogManual(app:Express,db:Database){
 app.get('/api/admin/extension-catalog/manual/:id',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);
  const response=await catalogTransaction(db,async c=>{
   await expireRuns(c);const run=(await c.query("SELECT * FROM extension_catalog_runs WHERE id=$1 AND created_by=$2 AND step IN ('preview','selector_test') FOR UPDATE",[id,req.user!.id])).rows[0];
   if(!run)throw new HttpError(404,'Solicitação não encontrada.');
   if(run.status!=='completed')return {executionId:id,status:run.status,reason:run.reason};
   const item=(await c.query('SELECT * FROM extension_catalog_items WHERE run_id=$1',[id])).rows[0];
   if(item.status!=='completed'||!item.result?.data)return {executionId:id,status:'failed',reason:'incomplete'};
   const data=item.result.data;data.collectedAt=new Date(item.observed_at).toISOString();
   const market=(await c.query('SELECT * FROM marketplaces WHERE id=$1',[run.marketplace_id])).rows[0];
   data.productUrl=normalizeProductUrl(marketUrl(data.productUrl,market.allowed_hosts),market.url_normalization_rules);
   if(run.step==='selector_test')return {executionId:id,status:'completed',data,isTest:true,canConfirm:false,marketplaceName:market.name,affiliateUrl:item.payload.url};
   const existing=(await c.query('SELECT * FROM offer_import_previews WHERE id=$1',[id])).rows[0];
   const product=(await c.query('SELECT * FROM products WHERE id=$1',[item.payload.productId])).rows[0];
   if(!product||new Date(product.updated_at).getTime()!==new Date(item.payload.productUpdatedAt).getTime())throw new HttpError(409,'Produto alterado. Solicite outra prévia.');
   Object.assign(data,await resolveClassification(c,product.category,product.subcategory),{sellerName:item.payload.sellerName??''});
   const expiresAt=existing?.expires_at??new Date(Date.now()+900000);
   if(!existing)await c.query('INSERT INTO offer_import_previews(id,user_id,marketplace_id,affiliate_url,source_url,result,profile_version,expires_at,product_id,product_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,run.created_by,market.id,item.payload.url,data.productUrl,JSON.stringify(data),run.snapshot.profile.version,expiresAt,product.id,product.updated_at]);
   return {executionId:id,status:'completed',previewId:id,product,marketplaceId:market.id,marketplaceName:market.name,affiliateUrl:item.payload.url,data,expiresAt,canConfirm:!data.missing.length&&!!data.priceCents};
  });res.json(response);
 });
 app.post('/api/admin/extension-catalog/manual/:id/cancel',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);const r=await db.query("UPDATE extension_catalog_runs SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1 AND created_by=$2 AND step IN ('preview','selector_test') AND status NOT IN ('completed','cancelled','failed') RETURNING id",[id,req.user!.id]);if(!r.rows.length)throw new HttpError(409,'Solicitação encerrada ou não encontrada.');res.json({ok:true});
 });
}
