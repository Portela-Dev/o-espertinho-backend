import type {Express} from 'express';
import type {Database} from './db.js';
import {z} from 'zod';
import {pagedQuery} from './pagination.js';
import {catalogTransaction,expireRuns} from './catalog-runs.js';
import {allowStep} from './catalog-contracts.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
export function registerCatalogAdmin(app:Express,db:Database){
 app.get('/api/admin/extension-catalog/runs',async(req,res)=>{
  await expireRuns(db);const f=z.object({marketplaceId:z.string().max(40).default('')}).parse(req.query);
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT r.id,r.marketplace_id,m.name AS marketplace_name,r.step,r.status,r.reason,r.created_at,r.updated_at,
   (SELECT count(*)::int FROM extension_catalog_items WHERE run_id=r.id) AS total,
   (SELECT count(*)::int FROM extension_catalog_items WHERE run_id=r.id AND status='completed') AS completed,
   (SELECT count(*)::int FROM extension_catalog_items WHERE run_id=r.id AND status='failed') AS failed
   FROM extension_catalog_runs r JOIN marketplaces m ON m.id=r.marketplace_id WHERE ($1='' OR r.marketplace_id=$1) ORDER BY r.created_at DESC,r.id`,[f.marketplaceId]));
 });
 app.get('/api/admin/extension-catalog/runs/:id/items',async(req,res)=>{res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT id,target_id,status,error,updated_at FROM extension_catalog_items WHERE run_id=$1 ORDER BY id',[z.uuid().parse(req.params.id)]));});
 app.post('/api/admin/extension-catalog/runs/:id/cancel',async(req,res)=>{
  const id=z.uuid().parse(req.params.id);await catalogTransaction(db,async c=>{
   const run=(await c.query('SELECT * FROM extension_catalog_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!run||(req.user!.role!=='admin'&&run.created_by!==req.user!.id))throw new HttpError(404,'Execução não encontrada.');
   allowStep({id:req.user!.id,extension_session_id:'',permissions:req.user!.permissions??[]},run.step);
   if(['completed','failed'].includes(run.status))throw new HttpError(409,'Execução já encerrada.');
   await c.query("UPDATE extension_catalog_runs SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1",[id]);
   await c.query("UPDATE extension_catalog_items SET status='skipped',lease_until=NULL WHERE run_id=$1 AND status IN ('pending','leased')",[id]);
   await audit(c,req.user!.id,'extension_catalog.cancel',id);
  });res.json({ok:true});
 });
}
