import type {Express} from 'express';
import {recordDailyPrice} from './price-history.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import type {Config} from './config.js';
import type {OfferExtractor,ScrapedData} from './scraping.js';
import {RemoteOfferExtractor} from './remote-extractor.js';
import {linkIdentity,sameProductUrl} from './link-identity.js';
import {HttpError} from './security.js';
import {audit,credentials,withMeliCredentials} from './offers.js';
import {ProviderService,type Candidate} from './providers.js';

type Queryable=Pick<Database,'query'>;
type Outcome='updated'|'unavailable'|'pending'|'skipped';
type Result={outcome:Outcome;price?:number;original?:number|null;conditions?:string;expires?:Date|string;error?:string};
const settingsSchema=z.object({enabled:z.boolean(),intervalHours:z.number().int().min(1).max(168),requestIntervalMs:z.number().int().min(100).max(3600000),expectedUpdatedAt:z.iso.datetime()});
const sameTime=(a:Date|string,b:Date|string)=>new Date(a).getTime()===new Date(b).getTime();

async function enqueue(db:Queryable,trigger:'manual'|'scheduled',userId:string|null){
 const id=randomUUID();
 await db.query('INSERT INTO offer_refresh_runs(id,trigger,created_by,next_item_at) VALUES($1,$2,$3,(SELECT GREATEST(now(),COALESCE(max(next_item_at),now())) FROM offer_refresh_runs))',[id,trigger,userId]);
 const offers=(await db.query("SELECT id,marketplace_id,updated_at FROM offers WHERE status='published' AND affiliate_url IS NOT NULL ORDER BY marketplace_id,created_at,id")).rows;
 for(const offer of offers)await db.query('INSERT INTO offer_refresh_items(id,run_id,offer_id,marketplace_id,expected_updated_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,offer.id,offer.marketplace_id,offer.updated_at]);
 await db.query('UPDATE offer_refresh_runs SET total=$2 WHERE id=$1',[id,offers.length]);
 return (await db.query('SELECT * FROM offer_refresh_runs WHERE id=$1',[id])).rows[0];
}
// Consume elapsed windows while preserving the original schedule anchor. Never queue catch-up runs.
async function advanceSchedule(db:Queryable){
 await db.query("UPDATE offer_refresh_settings SET next_run_at=next_run_at+(floor(extract(epoch FROM (clock_timestamp()-next_run_at))/(interval_hours*3600))+1)*interval_hours*interval '1 hour' WHERE id=true AND enabled AND next_run_at<=clock_timestamp()");
}
async function completeIfFinished(db:Queryable,runId:string){
 if((await db.query("SELECT id FROM offer_refresh_items WHERE run_id=$1 AND status<>'done' LIMIT 1",[runId])).rows.length)return;
 await db.query("UPDATE offer_refresh_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1",[runId]);
 await advanceSchedule(db);
}
export async function startOfferRefresh(db:Database,userId:string){
 const client=await db.connect();let run;
 try{await client.query('BEGIN');await client.query('SELECT id FROM offer_refresh_settings WHERE id=true FOR UPDATE');
  if((await client.query("SELECT id FROM offer_refresh_runs WHERE status IN ('queued','running') LIMIT 1")).rows.length)throw new HttpError(409,'Uma atualização já está em andamento. Acompanhe a execução atual.');
  run=await enqueue(client,'manual',userId);await completeIfFinished(client,run.id);await audit(client,userId,'offer_refresh.started',run.id);run=(await client.query('SELECT * FROM offer_refresh_runs WHERE id=$1',[run.id])).rows[0];await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}return run;
}
async function claim(db:Database){
 const client=await db.connect();
 try{
  await client.query('BEGIN');const settings=(await client.query('SELECT *,next_run_at<=now() AS schedule_due FROM offer_refresh_settings WHERE id=true FOR UPDATE')).rows[0];
  let run=(await client.query("SELECT * FROM offer_refresh_runs WHERE status IN ('queued','running') LIMIT 1")).rows[0];
  if(settings.enabled&&settings.schedule_due){await advanceSchedule(client);if(!run)run=await enqueue(client,'scheduled',null);}
  if(!run){await client.query('COMMIT');return null;}
  await client.query("UPDATE offer_refresh_items SET status='queued',attempt_id=NULL,lease_until=NULL WHERE run_id=$1 AND status='running' AND lease_until<=now()",[run.id]);
  const ready=(await client.query('SELECT next_item_at<=now() AS due FROM offer_refresh_runs WHERE id=$1',[run.id])).rows[0].due;
  if((await client.query("SELECT id FROM offer_refresh_items WHERE run_id=$1 AND status='running' LIMIT 1",[run.id])).rows.length||!ready){await client.query('COMMIT');return null;}
  const item=(await client.query("SELECT * FROM offer_refresh_items WHERE run_id=$1 AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE",[run.id])).rows[0];
  if(!item){await completeIfFinished(client,run.id);await client.query('COMMIT');return null;}
  const attemptId=randomUUID();await client.query("UPDATE offer_refresh_items SET status='running',attempt_id=$2,lease_until=now()+interval '5 minutes' WHERE id=$1",[item.id,attemptId]);
  await client.query("UPDATE offer_refresh_runs SET status='running',started_at=COALESCE(started_at,now()),next_item_at=now()+$2*interval '1 millisecond' WHERE id=$1",[run.id,settings.request_interval_ms]);
  await client.query('COMMIT');return {...item,attemptId,requestInterval:settings.request_interval_ms};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
function matchesStoredLink(offer:any,data:ScrapedData):boolean{
 if(offer.external_id.startsWith('url-v1:'))return offer.external_id===linkIdentity(offer.marketplace_id,offer.affiliate_url)&&sameProductUrl(data.productUrl,offer.product_url);
 return data.externalId===offer.external_id;
}
async function inspectOffer(db:Database,config:Config,providers:ProviderService,extractor:OfferExtractor|undefined,offer:any):Promise<Result>{
 if(offer.source==='api'){
  let candidate:Candidate|null;
  if(offer.marketplace_id==='mercadolivre')candidate=await withMeliCredentials(db,config,c=>providers.refresh('mercadolivre',c,offer.external_id));
  else candidate=await providers.refresh(offer.marketplace_id,(await credentials(db,config,offer.marketplace_id)).secrets,offer.external_id);
  if(!candidate)return {outcome:'unavailable'};
  if(candidate.externalId!==offer.external_id||!Number.isInteger(candidate.priceCents)||candidate.priceCents<=0)throw new HttpError(422,'A API retornou identificação ou preço inconsistente.');
  return {outcome:'updated',price:candidate.priceCents,original:candidate.originalPriceCents,conditions:candidate.conditions,expires:candidate.expiresAt};
 }
 const market=(await db.query('SELECT * FROM marketplaces WHERE id=$1',[offer.marketplace_id])).rows[0];
 const profile=(await db.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1',[offer.marketplace_id])).rows[0];
 if(!market?.scraping_enabled||!profile?.rules?.length)throw new HttpError(409,'Extração desativada ou seletores não configurados para o marketplace.');
 const service=extractor??(config.SCRAPER_SERVICE_URL?new RemoteOfferExtractor(config.SCRAPER_SERVICE_URL,config.EXTRACTION_SERVICE_TOKEN):null);
 if(!service)throw new HttpError(503,'Serviço de extração não configurado.');
 const data:ScrapedData=await service.extract(offer.affiliate_url,market,profile);
 if(!data.title.trim()||!matchesStoredLink(offer,data))throw new HttpError(422,'Não foi possível confirmar o destino do anúncio. Confira a página e os seletores.');
 if(data.priceCents===null)return {outcome:'unavailable'};
 if(data.missing.length||!Number.isInteger(data.priceCents)||data.priceCents<=0)throw new HttpError(422,'A extração retornou campos obrigatórios ausentes ou preço inconsistente.');
 return {outcome:'updated',price:data.priceCents,original:data.originalPriceCents,conditions:data.conditions,expires:new Date(Date.now()+profile.validity_minutes*60000)};
}
async function finish(db:Database,item:any,result:Result){
 const client=await db.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT id FROM offer_refresh_settings WHERE id=true FOR UPDATE');
  const claimed=(await client.query("SELECT id FROM offer_refresh_items WHERE id=$1 AND status='running' AND attempt_id=$2 FOR UPDATE",[item.id,item.attemptId])).rows[0];
  if(!claimed){await client.query('COMMIT');return;}
  const offer=item.offer_id?(await client.query('SELECT * FROM offers WHERE id=$1 FOR UPDATE',[item.offer_id])).rows[0]:null;
  if(!offer||offer.status!=='published'||!sameTime(offer.updated_at,item.expected_updated_at))result={outcome:'skipped',error:'Link removido ou alterado após o início da execução.'};
  if(result.outcome==='updated')await client.query("UPDATE offers SET price_cents=$2,original_price_cents=$3,conditions=$4,expires_at=$5,availability_status='available',refresh_status='updated',data_updated_at=clock_timestamp(),verified_at=clock_timestamp(),last_refresh_attempt_at=clock_timestamp(),last_refresh_error=NULL,updated_at=clock_timestamp() WHERE id=$1",[offer.id,result.price,result.original??null,result.conditions??offer.conditions,result.expires??offer.expires_at]);
  else if(result.outcome==='unavailable')await client.query("UPDATE offers SET availability_status='unavailable',refresh_status='updated',data_updated_at=clock_timestamp(),last_refresh_attempt_at=clock_timestamp(),last_refresh_error=NULL,updated_at=clock_timestamp() WHERE id=$1",[offer.id]);
  else if(result.outcome==='pending')await client.query("UPDATE offers SET refresh_status='pending',last_refresh_attempt_at=clock_timestamp(),last_refresh_error=$2,updated_at=clock_timestamp() WHERE id=$1",[offer.id,result.error]);
  if(result.outcome==='updated'||result.outcome==='unavailable')await recordDailyPrice(client,offer.id,offer.product_id,result.outcome==='updated'?result.price!:null);
  await client.query("UPDATE offer_refresh_items SET status='done',outcome=$2,error=$3,finished_at=clock_timestamp(),lease_until=NULL WHERE id=$1",[item.id,result.outcome,result.error??null]);
  // Outcome is an internal enum, never a user-provided SQL identifier.
  await client.query(`UPDATE offer_refresh_runs SET processed=processed+1,${result.outcome}=${result.outcome}+1,next_item_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1`,[item.run_id,result.outcome==='pending'?Math.max(item.requestInterval,300000):item.requestInterval]);
  await completeIfFinished(client,item.run_id);await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function processOfferRefresh(db:Database,config:Config,providers:ProviderService,extractor?:OfferExtractor){
 const item=await claim(db);if(!item)return;
 let result:Result;
 try{
  const offer=item.offer_id?(await db.query('SELECT * FROM offers WHERE id=$1',[item.offer_id])).rows[0]:null;
  if(!offer||offer.status!=='published'||!sameTime(offer.updated_at,item.expected_updated_at))result={outcome:'skipped'};
  else result=await inspectOffer(db,config,providers,extractor,offer);
 }catch(e){result={outcome:'pending',error:e instanceof HttpError?e.message.slice(0,500):'Falha técnica ao atualizar a oferta. Uma nova tentativa será feita na próxima execução.'};}
 await finish(db,item,result);
}
// A session lock also prevents overlap if an extraction outlives its item lease.
// The unique active-run index and transactional claims protect the persisted queue.
export async function tickOfferRefresh(db:Database,config:Config,providers:ProviderService,extractor?:OfferExtractor){
 const lock=await db.connect();let held=false;
 try{
  held=(await lock.query('SELECT pg_try_advisory_lock(728149,1) AS locked')).rows[0].locked;
  if(held)await processOfferRefresh(db,config,providers,extractor);
 }finally{
  try{if(held)await lock.query('SELECT pg_advisory_unlock(728149,1)');}catch(e){lock.release(true);throw e;}
  lock.release();
 }
}
export async function offerRefreshDelay(db:Database):Promise<number>{
 // Use the database clock: host and PostgreSQL clocks need not be synchronized.
 const row=(await db.query("SELECT CASE WHEN EXISTS(SELECT 1 FROM offer_refresh_items WHERE run_id=r.id AND status='running') THEN 1000 ELSE GREATEST(1,ceil(extract(epoch FROM (next_item_at-clock_timestamp()))*1000)) END AS delay FROM offer_refresh_runs r WHERE status IN ('queued','running') LIMIT 1")).rows[0];
 return row?Math.min(1000,Math.max(1,Number(row.delay))):1000;
}
export function registerOfferRefreshAdmin(app:Express,db:Database){
 app.get('/api/admin/offer-refresh',async(_req,res)=>{
  const settings=(await db.query('SELECT * FROM offer_refresh_settings WHERE id=true')).rows[0];
  const runs=(await db.query('SELECT * FROM offer_refresh_runs ORDER BY created_at DESC,id LIMIT 20')).rows;
  res.json({settings,active:runs.find(r=>r.status!=='completed')??null,runs});
 });
 app.put('/api/admin/offer-refresh',async(req,res)=>{
  const v=settingsSchema.parse(req.body),client=await db.connect();let settings;
  try{await client.query('BEGIN');const current=(await client.query('SELECT * FROM offer_refresh_settings WHERE id=true FOR UPDATE')).rows[0];if(!sameTime(current.updated_at,v.expectedUpdatedAt))throw new HttpError(409,'Configuração alterada. Recarregue antes de salvar.');
   const resetSchedule=current.enabled!==v.enabled||current.interval_hours!==v.intervalHours;
   settings=(await client.query("UPDATE offer_refresh_settings SET enabled=$1,interval_hours=$2::int,request_interval_ms=$3::int,next_run_at=CASE WHEN NOT $1 THEN NULL WHEN $4 OR next_run_at IS NULL THEN now()+$2::int*interval '1 hour' ELSE next_run_at END,updated_at=clock_timestamp() WHERE id=true RETURNING *",[v.enabled,v.intervalHours,v.requestIntervalMs,resetSchedule])).rows[0];
   await audit(client,req.user!.id,'offer_refresh.settings_updated','global');await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}res.json(settings);
 });
 app.post('/api/admin/offer-refresh/run',async(req,res)=>res.status(202).json(await startOfferRefresh(db,req.user!.id)));
 app.get('/api/admin/offer-refresh/runs/:id',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),run=(await db.query('SELECT * FROM offer_refresh_runs WHERE id=$1',[id])).rows[0];if(!run)throw new HttpError(404,'Execução não encontrada.');
  const errors=(await db.query("SELECT i.offer_id,i.marketplace_id,i.outcome,i.error,i.finished_at,o.title FROM offer_refresh_items i LEFT JOIN offers o ON o.id=i.offer_id WHERE i.run_id=$1 AND i.error IS NOT NULL ORDER BY i.finished_at DESC LIMIT 50",[id])).rows;
  res.json({...run,errors});
 });
}
