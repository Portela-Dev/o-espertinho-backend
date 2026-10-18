import {pagedQuery} from './pagination.js';
import type {Express} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {audit} from './offers.js';
import {HttpError} from './security.js';

type Queryable=Pick<Database,'query'>;
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
export async function cancelOfferRefresh(db:Database,runId:string,userId:string){
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT id FROM offer_refresh_settings WHERE id=true FOR UPDATE');
  const run=(await client.query('SELECT * FROM offer_refresh_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
  if(!run)throw new HttpError(404,'Execução não encontrada.');
  if(run.status==='cancelled'){await client.query('COMMIT');return run;}
  if(run.status==='completed')throw new HttpError(409,'Esta atualização já foi concluída. Atualize o painel.');
  const remaining=(await client.query("UPDATE offer_refresh_items SET status='done',outcome='skipped',error='Execução cancelada pelo administrador.',attempt_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE run_id=$1 AND status<>'done' RETURNING id",[runId])).rows.length;
  const cancelled=(await client.query("UPDATE offer_refresh_runs SET status='cancelled',cancelled_at=clock_timestamp(),cancelled_by=$2,finished_at=clock_timestamp(),processed=processed+$3,skipped=skipped+$3 WHERE id=$1 RETURNING *",[runId,userId,remaining])).rows[0];
  await advanceSchedule(client);
  await audit(client,userId,'offer_refresh.cancelled',runId);
  await client.query('COMMIT');return cancelled;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function activeProgress(db:Database,run:any){
 if(!run)return null;
 const state=(await db.query(`SELECT next_item_at>clock_timestamp() AS waiting,
 EXISTS(SELECT 1 FROM offer_refresh_items WHERE run_id=$1 AND status='running') AS extracting,
 (SELECT outcome FROM offer_refresh_items WHERE run_id=$1 AND status='done' ORDER BY finished_at DESC,id DESC LIMIT 1) AS last_outcome
 FROM offer_refresh_runs WHERE id=$1 AND status IN ('queued','running')`,[run.id])).rows[0];
 if(!state)return null;
 let phase='queued';
 if(state.extracting){phase='extracting';}else if(state.waiting){phase='paused';}
 const pauseReason=state.last_outcome==='pending'?'technical_failure':'interval';
 return {...run,phase,pause_reason:phase==='paused'?pauseReason:null};
}
export function registerOfferRefreshAdmin(app:Express,db:Database){
 app.get('/api/admin/offer-refresh',async(req,res)=>{
  const settings=(await db.query('SELECT * FROM offer_refresh_settings WHERE id=true')).rows[0];
  const result=await pagedQuery(db,req.query,'SELECT * FROM offer_refresh_runs ORDER BY created_at DESC,id',[],20);
  const active=(await db.query("SELECT * FROM offer_refresh_runs WHERE status IN ('queued','running') LIMIT 1")).rows[0];
  res.json({settings,active:await activeProgress(db,active),...(Array.isArray(result)?{runs:result}:{...result,runs:result.items})});
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
 app.post('/api/admin/offer-refresh/runs/:id/cancel',async(req,res)=>res.json(await cancelOfferRefresh(db,z.uuid().parse(req.params.id),req.user!.id)));
 app.get('/api/admin/offer-refresh/runs/:id',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),run=(await db.query('SELECT * FROM offer_refresh_runs WHERE id=$1',[id])).rows[0];if(!run)throw new HttpError(404,'Execução não encontrada.');
  const result=await pagedQuery(db,req.query,"SELECT i.offer_id,i.marketplace_id,i.outcome,i.error,i.finished_at,o.title FROM offer_refresh_items i LEFT JOIN offers o ON o.id=i.offer_id WHERE i.run_id=$1 AND i.error IS NOT NULL ORDER BY i.finished_at DESC,i.id",[id],50);
  res.json({...run,...(Array.isArray(result)?{errors:result}:{...result,total:run.total,errorTotal:result.total,errors:result.items})});
 });
}
