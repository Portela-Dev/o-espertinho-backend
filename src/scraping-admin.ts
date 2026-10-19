import {urlNormalizationRulesSchema,normalizeProductUrl} from './url-normalization.js';
import {pagedQuery} from './pagination.js';
import {productUrl} from './product-url.js';
import type {Express} from 'express';
import {getProduct} from './products.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {classificationText,resolveClassification} from './classifications.js';
import {profileSchema,validHost,marketUrl,type OfferExtractor} from './scraping.js';
const id=z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
const marketSchema=z.object({id,name:z.string().trim().min(2).max(80),websiteUrl:z.url(),logoUrl:z.string().trim().max(2000).refine(value=>{if(!value)return true;try{const url=new URL(value);if(!validHost(url.hostname))return false;marketUrl(value,[url.hostname]);return true;}catch{return false;}},'Informe uma URL HTTPS pública de imagem.').optional(),allowedHosts:z.array(z.string().trim().toLowerCase().refine(validHost,'Informe um domínio público, sem protocolo ou caminho.')).min(1).max(20),scrapingEnabled:z.boolean(),urlNormalizationRules:urlNormalizationRulesSchema.optional()}).superRefine((v,ctx)=>{try{marketUrl(v.websiteUrl,v.allowedHosts);}catch{ctx.addIssue({code:'custom',message:'O site deve usar HTTPS e um dos domínios informados.',path:['websiteUrl']});}});
export async function assertRegisteredLink(db:Database,marketId:string,url:string){const row=(await db.query('SELECT allowed_hosts FROM marketplaces WHERE id=$1',[marketId])).rows[0];if(!row)throw new HttpError(400,'Marketplace não encontrado.');return marketUrl(url,row.allowed_hosts);}
export function registerScrapingAdmin(app:Express,db:Database,extractor:OfferExtractor){
 app.get('/api/admin/catalog-marketplaces',async(req,res)=>res.json(await pagedQuery(db,req.query,'SELECT id,name,website_url,logo_url,allowed_hosts,scraping_enabled,url_normalization_rules FROM marketplaces ORDER BY name,id')));
 app.post('/api/admin/catalog-marketplaces',async(req,res)=>{const v=marketSchema.parse(req.body);await db.query('INSERT INTO marketplaces(id,name,website_url,allowed_hosts,scraping_enabled,logo_url,url_normalization_rules) VALUES($1,$2,$3,$4,$5,$6,$7)',[v.id,v.name,v.websiteUrl,v.allowedHosts,v.scrapingEnabled,v.logoUrl??'',JSON.stringify(v.urlNormalizationRules??[])]);await audit(db,req.user!.id,'catalog_marketplace.created',v.id);res.status(201).json({ok:true});});
 app.put('/api/admin/catalog-marketplaces/:id',async(req,res)=>{const v=marketSchema.parse({...req.body,id:req.params.id});const result=await db.query('UPDATE marketplaces SET name=$2,website_url=$3,allowed_hosts=$4,scraping_enabled=$5,logo_url=COALESCE($6,logo_url),url_normalization_rules=COALESCE($7::jsonb,url_normalization_rules),updated_at=now() WHERE id=$1',[v.id,v.name,v.websiteUrl,v.allowedHosts,v.scrapingEnabled,v.logoUrl??null,v.urlNormalizationRules===undefined?null:JSON.stringify(v.urlNormalizationRules)]);if(!result.rowCount)throw new HttpError(404,'Marketplace não encontrado.');await audit(db,req.user!.id,'catalog_marketplace.updated',v.id);res.json({ok:true});});
 app.post('/api/admin/catalog-marketplaces/normalize-url',async(req,res)=>{
  const v=z.strictObject({url:z.url().max(10000),allowedHosts:z.array(z.string().trim().toLowerCase().refine(validHost)).min(1).max(20),rules:urlNormalizationRulesSchema}).parse(req.body);
  const original=marketUrl(v.url,v.allowedHosts);
  try{res.json({url:normalizeProductUrl(original,v.rules)});}catch{throw new HttpError(400,'A normalização removeria todo o caminho do produto. Confira os marcadores.');}
 });
 app.delete('/api/admin/catalog-marketplaces/:id',async(req,res)=>{const marketId=id.parse(req.params.id);if(['amazon','mercadolivre'].includes(marketId))throw new HttpError(409,'Os marketplaces integrados podem ser desativados, mas não excluídos.');try{await db.query('DELETE FROM marketplaces WHERE id=$1',[marketId]);}catch(e){if((e as any)?.code==='23503')throw new HttpError(409,'Este marketplace possui ofertas ou histórico. Desative-o em vez de excluir.');throw e;}await audit(db,req.user!.id,'catalog_marketplace.deleted',marketId);res.json({ok:true});});
 app.get('/api/admin/selectors/:id',async(req,res)=>{const marketId=id.parse(req.params.id);if(!(await db.query('SELECT id FROM marketplaces WHERE id=$1',[marketId])).rows.length)throw new HttpError(404,'Marketplace não encontrado.');res.json((await db.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1',[marketId])).rows[0]??{marketplace_id:marketId,rules:[],wait_timeout_ms:15000,validity_minutes:360,version:0});});
 app.post('/api/admin/selectors/:id/test',async(req,res)=>{const marketId=id.parse(req.params.id),v=z.object({url:z.url().max(10000),profile:profileSchema}).parse(req.body);const market=(await db.query('SELECT * FROM marketplaces WHERE id=$1',[marketId])).rows[0];if(!market)throw new HttpError(404,'Marketplace não encontrado.');marketUrl(v.url,market.allowed_hosts);const data=await extractor.extract(v.url,market,{rules:v.profile.rules,version:v.profile.version,wait_timeout_ms:v.profile.waitTimeoutMs,validity_minutes:v.profile.validityMinutes});res.json({data,marketplaceName:market.name,affiliateUrl:v.url,isTest:true,canConfirm:false});});
 app.put('/api/admin/selectors/:id',async(req,res)=>{
  const marketId=id.parse(req.params.id),v=profileSchema.parse(req.body);
  if(!(await db.query('SELECT id FROM marketplaces WHERE id=$1',[marketId])).rows.length)throw new HttpError(404,'Marketplace não encontrado.');
  const result=v.version===0?await db.query('INSERT INTO scraping_profiles(marketplace_id,rules,wait_timeout_ms,validity_minutes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING version',[marketId,JSON.stringify(v.rules),v.waitTimeoutMs,v.validityMinutes]):await db.query('UPDATE scraping_profiles SET rules=$2,wait_timeout_ms=$3,validity_minutes=$4,version=version+1,updated_at=now() WHERE marketplace_id=$1 AND version=$5 RETURNING version',[marketId,JSON.stringify(v.rules),v.waitTimeoutMs,v.validityMinutes,v.version]);
  if(!result.rows.length)throw new HttpError(409,'As regras foram alteradas em outra sessão. Recarregue antes de salvar.');await audit(db,req.user!.id,'selectors.updated',marketId);res.json({ok:true,version:result.rows[0].version});
 });
 app.post('/api/admin/link-imports/preview',async(req,res)=>{
  const v=z.object({marketplaceId:id,productId:z.uuid(),sellerName:z.string().trim().max(200).default(''),url:z.url().max(10000),category:classificationText.default(''),subcategory:classificationText.default('')}).parse(req.body);
  const product=await getProduct(db,v.productId);
  const market=(await db.query('SELECT * FROM marketplaces WHERE id=$1',[v.marketplaceId])).rows[0];if(!market?.scraping_enabled)throw new HttpError(409,'Ative a extração no cadastro desse marketplace.');
  marketUrl(v.url,market.allowed_hosts);
  const profile=(await db.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1',[v.marketplaceId])).rows[0];if(!profile?.rules?.length)throw new HttpError(409,'Cadastre os seletores desse marketplace antes de extrair.');
  const data=await extractor.extract(v.url,market,profile);const classification=await resolveClassification(db,product.category,product.subcategory);Object.assign(data,classification,{sellerName:v.sellerName});
  // URLs are validated again even for injected extractors used by tests.
  marketUrl(data.productUrl,market.allowed_hosts);
  data.productUrl=productUrl(data.productUrl);
  const previewId=randomUUID(),expiresAt=new Date(Date.now()+15*60000);
  await db.query('DELETE FROM offer_import_previews WHERE expires_at<now() AND offer_id IS NULL');
  await db.query('INSERT INTO offer_import_previews(id,user_id,marketplace_id,affiliate_url,source_url,result,profile_version,expires_at,product_id,product_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[previewId,req.user!.id,v.marketplaceId,v.url,data.productUrl,JSON.stringify(data),profile.version,expiresAt,product.id,product.updated_at]);
  res.json({previewId,product,marketplaceId:market.id,marketplaceName:market.name,affiliateUrl:v.url,data,expiresAt,canConfirm:data.missing.length===0});
 });
 app.post('/api/admin/link-imports/confirm',async(req,res)=>{
  const v=z.object({previewId:z.uuid(),authorizedContent:z.literal(true)}).parse(req.body),client=await db.connect();let offerId:string;
  try{
   await client.query('BEGIN');const preview=(await client.query('SELECT * FROM offer_import_previews WHERE id=$1 AND user_id=$2 FOR UPDATE',[v.previewId,req.user!.id])).rows[0];
   if(!preview)throw new HttpError(404,'Prévia não encontrada.');if(preview.offer_id)throw new HttpError(409,'Esta prévia já foi cadastrada.');if(new Date(preview.expires_at)<=new Date())throw new HttpError(409,'A prévia expirou. Extraia novamente antes de confirmar.');
   const market=(await client.query('SELECT * FROM marketplaces WHERE id=$1 FOR SHARE',[preview.marketplace_id])).rows[0],profile=(await client.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1 FOR SHARE',[preview.marketplace_id])).rows[0];
   if(!market.scraping_enabled||profile?.version!==preview.profile_version)throw new HttpError(409,'Marketplace ou seletores alterados. Gere uma nova prévia.');
   const product=(await client.query('SELECT * FROM products WHERE id=$1 FOR SHARE',[preview.product_id])).rows[0];if(!product||new Date(product.updated_at).getTime()!==new Date(preview.product_updated_at).getTime())throw new HttpError(409,'O produto foi alterado. Gere uma nova prévia.');
   const data=preview.result;if(data.missing?.length||!data.title||!Number.isInteger(data.priceCents)||data.priceCents<=0)throw new HttpError(409,'Campos obrigatórios ausentes. Ajuste os seletores e extraia novamente.');
   marketUrl(preview.affiliate_url,market.allowed_hosts);marketUrl(preview.source_url,market.allowed_hosts);
   const expires=new Date(new Date(data.collectedAt).getTime()+profile.validity_minutes*60000);if(expires<=new Date())throw new HttpError(409,'Os dados perderam a validade. Extraia novamente.');
   Object.assign(data,await resolveClassification(client,product.category,product.subcategory));
   offerId=randomUUID();
   await client.query("INSERT INTO offers(id,marketplace_id,external_id,title,description,category,image_url,product_url,affiliate_url,price_cents,original_price_cents,source,conditions,expires_at,images,specifications,extraction_metadata,subcategory,product_id,seller_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'scraped',$12,$13,$14,$15,$16,$17,$18,$19)",[offerId,preview.marketplace_id,data.externalId,data.title,data.description,data.category,data.images[0]??null,preview.source_url,preview.affiliate_url,data.priceCents,data.originalPriceCents,data.conditions,expires,JSON.stringify(data.images),JSON.stringify(data.specifications),JSON.stringify({profileVersion:preview.profile_version,collectedAt:data.collectedAt,evidence:data.evidence,warnings:data.warnings}),data.subcategory,product.id,data.sellerName||'']);
   await client.query('UPDATE offer_import_previews SET offer_id=$2 WHERE id=$1',[preview.id,offerId]);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');if((e as any)?.code==='23505')throw new HttpError(409,'Esse produto já está cadastrado nesse marketplace. Confira a revisão de ofertas.');throw e;}finally{client.release();}
  await audit(db,req.user!.id,'offer.import_confirmed',offerId!);res.status(201).json({ok:true,offerId:offerId!,status:'pending'});
 });
 app.get('/api/admin/link-imports',async(req,res)=>res.json(await pagedQuery(db,req.query,"SELECT o.id,o.title,o.marketplace_id,m.name AS marketplace_name,o.affiliate_url,o.status,o.price_cents,o.created_at,o.updated_at,o.category,o.subcategory,o.category_path,o.category_ids,o.product_id,o.seller_name,o.availability_status,o.refresh_status,o.data_updated_at,o.last_refresh_attempt_at,o.last_refresh_error,p.name AS product_name,p.sku AS product_sku FROM offers o JOIN products p ON p.id=o.product_id JOIN marketplaces m ON m.id=o.marketplace_id WHERE o.source='scraped' ORDER BY o.created_at DESC,o.id",[],100)));
}
