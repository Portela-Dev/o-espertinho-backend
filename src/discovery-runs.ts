import type {Express} from 'express';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {pagedQuery} from './pagination.js';
const id=z.uuid();
const filters=z.object({marketplaceId:z.string().regex(/^(?:[a-z][a-z0-9_-]{1,39})?$/).default(''),sourceId:z.union([z.uuid(),z.literal('')]).default(''),status:z.enum(['','pending','archived']).default('')});
export function registerDiscoveryRuns(app:Express,db:Database){
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
