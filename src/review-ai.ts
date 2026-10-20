import type {Express,Router} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import type {CatalogActor} from './catalog-contracts.js';
import {catalogTransaction} from './catalog-runs.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
const taskSchema=z.enum(['category','product']);
export const reviewAiInput=z.strictObject({version:z.number().int().positive(),categoryEnabled:z.boolean(),productEnabled:z.boolean(),categoryPrompt:z.string().trim().min(1).max(10000),productPrompt:z.string().trim().min(1).max(10000)});
const pathSchema=z.array(z.string().trim().min(1).max(80)).min(1).max(10);
const productSchema=z.strictObject({name:z.string().trim().min(1).max(300),description:z.string().max(4000),brand:z.string().max(120)});
export const reviewAiResult=z.strictObject({requestId:z.uuid(),model:z.string().min(1).max(200),suggestion:z.strictObject({action:z.enum(['link_existing','create_new','needs_review']),category:z.string().min(1).max(1000),categoryExists:z.boolean().optional(),productId:z.uuid().nullable(),product:productSchema.nullable(),reason:z.string().min(1).max(3000)})});
type Query=Pick<Database,'query'>;
export async function reviewAiSettings(db:Query,lock=false){
 const r=(await db.query('SELECT * FROM review_ai_settings WHERE id=true'+(lock?' FOR SHARE':''))).rows[0];
 return {version:r.version,categoryEnabled:r.category_enabled,productEnabled:r.product_enabled,categoryPrompt:r.category_prompt,productPrompt:r.product_prompt};
}
async function taskVersion(db:Query,task:'category'|'product'){const column=task==='category'?'category_version':'product_version';return (await db.query('SELECT '+column+' AS version FROM review_ai_settings WHERE id=true')).rows[0].version as number;}
function allowed(actor:CatalogActor){if(!actor.permissions.includes('affiliate_links')||!actor.permissions.includes('catalog'))throw new HttpError(403,'Seu perfil precisa das permissões de catálogo e geração de links.');}
function enabled(settings:Awaited<ReturnType<typeof reviewAiSettings>>,task:'category'|'product'){if(!settings[task==='category'?'categoryEnabled':'productEnabled'])throw new HttpError(409,'Esta tarefa de IA está desativada no admin.');}
async function eligible(db:Query,id:string,task:'category'|'product',lock=false){
 const row=(await db.query('SELECT * FROM discovery_links WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
 if(!row||row.status!=='pending'||row.published_offer_id||row.extraction_status!=='completed'||(task==='category'?!!row.confirmed_category_id:!row.confirmed_category_id||!!row.product_id))throw new HttpError(409,'Link não elegível para esta tarefa. Atualize a revisão.');
 return row;
}
export async function aiQueue(db:Query,actor:CatalogActor,input:unknown){
 allowed(actor);const v=z.strictObject({marketplaceId:z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),task:taskSchema,limit:z.coerce.number().int().min(1).max(10000).default(100)}).parse(input),settings=await reviewAiSettings(db);enabled(settings,v.task);const revision=await taskVersion(db,v.task);
 const links=(await db.query(`SELECT l.id,l.enrichment_data->>'title' AS title FROM discovery_links l
 WHERE l.marketplace_id=$1 AND l.status='pending' AND l.published_offer_id IS NULL AND l.extraction_status='completed'
 AND (($2='category' AND l.confirmed_category_id IS NULL) OR ($2='product' AND l.confirmed_category_id IS NOT NULL AND l.product_id IS NULL))
 AND NOT EXISTS(SELECT 1 FROM review_ai_suggestions s WHERE s.link_id=l.id AND s.task=$2 AND s.link_version=l.enrichment_version AND s.settings_version=$3 AND (s.suggestion IS NOT NULL OR s.expires_at>clock_timestamp()))
 ORDER BY l.first_seen_at,l.id LIMIT $4`,[v.marketplaceId,v.task,revision,v.limit])).rows;
 return {items:links};
}
export async function aiContext(db:Database,actor:CatalogActor,id:string,task:'category'|'product'){
 allowed(actor);return catalogTransaction(db,async c=>{
  const settings=await reviewAiSettings(c,true);enabled(settings,task);const revision=await taskVersion(c,task);const link=await eligible(c,id,task,true),data=link.enrichment_data;
  const pending=(await c.query('SELECT request_id FROM review_ai_suggestions WHERE link_id=$1 AND task=$2 AND link_version=$3 AND settings_version=$4 AND (suggestion IS NOT NULL OR expires_at>clock_timestamp())',[id,task,link.enrichment_version,revision])).rows[0];
  if(pending)throw new HttpError(409,'Este item já tem sugestão ou análise em andamento. Atualize a revisão.');
  const source=(link.source_category_path??[]).join(' > ');
  const mapping=(await c.query('SELECT n.id,n.path FROM category_mappings m JOIN category_nodes n ON n.id=m.category_id WHERE m.marketplace_id=$1 AND m.source_key=$2',[link.marketplace_id,link.source_category_key])).rows[0];
  const category=link.confirmed_category_id?(await c.query('SELECT id,path FROM category_nodes WHERE id=$1',[link.confirmed_category_id])).rows[0]:null;
  const categories=(await c.query(`SELECT id,path FROM category_nodes ORDER BY (id=$1) DESC NULLS LAST,ts_rank(to_tsvector('portuguese',array_to_string(path,' ')),plainto_tsquery('portuguese',$2)) DESC,normalized_path LIMIT 101`,[mapping?.id??null,source+' '+data.title])).rows;
  const products=task==='product'?(await c.query(`SELECT id,name,brand,left(description,2000) AS description FROM products WHERE category_ids @> ARRAY[$1]::uuid[]
 ORDER BY ts_rank(to_tsvector('portuguese',name||' '||brand),plainto_tsquery('portuguese',$2)) DESC,lower(brand)=lower($3) DESC,name,id LIMIT 31`,[link.confirmed_category_id,data.title,data.brand??''])).rows:[];
  const context={categoryId:link.confirmed_category_id,productIds:products.slice(0,30).map(p=>p.id)},requestId=randomUUID();
  await c.query(`INSERT INTO review_ai_suggestions(link_id,task,request_id,link_version,settings_version,created_by,request_context) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(link_id,task) DO UPDATE SET request_id=$3,link_version=$4,settings_version=$5,created_by=$6,request_context=$7,suggestion=NULL,expires_at=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()`,[id,task,requestId,link.enrichment_version,revision,actor.id,JSON.stringify(context)]);
  return {requestId,task,instructions:task==='category'?settings.categoryPrompt:settings.productPrompt,
   offer:{title:String(data.title??'').slice(0,500),brand:String(data.brand??'').slice(0,200),description:String(data.description??'').slice(0,8000),sourceCategory:task==='product'?category.path.join(' > '):source},
   categories:task==='product'?[category.path.join(' > ')]:categories.slice(0,100).map(c=>c.path.join(' > ')),products:products.slice(0,30),
   mapping:task==='category'&&mapping?mapping.path.join(' > '):null,candidatesTruncated:categories.length>100||products.length>30};
 });
}
export async function saveAiSuggestion(db:Database,actor:CatalogActor,input:unknown){
 allowed(actor);const v=reviewAiResult.parse(input);return catalogTransaction(db,async c=>{
  const settings=await reviewAiSettings(c,true);
  const snapshot=(await c.query('SELECT * FROM review_ai_suggestions WHERE request_id=$1',[v.requestId])).rows[0];
  if(!snapshot||snapshot.created_by!==actor.id)throw new HttpError(404,'Solicitação de IA não encontrada.');
  enabled(settings,snapshot.task);const revision=await taskVersion(c,snapshot.task);const link=await eligible(c,snapshot.link_id,snapshot.task,true);
  const current=(await c.query('SELECT * FROM review_ai_suggestions WHERE request_id=$1 FOR UPDATE',[v.requestId])).rows[0];
  if(!current||current.link_version!==link.enrichment_version||current.settings_version!==revision)throw new HttpError(409,'Os dados ou configurações mudaram. Gere uma nova sugestão.');
  if(current.suggestion)return {ok:true};
  if(new Date(current.expires_at).getTime()<Date.now())throw new HttpError(409,'Solicitação expirada.');
  const s=v.suggestion,path=pathSchema.parse(s.category.split('>').map(p=>p.trim()));
  if(snapshot.task==='product'){
   const cat=(await c.query('SELECT path FROM category_nodes WHERE id=$1',[link.confirmed_category_id])).rows[0];
   if(JSON.stringify(cat.path)!==JSON.stringify(path))throw new HttpError(400,'A IA não pode alterar a categoria confirmada ao catalogar.');
   if(s.action==='link_existing'){
    if(!s.productId||!current.request_context.productIds.includes(s.productId))throw new HttpError(400,'Produto fora dos candidatos desta análise.');
    const p=(await c.query('SELECT id FROM products WHERE id=$1 AND category_ids @> ARRAY[$2]::uuid[]',[s.productId,link.confirmed_category_id])).rows[0];
    if(!p)throw new HttpError(409,'O produto candidato foi alterado.');
   }
  }else if(s.action!=='needs_review'||s.productId||s.product)throw new HttpError(400,'A categorização não pode atribuir ou criar produtos.');
  if((s.action==='link_existing')!==!!s.productId||(s.action==='create_new')!==!!s.product)throw new HttpError(400,'Sugestão inconsistente.');
  const category=(await c.query('SELECT id FROM category_nodes WHERE normalized_path=$1',[path.map(p=>p.normalize('NFC').replace(/\s+/gu,' ').trim().toLowerCase())])).rows[0];
  await c.query('UPDATE review_ai_suggestions SET suggestion=$2,updated_at=clock_timestamp() WHERE request_id=$1',[v.requestId,JSON.stringify({...s,category:path.join(' > '),categoryPath:path,categoryId:category?.id??null,categoryExists:!!category,model:v.model})]);
  await audit(c,actor.id,'review_ai.suggested',link.id);return {ok:true};
 });
}
export function registerReviewAiAdmin(app:Express,db:Database){
 const base='/api/admin/discovery/enrichment/ai';
 app.get(base+'/settings',async(_req,res)=>res.json(await reviewAiSettings(db)));
 app.put(base+'/settings',async(req,res)=>{
  const v=reviewAiInput.parse(req.body);const result=await catalogTransaction(db,async c=>{
   const changed=await c.query('UPDATE review_ai_settings SET category_enabled=$2,product_enabled=$3,category_version=category_version+CASE WHEN category_enabled IS DISTINCT FROM $2 OR category_prompt IS DISTINCT FROM $4 THEN 1 ELSE 0 END,product_version=product_version+CASE WHEN product_enabled IS DISTINCT FROM $3 OR product_prompt IS DISTINCT FROM $5 THEN 1 ELSE 0 END,category_prompt=$4,product_prompt=$5,version=version+1,updated_by=$6,updated_at=clock_timestamp() WHERE id=true AND version=$1 RETURNING version',[v.version,v.categoryEnabled,v.productEnabled,v.categoryPrompt,v.productPrompt,req.user!.id]);
   if(!changed.rows.length)throw new HttpError(409,'Configurações alteradas. Recarregue antes de salvar.');
   await audit(c,req.user!.id,'review_ai.settings','global');return reviewAiSettings(c);
  });res.json(result);
 });
 app.post(base+'/suggestions/:id/discard',async(req,res)=>{z.strictObject({}).parse(req.body);const id=z.uuid().parse(req.params.id);await db.query('DELETE FROM review_ai_suggestions WHERE request_id=$1',[id]);await audit(db,req.user!.id,'review_ai.discarded',id);res.json({ok:true});});
}
export function registerReviewAiExtension(router:Router,db:Database,account:(req:any)=>Promise<CatalogActor>){
 router.get('/catalog/ai/config',async(req,res)=>{
  const actor=await account(req);allowed(actor);const marketplaceId=z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/).parse(req.query.marketplaceId);
  const stats=(await db.query(`SELECT count(*)::int AS total,
 count(*) FILTER(WHERE confirmed_category_id IS NOT NULL)::int AS categorized,
 count(*) FILTER(WHERE confirmed_category_id IS NOT NULL AND product_id IS NOT NULL)::int AS cataloged,
 (SELECT count(*)::int FROM review_ai_suggestions s JOIN discovery_links d ON d.id=s.link_id WHERE d.marketplace_id=$1 AND d.status='pending' AND d.published_offer_id IS NULL AND s.link_version=d.enrichment_version AND s.settings_version=(SELECT CASE s.task WHEN 'category' THEN category_version ELSE product_version END FROM review_ai_settings WHERE id=true) AND s.suggestion IS NOT NULL) AS suggestions
 FROM discovery_links WHERE marketplace_id=$1 AND status='pending' AND published_offer_id IS NULL`,[marketplaceId])).rows[0];
  res.json({settings:await reviewAiSettings(db),category:{completed:stats.categorized,total:stats.total},product:{completed:stats.cataloged,total:stats.categorized},pendingSuggestions:stats.suggestions});
 });
 router.get('/catalog/ai/queue',async(req,res)=>res.json(await aiQueue(db,await account(req),req.query)));
 router.post('/catalog/ai/context',async(req,res)=>{const v=z.strictObject({id:z.uuid(),task:taskSchema}).parse(req.body);res.json(await aiContext(db,await account(req),v.id,v.task));});
 router.post('/catalog/ai/suggestions',async(req,res)=>res.json(await saveAiSuggestion(db,await account(req),req.body)));
 router.post('/catalog/ai/release',async(req,res)=>{const actor=await account(req);allowed(actor);const {requestId}=z.strictObject({requestId:z.uuid()}).parse(req.body);await db.query('DELETE FROM review_ai_suggestions WHERE request_id=$1 AND created_by=$2 AND suggestion IS NULL',[requestId,actor.id]);res.json({ok:true});});
}
