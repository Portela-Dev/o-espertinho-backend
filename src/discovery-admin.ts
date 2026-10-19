import type {Express} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {marketUrl} from './scraping.js';
import {pagedQuery} from './pagination.js';
import {defaultDiscoveryConfig,discoveryProfileInput,discoverySourceInput,type DiscoveryConfig} from './discovery-config.js';
const version=z.object({version:z.number().int().positive()});
const filters=z.object({marketplaceId:z.string().regex(/^(?:[a-z][a-z0-9_-]{1,39})?$/).default(''),q:z.string().trim().max(120).default(''),enabled:z.enum(['','true','false']).default('')});
async function hosts(db:Pick<Database,'query'>,marketplaceId:string){
 const market=(await db.query('SELECT allowed_hosts FROM marketplaces WHERE id=$1',[marketplaceId])).rows[0];
 if(!market){throw new HttpError(400,'Marketplace não encontrado.');}return market.allowed_hosts as string[];
}
function sectionUrl(value:string,allowedHosts:string[]){const u=new URL(marketUrl(value,allowedHosts));u.hash='';return u.href;}
function validateTemplate(config:DiscoveryConfig,allowedHosts:string[]){
 if(!config.pagination.urlTemplate){return;}
 const sample=config.pagination.urlTemplate.replaceAll('{page}',String(config.pagination.startPage));
 if(/[{}]/.test(sample))throw new HttpError(400,'A URL de paginação aceita apenas o marcador {page}.');
 sectionUrl(sample,allowedHosts);
}
function databaseError(error:unknown):never{
 const code=(error as {code?:string})?.code;
 if(code==='23505'){throw new HttpError(409,'Já existe uma configuração com esse nome ou URL no marketplace.');}
 if(code==='23503'){throw new HttpError(409,'O perfil não pertence ao marketplace ou está vinculado a páginas de seção.');}
 throw error;
}
async function mutate(db:Database,actor:string,action:string,work:(client:Pick<Database,'query'>)=>Promise<Record<string,unknown>>){
 const c=await db.connect();try{await c.query('BEGIN');const result=await work(c);await audit(c,actor,action,String(result.id));await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');databaseError(error);}finally{c.release();}
}
export function registerDiscoveryAdmin(app:Express,db:Database){
 app.get('/api/admin/discovery/profile-options',async(req,res)=>{const f=filters.parse(req.query);res.json((await db.query("SELECT id,name,marketplace_id FROM discovery_profiles WHERE ($1='' OR marketplace_id=$1) ORDER BY lower(name),id",[f.marketplaceId])).rows);});
 app.get('/api/admin/discovery/defaults',(_req,res)=>res.json({config:defaultDiscoveryConfig(),executionAvailable:false}));
 for(const kind of ['profiles','sources'] as const){
  const table=kind==='profiles'?'discovery_profiles':'discovery_sources';
  app.get('/api/admin/discovery/'+kind,async(req,res)=>{
   const f=filters.parse(req.query),args:unknown[]=[f.marketplaceId,f.q];
   let where=" WHERE ($1='' OR d.marketplace_id=$1) AND ($2='' OR position(lower($2) in lower(d.name))>0)";
   if(kind==='sources'){args.push(f.enabled);where+=" AND ($3='' OR d.enabled=($3='true'))";}
   const joins=kind==='sources'?' JOIN discovery_profiles p ON p.id=d.profile_id':'';
   const extra=kind==='sources'?',p.name AS profile_name':'';
   res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT d.*,m.name AS marketplace_name${extra} FROM ${table} d JOIN marketplaces m ON m.id=d.marketplace_id${joins}${where} ORDER BY lower(d.name),d.id`,args));
  });
  app.get('/api/admin/discovery/'+kind+'/:id',async(req,res)=>{const id=z.uuid().parse(req.params.id);const row=(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];if(!row){throw new HttpError(404,'Configuração não encontrada.');}res.json(row);});
  app.delete('/api/admin/discovery/'+kind+'/:id',async(req,res)=>{
   const id=z.uuid().parse(req.params.id),v=version.strict().parse(req.body);
   const result=await mutate(db,req.user!.id,'discovery.'+kind+'.deleted',async c=>{
    const row=(await c.query(`SELECT version FROM ${table} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!row){throw new HttpError(404,'Configuração não encontrada.');}
    if(row.version!==v.version){throw new HttpError(409,'A configuração mudou. Recarregue antes de excluir.');}
    await c.query(`DELETE FROM ${table} WHERE id=$1`,[id]);return {id,ok:true};
   });res.json(result);
  });
 }
 app.post('/api/admin/discovery/profiles',async(req,res)=>{
  const v=discoveryProfileInput.parse(req.body),id=randomUUID();
  const result=await mutate(db,req.user!.id,'discovery.profile.created',async c=>{const allowed=await hosts(c,v.marketplaceId);validateTemplate(v.config,allowed);return (await c.query('INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,$2,$3,$4) RETURNING *',[id,v.marketplaceId,v.name,JSON.stringify(v.config)])).rows[0];});res.status(201).json(result);
 });
 app.put('/api/admin/discovery/profiles/:id',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),v=discoveryProfileInput.extend(version.shape).parse(req.body);
  res.json(await mutate(db,req.user!.id,'discovery.profile.updated',async c=>{
   const allowed=await hosts(c,v.marketplaceId);validateTemplate(v.config,allowed);
   const row=(await c.query('UPDATE discovery_profiles SET marketplace_id=$2,name=$3,config=$4,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$5 RETURNING *',[id,v.marketplaceId,v.name,JSON.stringify(v.config),v.version])).rows[0];
   if(!row){throw new HttpError(409,'Perfil não encontrado ou alterado. Recarregue antes de salvar.');}return row;
  }));
 });
 app.post('/api/admin/discovery/sources',async(req,res)=>{
  const v=discoverySourceInput.parse(req.body),id=randomUUID();
  const result=await mutate(db,req.user!.id,'discovery.source.created',async c=>{const url=sectionUrl(v.url,await hosts(c,v.marketplaceId));return (await c.query('INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,source_category_path,enabled,interval_hours,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[id,v.marketplaceId,v.profileId,v.name,url,v.sourceCategoryPath,v.enabled,v.intervalHours,v.notes])).rows[0];});res.status(201).json(result);
 });
 app.put('/api/admin/discovery/sources/:id',async(req,res)=>{
  const id=z.uuid().parse(req.params.id),v=discoverySourceInput.extend(version.shape).parse(req.body);
  res.json(await mutate(db,req.user!.id,'discovery.source.updated',async c=>{
   const url=sectionUrl(v.url,await hosts(c,v.marketplaceId));
   const row=(await c.query('UPDATE discovery_sources SET marketplace_id=$2,profile_id=$3,name=$4,url=$5,source_category_path=$6,enabled=$7,interval_hours=$8,notes=$9,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$10 RETURNING *',[id,v.marketplaceId,v.profileId,v.name,url,v.sourceCategoryPath,v.enabled,v.intervalHours,v.notes,v.version])).rows[0];
   if(!row){throw new HttpError(409,'Página não encontrada ou alterada. Recarregue antes de salvar.');}return row;
  }));
 });
}
