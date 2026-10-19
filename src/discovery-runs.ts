import {urlNormalizationRulesSchema} from './url-normalization.js';
import type {Express} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {pagedQuery} from './pagination.js';
import {discoveryConfigSchema} from './discovery-config.js';
const id=z.uuid();
const filters=z.object({marketplaceId:z.string().regex(/^(?:[a-z][a-z0-9_-]{1,39})?$/).default(''),sourceId:z.union([z.uuid(),z.literal('')]).default(''),status:z.enum(['','pending','archived']).default('')});
const runView=`SELECT r.id,r.source_id,r.marketplace_id,r.status,r.pages,r.found,r.added,r.duplicates,r.invalid,r.current_url,r.stop_reason,r.error,r.created_at,r.started_at,r.finished_at,r.heartbeat_at,s.name AS source_name,m.name AS marketplace_name FROM discovery_runs r JOIN discovery_sources s ON s.id=r.source_id JOIN marketplaces m ON m.id=r.marketplace_id`;
export async function startDiscovery(db:Database,sourceId:string,userId:string,resume=false){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const source=(await c.query('SELECT * FROM discovery_sources WHERE id=$1 FOR UPDATE',[sourceId])).rows[0];
  if(!source){throw new HttpError(404,'Página de seção não encontrada.');}
  if((await c.query("SELECT id FROM discovery_runs WHERE source_id=$1 AND status IN ('queued','running')",[sourceId])).rows.length){throw new HttpError(409,'Esta seção já possui uma exploração em andamento.');}
  if(source.paused_at&&!resume){throw new HttpError(409,'Esta seção está pausada. Confirme a retomada para explorar novamente.');}
  const profile=(await c.query('SELECT config FROM discovery_profiles WHERE id=$1',[source.profile_id])).rows[0];
  const market=(await c.query('SELECT allowed_hosts,url_normalization_rules FROM marketplaces WHERE id=$1',[source.marketplace_id])).rows[0];
  const config=discoveryConfigSchema.parse(profile.config);
  const runId=randomUUID();
  const snapshot={config,url:source.url,allowedHosts:market.allowed_hosts,sourceCategoryPath:source.source_category_path,urlNormalizationRules:urlNormalizationRulesSchema.parse(market.url_normalization_rules)};
  await c.query('INSERT INTO discovery_runs(id,source_id,marketplace_id,created_by,snapshot) VALUES($1,$2,$3,$4,$5)',[runId,sourceId,source.marketplace_id,userId,JSON.stringify(snapshot)]);
  if(resume)await c.query('UPDATE discovery_sources SET paused_at=NULL,pause_reason=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1',[sourceId]);
  await audit(c,userId,'discovery.run.started',runId);
  await c.query('COMMIT');return (await db.query(runView+' WHERE r.id=$1',[runId])).rows[0];
 }catch(error){await c.query('ROLLBACK');if((error as {code?:string}).code==='23505')throw new HttpError(409,'Esta seção já possui uma exploração em andamento.');throw error;}finally{c.release();}
}
export async function cancelDiscovery(db:Database,runId:string,userId:string){
 const c=await db.connect();
 try{
  await c.query('BEGIN');
  const run=(await c.query('SELECT status FROM discovery_runs WHERE id=$1 FOR UPDATE',[runId])).rows[0];
  if(!run){throw new HttpError(404,'Execução não encontrada.');}
  if(run.status!=='cancelled'){
   if(!['queued','running'].includes(run.status)){throw new HttpError(409,'Esta exploração já terminou.');}
   await c.query("UPDATE discovery_runs SET status='cancelled',stop_reason='cancelled',finished_at=clock_timestamp(),cancelled_by=$2,worker_id=NULL,lease_until=NULL WHERE id=$1",[runId,userId]);
   await audit(c,userId,'discovery.run.cancelled',runId);
  }
  await c.query('COMMIT');return (await db.query(runView+' WHERE r.id=$1',[runId])).rows[0];
 }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export function registerDiscoveryRuns(app:Express,db:Database){
 app.post('/api/admin/discovery/sources/:id/run',async(req,res)=>{const input=z.strictObject({resume:z.boolean().default(false)}).parse(req.body);res.status(202).json(await startDiscovery(db,id.parse(req.params.id),req.user!.id,input.resume));});
 app.get('/api/admin/discovery/runs',async(req,res)=>{
  const f=filters.parse(req.query);
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},runView+" WHERE ($1='' OR r.marketplace_id=$1) AND ($2='' OR r.source_id::text=$2) ORDER BY r.created_at DESC,r.id",[f.marketplaceId,f.sourceId]));
 });
 app.get('/api/admin/discovery/runs/:id',async(req,res)=>{
  const run=(await db.query(runView+' WHERE r.id=$1',[id.parse(req.params.id)])).rows[0];if(!run){throw new HttpError(404,'Execução não encontrada.');}res.json(run);
 });
 app.get('/api/admin/discovery/runs/:id/events',async(req,res)=>{const runId=id.parse(req.params.id);res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT id,kind,message,created_at FROM discovery_run_events WHERE run_id=$1 ORDER BY created_at DESC,id',[runId]));});
 app.post('/api/admin/discovery/runs/:id/cancel',async(req,res)=>res.json(await cancelDiscovery(db,id.parse(req.params.id),req.user!.id)));
 app.get('/api/admin/discovery/links',async(req,res)=>{
  const f=filters.parse(req.query),runId=z.union([z.uuid(),z.literal('')]).default('').parse(req.query.runId);
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT l.id,l.url,l.marketplace_id,m.name AS marketplace_name,l.status,l.first_seen_at,l.last_seen_at,
   (SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'categoryPath',s.source_category_path) ORDER BY s.name) FROM discovery_link_sources ls JOIN discovery_sources s ON s.id=ls.source_id WHERE ls.link_id=l.id) AS sources
   FROM discovery_links l JOIN marketplaces m ON m.id=l.marketplace_id WHERE ($1='' OR l.marketplace_id=$1) AND ($2='' OR l.status=$2)
   AND ($3='' OR EXISTS(SELECT 1 FROM discovery_link_sources ls WHERE ls.link_id=l.id AND ls.source_id::text=$3))
   AND ($4='' OR EXISTS(SELECT 1 FROM discovery_run_links rl WHERE rl.link_id=l.id AND rl.run_id::text=$4)) ORDER BY l.last_seen_at DESC,l.id`,[f.marketplaceId,f.status,f.sourceId,runId]));
 });
 app.post('/api/admin/discovery/links/:id/archive',async(req,res)=>{
  const linkId=id.parse(req.params.id),c=await db.connect();try{await c.query('BEGIN');const row=(await c.query("UPDATE discovery_links SET status='archived' WHERE id=$1 RETURNING id",[linkId])).rows[0];if(!row){throw new HttpError(404,'Link não encontrado.');}await audit(c,req.user!.id,'discovery.link.archived',linkId);await c.query('COMMIT');res.json({ok:true});}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 });
}
