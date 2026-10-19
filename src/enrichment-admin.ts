import type {Express} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {pagedQuery} from './pagination.js';
const uuid=z.uuid();
const marketId=z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
const settings=z.strictObject({requestIntervalMs:z.number().int().min(100).max(600000),categorySeparator:z.string().max(10)});
export const categoryKey=(path:string[])=>JSON.stringify(path.map(s=>s.normalize('NFC').replace(/\s+/gu,' ').trim().toLowerCase()));
const runView=`SELECT r.id,r.marketplace_id,m.name AS marketplace_name,r.status,r.total,r.error,r.current_link_id,r.created_at,r.started_at,r.finished_at,r.heartbeat_at,
 (SELECT count(*)::int FROM enrichment_items i WHERE i.run_id=r.id AND i.status='completed') AS completed,
 (SELECT count(*)::int FROM enrichment_items i WHERE i.run_id=r.id AND i.status='failed') AS failed,
 (SELECT count(*)::int FROM enrichment_items i WHERE i.run_id=r.id AND i.status IN ('skipped','cancelled')) AS skipped
 FROM enrichment_runs r JOIN marketplaces m ON m.id=r.marketplace_id`;
async function transaction<T>(db:Database,work:(c:Pick<Database,'query'>)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function startEnrichment(db:Database,marketplaceId:string,actor:string,retryFailed=false,limit=100){
 return transaction(db,async c=>{
  const market=(await c.query('SELECT id,allowed_hosts,scraping_enabled FROM marketplaces WHERE id=$1 FOR UPDATE',[marketplaceId])).rows[0];
  const profile=(await c.query('SELECT rules,wait_timeout_ms,version FROM scraping_profiles WHERE marketplace_id=$1',[marketplaceId])).rows[0];
  if(!market?.scraping_enabled||!profile)throw new HttpError(400,'Ative a extração e cadastre os seletores deste marketplace.');
  if((await c.query("SELECT id FROM enrichment_runs WHERE marketplace_id=$1 AND (status IN ('queued','running') OR worker_id IS NOT NULL)",[marketplaceId])).rows.length)throw new HttpError(409,'Este marketplace já tem um enriquecimento em andamento.');
  const links=(await c.query("SELECT id FROM discovery_links WHERE marketplace_id=$1 AND status='pending' AND (extraction_status='pending' OR ($2 AND extraction_status='failed')) ORDER BY first_seen_at,id LIMIT $3",[marketplaceId,retryFailed,limit])).rows;
  if(!links.length)throw new HttpError(409,'Não há links pendentes para esta seleção.');
  const config=(await c.query('SELECT * FROM enrichment_settings WHERE marketplace_id=$1',[marketplaceId])).rows[0];
  const id=randomUUID(),snapshot={allowedHosts:market.allowed_hosts,rules:profile.rules,timeoutMs:profile.wait_timeout_ms,profileVersion:profile.version,requestIntervalMs:config?.request_interval_ms??2000,categorySeparator:config?.category_separator??'>'};
  await c.query('INSERT INTO enrichment_runs(id,marketplace_id,created_by,snapshot,total) VALUES($1,$2,$3,$4,$5)',[id,marketplaceId,actor,JSON.stringify(snapshot),links.length]);
  for(const link of links)await c.query('INSERT INTO enrichment_items(run_id,link_id) VALUES($1,$2)',[id,link.id]);
  await audit(c,actor,'discovery.enrichment.started',id);return {id,status:'queued',total:links.length};
 });
}
export async function cancelEnrichment(db:Database,id:string,actor:string){return transaction(db,async c=>{
 const run=(await c.query('SELECT status FROM enrichment_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!run)throw new HttpError(404,'Execução não encontrada.');
 if(!['queued','running','cancelled'].includes(run.status))throw new HttpError(409,'Esta execução já terminou.');
 await c.query("UPDATE enrichment_runs SET status='cancelled',finished_at=clock_timestamp() WHERE id=$1",[id]);
 await c.query("UPDATE enrichment_items SET status='cancelled',finished_at=clock_timestamp() WHERE run_id=$1 AND status IN ('queued','running')",[id]);
 await audit(c,actor,'discovery.enrichment.cancelled',id);return {id,status:'cancelled'};
});}
export function registerEnrichmentAdmin(app:Express,db:Database){
 const base='/api/admin/discovery/enrichment';
 app.get(base+'/settings/:market',async(req,res)=>{const marketplaceId=marketId.parse(req.params.market);const row=(await db.query('SELECT request_interval_ms,category_separator FROM enrichment_settings WHERE marketplace_id=$1',[marketplaceId])).rows[0];res.json(row??{request_interval_ms:2000,category_separator:'>'});});
 app.put(base+'/settings/:market',async(req,res)=>{const marketplaceId=marketId.parse(req.params.market),v=settings.parse(req.body);await transaction(db,async c=>{if(!(await c.query('SELECT id FROM marketplaces WHERE id=$1',[marketplaceId])).rows.length)throw new HttpError(404,'Marketplace não encontrado.');await c.query('INSERT INTO enrichment_settings(marketplace_id,request_interval_ms,category_separator) VALUES($1,$2,$3) ON CONFLICT(marketplace_id) DO UPDATE SET request_interval_ms=$2,category_separator=$3',[marketplaceId,v.requestIntervalMs,v.categorySeparator]);await audit(c,req.user!.id,'discovery.enrichment.settings',marketplaceId);});res.json({ok:true});});
 app.post(base+'/runs',async(req,res)=>{const v=z.strictObject({marketplaceId:marketId,retryFailed:z.boolean().default(false),limit:z.number().int().min(1).max(10000).default(100)}).parse(req.body);res.status(202).json(await startEnrichment(db,v.marketplaceId,req.user!.id,v.retryFailed,v.limit));});
 app.get(base+'/runs',async(req,res)=>res.json(await pagedQuery(db,{...req.query,paginate:'true'},runView+' ORDER BY r.created_at DESC,r.id')));
 app.get(base+'/runs/:id/items',async(req,res)=>res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT i.*,l.url FROM enrichment_items i JOIN discovery_links l ON l.id=i.link_id WHERE run_id=$1 ORDER BY l.url',[uuid.parse(req.params.id)])));
 app.post(base+'/runs/:id/cancel',async(req,res)=>res.json(await cancelEnrichment(db,uuid.parse(req.params.id),req.user!.id)));
 app.post(base+'/review/:id/archive',async(req,res)=>{const id=uuid.parse(req.params.id);await transaction(db,async c=>{if(!(await c.query("UPDATE discovery_links SET status='archived' WHERE id=$1 RETURNING id",[id])).rows.length)throw new HttpError(404,'Link não encontrado.');await audit(c,req.user!.id,'discovery.link.archived',id);});res.json({ok:true});});
 app.get(base+'/categories',async(_req,res)=>res.json((await db.query('SELECT id,path FROM category_nodes ORDER BY normalized_path')).rows));
 app.get(base+'/review',async(req,res)=>{
  const f=z.object({marketplaceId:marketId.or(z.literal('')).default(''),sourceCategory:z.string().max(1000).default(''),state:z.enum(['','pending','completed','failed']).default('')}).parse(req.query);
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT l.*,m.name AS marketplace_name,cm.id AS mapping_id,cm.category_id AS suggested_category_id,n.path AS suggested_category_path,confirmed.path AS confirmed_category_path
   FROM discovery_links l JOIN marketplaces m ON m.id=l.marketplace_id LEFT JOIN category_mappings cm ON cm.marketplace_id=l.marketplace_id AND cm.source_key=l.source_category_key
   LEFT JOIN category_nodes n ON n.id=cm.category_id LEFT JOIN category_nodes confirmed ON confirmed.id=l.confirmed_category_id
   WHERE l.status='pending' AND ($1='' OR l.marketplace_id=$1) AND ($2='' OR l.extraction_status=$2) AND ($3='' OR position(lower($3) in lower(array_to_string(l.source_category_path,' > ')))>0) ORDER BY l.first_seen_at,l.id`,[f.marketplaceId,f.state,f.sourceCategory]));
 });
 app.post(base+'/review/:id/category',async(req,res)=>{
  const id=uuid.parse(req.params.id),v=z.strictObject({categoryId:uuid,version:z.number().int().nonnegative(),saveMapping:z.boolean().default(false)}).parse(req.body);
  await transaction(db,async c=>{
   // Same lock order as the worker prevents a confirmation/extraction race.
   const row=(await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.status!=='pending'||row.extraction_status!=='completed')throw new HttpError(409,'Conclua a extração antes de categorizar.');
   if(row.enrichment_version!==v.version)throw new HttpError(409,'Os dados foram atualizados. Reabra a revisão.');
   if(!(await c.query('SELECT id FROM category_nodes WHERE id=$1',[v.categoryId])).rows.length)throw new HttpError(400,'Categoria não encontrada.');
   if(v.saveMapping&&!row.source_category_path.length)throw new HttpError(400,'Sem árvore de origem; aplique apenas neste item.');
   if(v.saveMapping)await c.query('INSERT INTO category_mappings(id,marketplace_id,source_path,source_key,category_id,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(marketplace_id,source_key) DO UPDATE SET category_id=$5,updated_by=$6,updated_at=clock_timestamp()',[randomUUID(),row.marketplace_id,row.source_category_path,row.source_category_key,v.categoryId,req.user!.id]);
   await c.query('UPDATE discovery_links SET confirmed_category_id=$2,category_confirmed_by=$3,category_confirmed_at=clock_timestamp(),enrichment_version=enrichment_version+1 WHERE id=$1',[id,v.categoryId,req.user!.id]);
   await audit(c,req.user!.id,'discovery.category.confirmed',id);
  });res.json({ok:true});
 });
 app.get(base+'/mappings',async(req,res)=>res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT cm.*,m.name AS marketplace_name,n.path AS category_path FROM category_mappings cm JOIN marketplaces m ON m.id=cm.marketplace_id JOIN category_nodes n ON n.id=cm.category_id ORDER BY cm.updated_at DESC,cm.id')));
 app.put(base+'/mappings/:id',async(req,res)=>{const id=uuid.parse(req.params.id),v=z.strictObject({categoryId:uuid}).parse(req.body);await transaction(db,async c=>{if(!(await c.query('SELECT id FROM category_nodes WHERE id=$1',[v.categoryId])).rows.length)throw new HttpError(400,'Categoria não encontrada.');if(!(await c.query('UPDATE category_mappings SET category_id=$2,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING id',[id,v.categoryId,req.user!.id])).rows.length)throw new HttpError(404,'Mapeamento não encontrado.');await audit(c,req.user!.id,'discovery.mapping.updated',id);});res.json({ok:true});});
 app.delete(base+'/mappings/:id',async(req,res)=>{const id=uuid.parse(req.params.id);await transaction(db,async c=>{if(!(await c.query('DELETE FROM category_mappings WHERE id=$1 RETURNING id',[id])).rows.length)throw new HttpError(404,'Mapeamento não encontrado.');await audit(c,req.user!.id,'discovery.mapping.deleted',id);});res.json({ok:true});});
}
