import type {Router} from 'express';
import type {Database} from './db.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {pagedQuery} from './pagination.js';
import {allowStep,startCatalogInput,actionInput,uuid,type CatalogActor} from './catalog-contracts.js';
import {getCatalogSettings,legacyBusy} from './catalog-settings.js';
type Query=Pick<Database,'query'>;
export async function catalogTransaction<T>(db:Database,work:(c:Query)=>Promise<T>):Promise<T>{
 const c=await db.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function ownRun(c:Query,id:string,actor:CatalogActor,lock=false){
 const row=(await c.query('SELECT * FROM extension_catalog_runs WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
 if(!row||row.created_by!==actor.id)throw new HttpError(404,'Execução não encontrada.');
 allowStep(actor,row.step);
 if(row.extension_id&&row.extension_id!==actor.extension_id)throw new HttpError(403,'Execução pertence a outra instalação da extensão.');
 return row;
}
export async function expireRuns(c:Query){
 await c.query("UPDATE extension_catalog_runs SET status='failed',reason='intervention_expired',updated_at=clock_timestamp() WHERE expires_at<clock_timestamp() AND status NOT IN ('completed','failed','cancelled')");
}
export async function runView(c:Query,id:string){
 return (await c.query(`SELECT r.*,(SELECT count(*)::int FROM extension_catalog_items WHERE run_id=r.id) AS total,
 (SELECT count(*)::int FROM extension_catalog_items WHERE run_id=r.id AND status='completed') AS completed,
 (SELECT count(*)::int FROM extension_catalog_items WHERE run_id=r.id AND status='failed') AS failed
 FROM extension_catalog_runs r WHERE r.id=$1`,[id])).rows[0];
}
export async function startCatalogRun(db:Database,actor:CatalogActor,input:unknown){
 const v=startCatalogInput.parse(input);allowStep(actor,v.step);
 return catalogTransaction(db,async c=>{
  const market=(await c.query('SELECT * FROM marketplaces WHERE id=$1 FOR UPDATE',[v.marketplaceId])).rows[0];
  if(!market?.scraping_enabled||market.catalog_executor!=='extension')throw new HttpError(409,'Ative o executor da extensão nas configurações deste marketplace.');
  const prior=(await c.query('SELECT * FROM extension_catalog_runs WHERE created_by=$1 AND request_key=$2',[actor.id,v.requestKey])).rows[0];
  if(prior){if(prior.marketplace_id!==v.marketplaceId||prior.step!==v.step)throw new HttpError(409,'Chave de solicitação já utilizada.');await ownRun(c,prior.id,actor);return runView(c,prior.id);}
  await expireRuns(c);
  if(await legacyBusy(c,market.id)||(await c.query("SELECT id FROM extension_catalog_runs WHERE marketplace_id=$1 AND status NOT IN ('completed','failed','cancelled')",[market.id])).rows.length)throw new HttpError(409,'Este marketplace já possui processamento em andamento.');
  const settings=await getCatalogSettings(c,market.id);
  const profile=(await c.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1',[market.id])).rows[0];
  if(v.step==='convert'&&!settings.config.recipe)throw new HttpError(409,'Cadastre a receita de conversão.');
  if(['enrich','prices'].includes(v.step)&&!profile?.rules?.length)throw new HttpError(409,'Cadastre os seletores do produto.');
  let items:any[]=[];
  if(v.step==='discover')items=(await c.query(`SELECT s.id AS target_id,jsonb_build_object('url',s.url,'config',p.config,'sourceId',s.id,'sourceVersion',s.version,'profileVersion',p.version) AS payload,s.version::text AS expected_version
   FROM discovery_sources s JOIN discovery_profiles p ON p.id=s.profile_id WHERE s.marketplace_id=$1 AND s.enabled AND s.paused_at IS NULL ORDER BY s.id LIMIT $2`,[market.id,v.limit])).rows;
  if(['convert','enrich'].includes(v.step))items=(await c.query(`SELECT id AS target_id,jsonb_build_object('url',CASE WHEN $2='convert' THEN url ELSE affiliate_url END,'originalUrl',url,'title',COALESCE(enrichment_data->>'title',url)) AS payload,enrichment_version::text AS expected_version
   FROM discovery_links WHERE marketplace_id=$1 AND status='pending' AND published_offer_id IS NULL AND
   (($2='convert' AND affiliate_url IS NULL) OR ($2='enrich' AND affiliate_url IS NOT NULL AND (extraction_status='pending' OR ($3 AND extraction_status='failed')))) ORDER BY first_seen_at,id LIMIT $4`,[market.id,v.step,v.retryFailed,v.limit])).rows;
  if(v.step==='prices')items=(await c.query(`SELECT id AS target_id,jsonb_build_object('url',affiliate_url,'originalUrl',product_url,'title',title) AS payload,updated_at::text AS expected_version FROM offers WHERE marketplace_id=$1 AND status='published' AND affiliate_url IS NOT NULL ORDER BY data_updated_at,id LIMIT $2`,[market.id,v.limit])).rows;
  if(!items.length)throw new HttpError(409,'Não há itens elegíveis para esta etapa.');
  const id=randomUUID();const snapshot={schemaVersion:1,market:{id:market.id,allowedHosts:market.allowed_hosts,normalizationRules:market.url_normalization_rules},settings:settings.config,settingsVersion:settings.version,profile:profile??null};
  await c.query('INSERT INTO extension_catalog_runs(id,marketplace_id,created_by,extension_id,step,snapshot,request_key) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,market.id,actor.id,actor.extension_id??null,v.step,JSON.stringify(snapshot),v.requestKey]);
  for(const item of items)await c.query('INSERT INTO extension_catalog_items(id,run_id,target_id,payload,expected_version) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,item.target_id,JSON.stringify(item.payload),item.expected_version]);
  await audit(c,actor.id,'extension_catalog.started',id);return runView(c,id);
 });
}
export function registerCatalogRuns(router:Router,db:Database,account:(req:any)=>Promise<CatalogActor>){
 router.get('/catalog/config',async(req,res)=>{await account(req);const markets=(await db.query("SELECT id,name,website_url,allowed_hosts,catalog_executor FROM marketplaces WHERE scraping_enabled ORDER BY name")).rows;res.json({version:1,marketplaces:await Promise.all(markets.map(async m=>({...m,allowedOrigins:m.allowed_hosts.map((h:string)=>'https://'+h),...await getCatalogSettings(db,m.id)})))});});
 router.post('/catalog/runs',async(req,res)=>res.status(201).json(await startCatalogRun(db,await account(req),req.body)));
 router.get('/catalog/runs',async(req,res)=>{const actor=await account(req);await expireRuns(db);res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT id,marketplace_id,step,status,reason,created_at,updated_at FROM extension_catalog_runs WHERE created_by=$1 ORDER BY created_at DESC,id',[actor.id]));});
 router.get('/catalog/runs/:id',async(req,res)=>{const actor=await account(req),id=uuid.parse(req.params.id);await expireRuns(db);await ownRun(db,id,actor);res.json(await runView(db,id));});
 router.get('/catalog/runs/:id/items',async(req,res)=>{const actor=await account(req),id=uuid.parse(req.params.id);await ownRun(db,id,actor);res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT id,target_id,status,error,updated_at FROM extension_catalog_items WHERE run_id=$1 ORDER BY id',[id]));});
 router.post('/catalog/runs/:id/action',async(req,res)=>{
  const actor=await account(req),id=uuid.parse(req.params.id),v=actionInput.parse(req.body);
  await catalogTransaction(db,async c=>{
   await expireRuns(c);const run=await ownRun(c,id,actor,true);
   if(['completed','failed','cancelled'].includes(run.status))throw new HttpError(409,'Esta execução já terminou.');
   const statuses={pause:'paused_by_user',resume:'running',cancel:'cancelled',human:'waiting_for_human',technical:'paused_technical'};
   await c.query("UPDATE extension_catalog_runs SET status=$2,reason=$3,updated_at=clock_timestamp(),expires_at=clock_timestamp()+($4::int*interval '1 millisecond') WHERE id=$1",[id,statuses[v.action],v.reason,v.action==='human'?run.snapshot.settings.humanTimeoutMs:86400000]);
   if(v.action==='cancel')await c.query("UPDATE extension_catalog_items SET lease_until=NULL,status='skipped' WHERE run_id=$1 AND status IN ('pending','leased')",[id]);
   await audit(c,actor.id,'extension_catalog.'+v.action,id);
  });res.json(await runView(db,id));
 });
 router.post('/catalog/runs/:id/claim',async(req,res)=>{
  const actor=await account(req),id=uuid.parse(req.params.id);z.strictObject({}).parse(req.body);
  const result=await catalogTransaction(db,async c=>{
   await expireRuns(c);const run=await ownRun(c,id,actor,true);
   if(!['queued','running'].includes(run.status))throw new HttpError(409,'A execução não está disponível para processamento.');
   const item=(await c.query("SELECT * FROM extension_catalog_items WHERE run_id=$1 AND (status='pending' OR (status='leased' AND lease_until<clock_timestamp())) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",[id])).rows[0];
   if(!item){const busy=(await c.query("SELECT id FROM extension_catalog_items WHERE run_id=$1 AND status='leased'",[id])).rows.length;if(!busy)await c.query("UPDATE extension_catalog_runs SET status='completed',updated_at=clock_timestamp() WHERE id=$1",[id]);return {item:null};}
   const token=randomUUID();await c.query("UPDATE extension_catalog_items SET status='leased',lease_token=$2,lease_until=clock_timestamp()+interval '3 minutes',observed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[item.id,token]);
   await c.query("UPDATE extension_catalog_runs SET status='running',extension_id=COALESCE(extension_id,$2),updated_at=clock_timestamp() WHERE id=$1",[id,actor.extension_id]);
   return {item:{...item,status:'leased',lease_token:token,result:undefined,result_hash:undefined},snapshot:run.snapshot,step:run.step};
  });res.json(result);
 });
 router.post('/catalog/runs/:id/heartbeat',async(req,res)=>{
  const actor=await account(req),id=uuid.parse(req.params.id),v=z.strictObject({itemId:uuid,leaseToken:uuid}).parse(req.body);
  await catalogTransaction(db,async c=>{const run=await ownRun(c,id,actor,true);if(run.status!=='running'||new Date(run.expires_at).getTime()<Date.now())throw new HttpError(409,'Execução pausada ou expirada.');const result=await c.query("UPDATE extension_catalog_items SET lease_until=clock_timestamp()+interval '3 minutes' WHERE id=$1 AND run_id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND status='leased' RETURNING id",[v.itemId,id,v.leaseToken]);if(!result.rows.length)throw new HttpError(409,'Reserva expirada.');});res.json({ok:true});
 });
}
