import type {Express} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {pagedQuery} from './pagination.js';
import {requiredCategory} from './classifications.js';
const uuid=z.uuid();
const marketId=z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
const newProduct=z.strictObject({name:z.string().trim().min(1).max(300),description:z.string().max(4000).default(''),brand:z.string().trim().max(120).default(''),imageUrl:z.url().refine(v=>new URL(v).protocol==='https:','A imagem deve usar HTTPS.').nullable().default(null)});
const assignment=z.discriminatedUnion('mode',[
 z.strictObject({mode:z.literal('existing'),version:z.number().int().nonnegative(),productId:uuid}),
 z.strictObject({mode:z.literal('new'),version:z.number().int().nonnegative(),product:newProduct})
]);
async function reviewableLink(db:Pick<Database,'query'>,id:string,lock=false){
 const row=(await db.query('SELECT * FROM discovery_links WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
 if(!row)throw new HttpError(404,'Link não encontrado.');
 if(row.status!=='pending'||row.extraction_status!=='completed'||!row.confirmed_category_id)throw new HttpError(409,'Confirme a categoria antes de atribuir um produto.');
 return row;
}
export const categoryKey=(path:string[])=>JSON.stringify(path.map(s=>s.normalize('NFC').replace(/\s+/gu,' ').trim().toLowerCase()));
async function transaction<T>(db:Database,work:(c:Pick<Database,'query'>)=>Promise<T>){const c=await db.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export function registerEnrichmentAdmin(app:Express,db:Database){
 const base='/api/admin/discovery/enrichment';
 app.post(base+'/review/:id/retry',async(req,res)=>{
  z.strictObject({}).parse(req.body??{});const id=uuid.parse(req.params.id);
  const link=(await db.query('SELECT marketplace_id FROM discovery_links WHERE id=$1',[id])).rows[0];
  if(!link)throw new HttpError(404,'Link não encontrado.');

   const updated=await db.query("UPDATE discovery_links SET extraction_status='pending',extraction_error=NULL,enrichment_version=enrichment_version+1 WHERE id=$1 AND status='pending' AND extraction_status='failed' AND published_offer_id IS NULL RETURNING id",[id]);
   if(!updated.rows.length)throw new HttpError(409,'Não há falha elegível para retentativa.');
   await audit(db,req.user!.id,'discovery.retry_marked',id);res.status(202).json({id,status:'pending',executor:'extension'});return;
 });
 app.post(base+'/review/:id/archive',async(req,res)=>{const id=uuid.parse(req.params.id);await transaction(db,async c=>{if(!(await c.query("UPDATE discovery_links SET status='archived' WHERE id=$1 RETURNING id",[id])).rows.length)throw new HttpError(404,'Link não encontrado.');
await audit(c,req.user!.id,'discovery.link.archived',id);});res.json({ok:true});});
 app.get(base+'/categories',async(_req,res)=>res.json((await db.query('SELECT id,path FROM category_nodes ORDER BY normalized_path')).rows));
 app.post(base+'/categories',async(req,res)=>{
  const {categoryPath}=z.strictObject({categoryPath:z.array(requiredCategory).min(1).max(10)}).parse(req.body);
  const result=await transaction(db,async c=>{
   const row=(await c.query('SELECT names,ids FROM register_category_path($1::text[])',[categoryPath])).rows[0];
   const nodes=(row.ids as string[]).map((id,index)=>({id,path:(row.names as string[]).slice(0,index+1)}));
   const leaf=nodes.at(-1)!;await audit(c,req.user!.id,'discovery.category_tree.created',leaf.id);
   return {...leaf,nodes};
  });res.status(201).json(result);
 });
 app.get(base+'/review',async(req,res)=>{
  const f=z.object({marketplaceId:marketId.or(z.literal('')).default(''),sourceCategory:z.string().max(1000).default(''),state:z.enum(['','pending','completed','failed']).default('')}).parse(req.query);
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT l.*,p.name AS product_name,p.sku AS product_sku,m.name AS marketplace_name,cm.id AS mapping_id,cm.category_id AS suggested_category_id,n.path AS suggested_category_path,confirmed.path AS confirmed_category_path
   FROM discovery_links l JOIN marketplaces m ON m.id=l.marketplace_id LEFT JOIN category_mappings cm ON cm.marketplace_id=l.marketplace_id AND cm.source_key=l.source_category_key
   LEFT JOIN category_nodes n ON n.id=cm.category_id LEFT JOIN category_nodes confirmed ON confirmed.id=l.confirmed_category_id LEFT JOIN products p ON p.id=l.product_id
   WHERE l.status='pending' AND l.published_offer_id IS NULL AND ($1='' OR l.marketplace_id=$1) AND ($2='' OR l.extraction_status=$2) AND ($3='' OR position(lower($3) in lower(array_to_string(l.source_category_path,' > ')))>0) ORDER BY l.first_seen_at,l.id`,[f.marketplaceId,f.state,f.sourceCategory]));
 });
 app.get(base+'/review/:id/products',async(req,res)=>{
  const row=await reviewableLink(db,uuid.parse(req.params.id));
  const q=z.string().max(160).default('').parse(req.query.q);
  const search='%'+q.replaceAll('\\','\\\\').replaceAll('%',String.raw`\%`).replaceAll('_',String.raw`\_`)+'%';
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},'SELECT p.* FROM products p WHERE p.category_ids @> ARRAY[$1]::uuid[] AND (p.name ILIKE $2 OR p.sku ILIKE $2) ORDER BY p.name,p.id',[row.confirmed_category_id,search]));
 });
 app.post(base+'/review/:id/product',async(req,res)=>{
  const id=uuid.parse(req.params.id),v=assignment.parse(req.body);
  const product=await transaction(db,async c=>{
   const row=await reviewableLink(c,id,true);
   if(row.enrichment_version!==v.version)throw new HttpError(409,'Os dados foram atualizados. Reabra a revisão.');
   const category=(await c.query('SELECT path FROM category_nodes WHERE id=$1',[row.confirmed_category_id])).rows[0];
   let product;
   if(v.mode==='existing'){
    // NOWAIT avoids a lock cycle with catalog recategorization, which also invalidates assignments.
    try{product=(await c.query('SELECT * FROM products WHERE id=$1 FOR SHARE NOWAIT',[v.productId])).rows[0];}catch(error){if((error as {code?:string}).code==='55P03')throw new HttpError(409,'O produto está sendo alterado. Tente novamente.');
throw error;}
    if(!product)throw new HttpError(404,'Produto não encontrado.');
    if(!product.category_ids.includes(row.confirmed_category_id))throw new HttpError(409,'Escolha um produto da categoria confirmada ou de suas subcategorias.');
   }else{
    const p=v.product,path=category.path;
    product=(await c.query('INSERT INTO products(id,name,description,brand,category,subcategory,image_url,category_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),p.name,p.description,p.brand,path[0],path[1]??'',p.imageUrl,path])).rows[0];
    await audit(c,req.user!.id,'product.created',product.id);
   }
   await c.query('UPDATE discovery_links SET product_id=$2,product_assigned_by=$3,product_assigned_at=clock_timestamp(),enrichment_version=enrichment_version+1 WHERE id=$1',[id,product.id,req.user!.id]);
   await audit(c,req.user!.id,'discovery.product.assigned',id);
   return product;
  });res.json({product,status:'ready_for_review'});
 });
 app.post(base+'/review/:id/category',async(req,res)=>{
  const id=uuid.parse(req.params.id),v=z.strictObject({categoryId:uuid,version:z.number().int().nonnegative(),saveMapping:z.boolean().default(false)}).parse(req.body);
  await transaction(db,async c=>{
   // Same lock order as the worker prevents a confirmation/extraction race.
   const row=(await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(row?.status!=='pending'||row.extraction_status!=='completed')throw new HttpError(409,'Conclua a extração antes de categorizar.');
   if(row.enrichment_version!==v.version)throw new HttpError(409,'Os dados foram atualizados. Reabra a revisão.');
   if(!(await c.query('SELECT id FROM category_nodes WHERE id=$1',[v.categoryId])).rows.length)throw new HttpError(400,'Categoria não encontrada.');
   if(v.saveMapping&&!row.source_category_path.length)throw new HttpError(400,'Sem árvore de origem; aplique apenas neste item.');
   if(v.saveMapping)await c.query('INSERT INTO category_mappings(id,marketplace_id,source_path,source_key,category_id,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(marketplace_id,source_key) DO UPDATE SET category_id=$5,updated_by=$6,updated_at=clock_timestamp()',[randomUUID(),row.marketplace_id,row.source_category_path,row.source_category_key,v.categoryId,req.user!.id]);
   await c.query('UPDATE discovery_links SET confirmed_category_id=$2,category_confirmed_by=$3,category_confirmed_at=clock_timestamp(),enrichment_version=enrichment_version+1 WHERE id=$1',[id,v.categoryId,req.user!.id]);
   await audit(c,req.user!.id,'discovery.category.confirmed',id);
  });res.json({ok:true});
 });
 app.get(base+'/mappings',async(req,res)=>res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT cm.*,m.name AS marketplace_name,n.path AS category_path FROM category_mappings cm JOIN marketplaces m ON m.id=cm.marketplace_id JOIN category_nodes n ON n.id=cm.category_id WHERE ($1='' OR cm.marketplace_id=$1) ORDER BY cm.updated_at DESC,cm.id`,[marketId.or(z.literal('')).default('').parse(req.query.marketplaceId)])));
 app.put(base+'/mappings/:id',async(req,res)=>{const id=uuid.parse(req.params.id),v=z.strictObject({categoryId:uuid}).parse(req.body);await transaction(db,async c=>{if(!(await c.query('SELECT id FROM category_nodes WHERE id=$1',[v.categoryId])).rows.length)throw new HttpError(400,'Categoria não encontrada.');
if(!(await c.query('UPDATE category_mappings SET category_id=$2,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING id',[id,v.categoryId,req.user!.id])).rows.length)throw new HttpError(404,'Mapeamento não encontrado.');
await audit(c,req.user!.id,'discovery.mapping.updated',id);});res.json({ok:true});});
 app.delete(base+'/mappings/:id',async(req,res)=>{const id=uuid.parse(req.params.id);await transaction(db,async c=>{if(!(await c.query('DELETE FROM category_mappings WHERE id=$1 RETURNING id',[id])).rows.length)throw new HttpError(404,'Mapeamento não encontrado.');
await audit(c,req.user!.id,'discovery.mapping.deleted',id);});res.json({ok:true});});
}
