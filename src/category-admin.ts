import type {Express} from 'express';
import type {Database} from './db.js';
import {z} from 'zod';
import {categoryApply,categoryOperation} from './category-contracts.js';
import {categoryPlan,categoryRevision,categoryKey,type CategorySnapshot} from './category-plan.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
import {pagedQuery} from './pagination.js';
type Connection=Pick<Database,'query'>;
async function snapshot(db:Connection):Promise<CategorySnapshot>{
 const nodes=(await db.query('SELECT id,path,normalized_path FROM category_nodes ORDER BY id')).rows;
 const products=(await db.query('SELECT id,category_path,category_ids,updated_at FROM products ORDER BY id')).rows;
 const offers=(await db.query('SELECT id,product_id,updated_at FROM offers ORDER BY id')).rows;
 const links=(await db.query('SELECT id,product_id,confirmed_category_id,product_assigned_by,product_assigned_at,category_confirmed_by,category_confirmed_at,enrichment_version FROM discovery_links ORDER BY id')).rows;
 const mappings=(await db.query('SELECT id,category_id,updated_at FROM category_mappings ORDER BY id')).rows;
 const filters=(await db.query('SELECT id,filters FROM saved_filters ORDER BY id')).rows;
 return {nodes,products,offers,links,mappings,filters};
}
type CategoryPlan=ReturnType<typeof categoryPlan>;
async function updateTree(db:Connection,plan:CategoryPlan){
 // Free unique keys first: merging into an ancestor can reuse a removed node's
 // old path. Temporary keys never leave this transaction.
 await db.query("UPDATE category_nodes SET normalized_path=array_fill('category-admin-'||gen_random_uuid()::text,ARRAY[cardinality(path)]) WHERE id=ANY($1::uuid[])",[plan.branch.map(n=>n.id)]);
 for(const old of plan.branch){
  const node=plan.destinations.get(old.id);
  if(node?.id===old.id)await db.query('UPDATE category_nodes SET path=$2,normalized_path=$3 WHERE id=$1',[node.id,node.path,node.normalized_path]);
 }
}
async function updateProducts(db:Connection,plan:CategoryPlan){
 const productPaths=new Map<string,string[]>();
 for(const product of plan.affectedProducts){
  const node=plan.destinations.get(product.category_ids.at(-1)!);
  if(!node)throw new HttpError(409,'Destino de produto não encontrado. Refaça a prévia.');
  await db.query('UPDATE products SET category_path=$2,updated_at=clock_timestamp() WHERE id=$1',[product.id,node.path]);
  productPaths.set(product.id,node.path);
 }
 return productPaths;
}
function confirmedCategory(plan:CategoryPlan,link:CategorySnapshot['links'][number],path:string[]|undefined){
 const categoryId=plan.destinations.get(link.confirmed_category_id??'')?.id??link.confirmed_category_id;
 if(!path)return categoryId;
 const category=plan.finalNodes.find(n=>n.id===categoryId);
 if(category?.normalized_path.every((v,i)=>path[i]?.toLowerCase()===v))return categoryId;
 return plan.finalNodes.find(n=>categoryKey(n.path)===categoryKey(path))!.id;
}
async function updateLinks(db:Connection,plan:CategoryPlan,paths:Map<string,string[]>){
 // Triggers invalidate manual assignments. Restore only the assignments captured
 // inside this locked transaction, after validating the new ancestry.
 for(const link of plan.affectedLinks){
  const categoryId=confirmedCategory(plan,link,paths.get(link.product_id??''));
  await db.query('UPDATE discovery_links SET confirmed_category_id=$2,enrichment_version=enrichment_version+1 WHERE id=$1',[link.id,categoryId]);
  await db.query('UPDATE discovery_links SET product_id=$2,product_assigned_by=$3,product_assigned_at=$4 WHERE id=$1',[link.id,link.product_id,link.product_assigned_by,link.product_assigned_at]);
 }
}
async function applyPlan(db:Connection,plan:CategoryPlan){
 await updateTree(db,plan);
 const productPaths=await updateProducts(db,plan);
 for(const mapping of plan.affectedMappings){
  const destination=plan.destinations.get(mapping.category_id)!;
  await db.query('UPDATE category_mappings SET category_id=$2,updated_at=clock_timestamp() WHERE id=$1',[mapping.id,destination.id]);
 }
 await updateLinks(db,plan,productPaths);
 for(const filter of plan.affectedFilters){
  const destination=plan.destinations.get(filter.filters.categoryId||plan.source.id)!;
  await db.query('UPDATE saved_filters SET filters=$2 WHERE id=$1',[filter.id,{...filter.filters,category:'',categoryId:destination.id}]);
 }
 if(plan.removed.length)await db.query('DELETE FROM category_nodes WHERE id=ANY($1::uuid[])',[plan.removed]);
 // Keep the old two-level suggestion endpoint consistent with the authoritative tree.
 await db.query('DELETE FROM offer_category_options');
 await db.query("INSERT INTO offer_category_options(category,subcategory) SELECT DISTINCT path[1],CASE WHEN cardinality(path)=1 THEN '' ELSE path[2] END FROM category_nodes ON CONFLICT DO NOTHING");
}
export function registerCategoryAdmin(app:Express,db:Database){
 app.get('/api/admin/categories',async(req,res)=>{
  const q=z.string().trim().max(160).default('').parse(req.query.q);
  const search = '%' + q.replaceAll(/[\\%_]/g, String.raw`\$&`) + '%';
  res.json(await pagedQuery(db,{...req.query,paginate:'true'},`SELECT n.id,n.path,cardinality(n.path) AS depth,
    (SELECT count(*)::int FROM products p WHERE n.id=ANY(p.category_ids)) AS product_count,
    (SELECT count(*)::int FROM category_nodes c WHERE c.normalized_path[1:cardinality(n.path)]=n.normalized_path AND c.id<>n.id) AS descendant_count
    FROM category_nodes n WHERE array_to_string(n.path,' › ') ILIKE $1 ORDER BY n.normalized_path,n.id`,[search]));
 });
 app.post('/api/admin/categories/preview',async(req,res)=>{
  const input=categoryOperation.parse(req.body),c=await db.connect();
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const plan=categoryPlan(await snapshot(c),input);
   await c.query('COMMIT');res.json(plan.preview);
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
 });
 app.post('/api/admin/categories/apply',async(req,res)=>{
  const {revision,confirm,...input}=categoryApply.parse(req.body),c=await db.connect();
  try{
   await c.query('BEGIN');
   await c.query("SET LOCAL lock_timeout='5s'");
   // Administrative operations are rare; block concurrent writes while remapping
   // arrays and foreign keys, rather than allowing partial/stale reassignment.
   await c.query('LOCK TABLE products,offers,category_nodes,category_mappings,discovery_links,saved_filters,offer_category_options IN SHARE ROW EXCLUSIVE MODE');
   const current=await snapshot(c);
   if(categoryRevision(current,input)!==revision)throw new HttpError(409,'O catálogo mudou desde a prévia. Gere uma nova prévia antes de confirmar.');
   const plan=categoryPlan(current,input);
   await applyPlan(c,plan);
   await audit(c,req.user!.id,'category.'+input.action,input.sourceId);
   await c.query('COMMIT');res.json({applied:true,impact:plan.impact});
  }catch(error){
   await c.query('ROLLBACK');
   if(['40P01','55P03','23505'].includes((error as {code:string}).code))throw new HttpError(409,'Outra alteração está em andamento. Atualize a lista e gere uma nova prévia.');
   throw error;
  }finally{c.release();}
 });
}
