import {publicHttpsUrlSchema} from './public-url.js';
import {pagedQuery,wantsPage} from './pagination.js';
import type {Express} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {requiredCategory,classificationText} from './classifications.js';
import {audit} from './offers.js';
const uuid=z.uuid();
const productSchema=z.object({name:z.string().trim().min(1).max(300),description:z.string().max(4000).default(''),brand:z.string().trim().max(120).default(''),model:z.string().trim().max(120).default(''),category:requiredCategory.optional(),categoryPath:z.array(requiredCategory).min(1).max(10).optional(),subcategory:classificationText.default(''),imageUrl:publicHttpsUrlSchema.nullable().default(null)}).refine(v=>!!v.categoryPath?.length||!!v.category,{message:'Informe uma categoria.',path:['categoryPath']});
export async function getProduct(db:Pick<Database,'query'>,id:string){
 const p=(await db.query('SELECT * FROM products WHERE id=$1',[uuid.parse(id)])).rows[0];
 if(!p)throw new HttpError(404,'Produto nÃ£o encontrado. Cadastre-o na aba Produtos antes de adicionar links.');return p;
}
const publicColumns='p.id,p.name,p.description,p.brand,p.model,p.category,p.subcategory,p.category_path,p.category_ids,p.image_url,p.created_at,p.updated_at';
const valid="o.status='published' AND o.availability_status='available' AND o.affiliate_url IS NOT NULL";
const reviewColumns='reviews.rating,reviews.review_count,reviews.rating_marketplace_name';
const reviewSource=`SELECT o.rating,o.review_count,m.name AS rating_marketplace_name FROM offers o JOIN marketplaces m ON m.id=o.marketplace_id WHERE o.product_id=p.id AND ${valid} AND o.rating IS NOT NULL AND o.review_count>0 ORDER BY o.review_count DESC,o.rating DESC,o.id LIMIT 1`;
export function registerPublicProducts(app:Express,db:Database){
 app.get('/api/category-tree',async(_req,res)=>res.json((await db.query(`SELECT id,path,cardinality(path) AS depth FROM category_nodes ORDER BY path`)).rows));
 app.get('/api/products',async(req,res)=>{
  const f=z.object({q:z.string().max(160).default(''),marketplace:z.string().max(40).default(''),category:z.string().max(80).default(''),categoryId:z.union([z.uuid(),z.literal('')]).default(''),maxPrice:z.coerce.number().int().min(0).max(100000000).default(0),sort:z.enum(['recent','price_asc','discount']).default('recent'),page:z.coerce.number().int().min(1).max(10000).default(1)}).parse(req.query);
  const args:unknown[]=[],conditions:string[]=[];
  const add=(sql:string,v:unknown)=>{args.push(v);conditions.push(sql.replaceAll('?',`$${args.length}`));};
  if(f.q)add("(p.name ILIKE ? OR p.brand ILIKE ? OR p.model ILIKE ?)",'%'+f.q.replaceAll('\\','\\\\').replaceAll('%','\\%').replaceAll('_','\\_')+'%');
  if(f.categoryId)add('p.category_ids @> ARRAY[?]::uuid[]',f.categoryId);else if(f.category)add('p.category=?',f.category);
  if(f.marketplace)add(`EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id AND ${valid} AND o.marketplace_id=?)`,f.marketplace);
  if(f.maxPrice)add('summary.min_price_cents<=?',f.maxPrice);
  const from=`FROM products p JOIN LATERAL (SELECT min(o.price_cents)::int AS min_price_cents,max(o.price_cents)::int AS max_price_cents,count(*)::int AS offer_count,max(o.published_at) AS latest,max(CASE WHEN o.featured THEN 1 ELSE 0 END) AS featured,max(COALESCE((o.original_price_cents-o.price_cents)::float/NULLIF(o.original_price_cents,0),0)) AS discount FROM offers o WHERE o.product_id=p.id AND ${valid}) summary ON summary.offer_count>0 LEFT JOIN LATERAL (${reviewSource}) reviews ON true`;
  const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
  const total=(await db.query(`SELECT count(*)::int AS total ${from}${where}`,args)).rows[0].total;
  const order=f.sort==='price_asc'?'summary.min_price_cents ASC':f.sort==='discount'?'summary.discount DESC':'summary.featured DESC,summary.latest DESC NULLS LAST';
  const items=(await db.query(`SELECT ${publicColumns},${reviewColumns},summary.min_price_cents,summary.max_price_cents,summary.offer_count,(SELECT COALESCE(jsonb_agg(to_jsonb(stores) ORDER BY stores.name,stores.id),'[]'::jsonb) FROM (SELECT m.id,m.name,m.website_url,m.logo_url FROM marketplaces m WHERE EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id AND o.marketplace_id=m.id AND ${valid})) stores) AS marketplaces,COALESCE(p.image_url,(SELECT image_url FROM offers o WHERE o.product_id=p.id AND ${valid} AND image_url IS NOT NULL ORDER BY o.price_cents,o.id LIMIT 1)) AS display_image_url ${from}${where} ORDER BY ${order},p.id LIMIT 24 OFFSET $${args.length+1}`,[...args,(f.page-1)*24])).rows;
  res.json({items,total,page:f.page,pageSize:24});
 });
 app.get('/api/products/:id',async(req,res)=>{
  const product=await getProduct(db,String(req.params.id));
  const reviews=(await db.query(`SELECT ${reviewColumns} FROM products p LEFT JOIN LATERAL (${reviewSource}) reviews ON true WHERE p.id=$1`,[product.id])).rows[0];
  if(wantsPage(req.query)){
   const result=await pagedQuery(db,req.query,`SELECT o.*,m.name AS marketplace_name,m.logo_url AS marketplace_logo_url FROM offers o JOIN marketplaces m ON m.id=o.marketplace_id WHERE o.product_id=$1 AND ${valid} ORDER BY o.price_cents,o.id`,[product.id]);
   const summary=(await db.query(`SELECT min(o.price_cents)::int AS min_price_cents,max(o.price_cents)::int AS max_price_cents FROM offers o WHERE o.product_id=$1 AND ${valid}`,[product.id])).rows[0];
   const image=(await db.query(`SELECT image_url FROM offers o WHERE o.product_id=$1 AND ${valid} AND image_url IS NOT NULL ORDER BY o.price_cents,o.id LIMIT 1`,[product.id])).rows[0]?.image_url;
   const {sku:_sku,...publicProduct}=product;
   res.json({...publicProduct,...reviews,...summary,available:result.total>0,status:result.total?'available':'unavailable',offers:result.items,offer_count:result.total,page:result.page,pageSize:result.pageSize,display_image_url:product.image_url??image??null});return;
  }
  const offers=(await db.query(`SELECT o.*,m.name AS marketplace_name,m.logo_url AS marketplace_logo_url FROM offers o JOIN marketplaces m ON m.id=o.marketplace_id WHERE o.product_id=$1 AND ${valid} ORDER BY o.price_cents,o.id`,[product.id])).rows;
  const {sku:_internalCode,...publicProduct}=product;
  res.json({...publicProduct,...reviews,available:offers.length>0,status:offers.length?'available':'unavailable',min_price_cents:offers[0]?.price_cents??null,max_price_cents:offers.at(-1)?.price_cents??null,offers,display_image_url:product.image_url??offers.find(o=>o.image_url)?.image_url??null});
 });
}
export function registerProductAdmin(app:Express,db:Database){
 app.get('/api/admin/category-tree',async(_req,res)=>res.json((await db.query('SELECT id,path,cardinality(path) AS depth FROM category_nodes ORDER BY path')).rows));
 app.get('/api/admin/products',async(req,res)=>{
  const q=z.string().max(160).default('').parse(req.query.q);
  res.json(await pagedQuery(db,req.query,`SELECT p.*,(SELECT count(*)::int FROM offers o WHERE o.product_id=p.id) AS link_count,(SELECT count(*)::int FROM offers o WHERE o.product_id=p.id AND ${valid}) AS available_count FROM products p WHERE p.name ILIKE $1 OR p.sku ILIKE $1 ORDER BY p.created_at DESC,p.id`,['%'+q.replaceAll('%',String.raw`\%`).replaceAll('_',String.raw`\_`)+'%']));
 });
 const save=async(req:any,res:any)=>{
  const v=productSchema.parse(req.body),id=req.params.id?uuid.parse(req.params.id):randomUUID(),client=await db.connect();let product;
  try{
   await client.query('BEGIN');
   if(req.params.id){const current=(await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!current)throw new HttpError(404,'Produto nÃ£o encontrado.');const expected=z.iso.datetime().parse(req.body.expectedUpdatedAt);if(new Date(current.updated_at).getTime()!==new Date(expected).getTime())throw new HttpError(409,'O produto foi alterado. Recarregue antes de salvar.');}
   const path=v.categoryPath??[v.category!,...(v.subcategory?[v.subcategory]:[])];
   const c={category:path[0],subcategory:path[1]??''};
   const args=[id,v.name,v.description,v.brand,v.model,c.category,c.subcategory,v.imageUrl,path];
   product=(await client.query(req.params.id?'UPDATE products SET name=$2,description=$3,brand=$4,model=$5,category=$6,subcategory=$7,image_url=$8,category_path=$9,updated_at=clock_timestamp() WHERE id=$1 RETURNING *':'INSERT INTO products(id,name,description,brand,model,category,subcategory,image_url,category_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',args)).rows[0];
   await audit(client,req.user.id,req.params.id?'product.updated':'product.created',id);await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  res.status(req.params.id?200:201).json(product);
 };
 app.post('/api/admin/products',save);app.put('/api/admin/products/:id',save);
 app.put('/api/admin/offers/:id/product',async(req,res)=>{
  const id=uuid.parse(req.params.id),v=z.object({productId:uuid,expectedUpdatedAt:z.iso.datetime()}).parse(req.body),client=await db.connect();
  try{await client.query('BEGIN');const o=(await client.query('SELECT * FROM offers WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!o)throw new HttpError(404,'Oferta nÃ£o encontrada.');if(new Date(o.updated_at).getTime()!==new Date(v.expectedUpdatedAt).getTime())throw new HttpError(409,'A oferta foi alterada. Atualize a lista.');await getProduct(client,v.productId);await client.query("UPDATE offers SET product_id=$2,status='pending',updated_at=clock_timestamp() WHERE id=$1",[id,v.productId]);await audit(client,req.user!.id,'offer.product_changed',id);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}res.json({ok:true});
 });
}
