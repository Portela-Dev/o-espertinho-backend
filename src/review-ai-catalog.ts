import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {audit} from './offers.js';
export type CatalogQuery=Pick<Database,'query'>;
export const identityKey=(name:string,brand='')=>[name,brand].map(s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()).join('|');
const categoryKey=(path:string[])=>path.map(s=>identityKey(s).split('|')[0].split(' ').map(t=>t.length>4?t.replace(/s$/,''):t).join(' ')).join('>');
export async function inventoryRevision(c:CatalogQuery,lock=false){return (await c.query('SELECT revision::text AS revision FROM review_ai_inventory_state WHERE id=true'+(lock?' FOR UPDATE':''))).rows[0].revision as string;}
export const inventoryInput=z.strictObject({kind:z.enum(['categories','products','drafts']),cursor:z.uuid().optional(),revision:z.string().regex(/^\d+$/).optional(),limit:z.coerce.number().int().min(1).max(500).default(250)});
export async function inventoryPage(c:CatalogQuery,input:unknown){
 const v=inventoryInput.parse(input),revision=await inventoryRevision(c);
 if(v.revision&&v.revision!==revision)throw new HttpError(409,'O catálogo mudou. Atualize o inventário e inicie o lote novamente.');
 const table={categories:'category_nodes',products:'products',drafts:'review_ai_product_drafts'}[v.kind];
 const columns=v.kind==='categories'?'id,path':'id,name,brand,description,image_url'+(v.kind==='products'?',category_path':'');
 const rows=(await c.query('SELECT '+columns+' FROM '+table+' WHERE ($1::uuid IS NULL OR id>$1::uuid)'+(v.kind==='drafts'?' AND product_id IS NULL':'')+' ORDER BY id LIMIT $2',[v.cursor??null,v.limit+1])).rows;
 if(await inventoryRevision(c)!==revision)throw new HttpError(409,'O catálogo mudou durante a leitura. Carregue o inventário novamente.');
 const items=rows.slice(0,v.limit).map(row=>({...row,...(v.kind==='categories'?{}:{kind:v.kind==='drafts'?'draft':'product'})}));
 return {items,revision,nextCursor:rows.length>v.limit?items.at(-1)!.id:null};
}
export async function assignCatalogProduct(c:CatalogQuery,linkId:string,product:any,userId:string){
 const categoryId=product.category_ids.at(-1);
 // Category changes invalidate assignment in a BEFORE trigger, so use two writes inside the transaction.
 await c.query('UPDATE discovery_links SET confirmed_category_id=$2,category_confirmed_by=$3,category_confirmed_at=clock_timestamp() WHERE id=$1',[linkId,categoryId,userId]);
 await c.query('UPDATE discovery_links SET product_id=$2,product_draft_id=NULL,product_assigned_by=$3,product_assigned_at=clock_timestamp(),enrichment_version=enrichment_version+1 WHERE id=$1',[linkId,product.id,userId]);
 await audit(c,userId,'discovery.product.assigned',linkId);
}
export async function catalogDraft(c:CatalogQuery,link:any,product:any,userId:string){
 const key=identityKey(product.name,product.brand),known=(await c.query('SELECT * FROM products ORDER BY id')).rows.find(p=>identityKey(p.name,p.brand)===key);
 if(known){await assignCatalogProduct(c,link.id,known,userId);return {outcome:'linked',product:known};}
 const image=(link.enrichment_data.images??[]).find((url:string)=>url.startsWith('https://'))??null;
 const draft=(await c.query(`INSERT INTO review_ai_product_drafts(id,identity_key,name,description,brand,image_url,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
 ON CONFLICT(identity_key) DO UPDATE SET identity_key=EXCLUDED.identity_key RETURNING *`,[randomUUID(),key,product.name,product.description,product.brand,image,userId])).rows[0];
 if(draft.product_id){const p=(await c.query('SELECT * FROM products WHERE id=$1',[draft.product_id])).rows[0];await assignCatalogProduct(c,link.id,p,userId);return {outcome:'linked',product:p};}
 await c.query('UPDATE discovery_links SET product_draft_id=$2,enrichment_version=enrichment_version+1 WHERE id=$1',[link.id,draft.id]);
 await audit(c,userId,'review_ai.product_draft',draft.id);return {outcome:'drafted',draft};
}
export async function finalizeCatalogDraft(c:CatalogQuery,draftId:string,categoryId:string,userId:string){
 const draft=(await c.query('SELECT * FROM review_ai_product_drafts WHERE id=$1 FOR UPDATE',[draftId])).rows[0];
 if(!draft||draft.product_id)throw new HttpError(409,'O rascunho já foi resolvido. Atualize a revisão.');
 const category=(await c.query('SELECT path FROM category_nodes WHERE id=$1',[categoryId])).rows[0];
 if(!category)throw new HttpError(400,'Categoria não encontrada.');
 let product=(await c.query('SELECT * FROM products ORDER BY id')).rows.find(p=>identityKey(p.name,p.brand)===draft.identity_key);
 if(!product){product=(await c.query('INSERT INTO products(id,name,description,brand,image_url,category_path,category,subcategory) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),draft.name,draft.description,draft.brand,draft.image_url,category.path,category.path[0],category.path[1]??''])).rows[0];await audit(c,userId,'product.created',product.id);}
 const links=(await c.query("SELECT id FROM discovery_links WHERE product_draft_id=$1 AND product_id IS NULL AND status='pending' AND published_offer_id IS NULL AND extraction_status='completed' ORDER BY id FOR UPDATE",[draftId])).rows;
 for(const link of links)await assignCatalogProduct(c,link.id,product,userId);
 await c.query('UPDATE discovery_links SET product_draft_id=NULL,enrichment_version=enrichment_version+1 WHERE product_draft_id=$1 AND product_id IS NULL',[draftId]);
 await c.query('UPDATE review_ai_product_drafts SET product_id=$2,version=version+1 WHERE id=$1',[draftId,product.id]);
 await audit(c,userId,'review_ai.draft_finalized',draftId);return {outcome:'categorized',product,removeDraftIds:[draftId],affectedLinks:links.length};
}
export async function resolveAiCategory(c:CatalogQuery,suggestion:any){
 if(suggestion.action==='use_category'){
  const category=(await c.query('SELECT id,path FROM category_nodes WHERE id=$1',[suggestion.categoryId])).rows[0];
  if(!category)throw new HttpError(409,'Categoria inexistente no inventário.');return category;
 }
 const path=z.array(z.string().trim().min(1).max(80)).min(1).max(10).parse(suggestion.category.split('>').map((p:string)=>p.trim()));
 const existing=(await c.query('SELECT id,path FROM category_nodes ORDER BY normalized_path')).rows.find(node=>categoryKey(node.path)===categoryKey(path));
 if(existing)return existing;
 const registered=(await c.query('SELECT names,ids FROM register_category_path($1::text[])',[path])).rows[0];return {id:registered.ids.at(-1),path:registered.names};
}
export async function inventoryDelta(c:CatalogQuery,result:any){
 const categories=result.product?(await c.query('SELECT id,path FROM category_nodes WHERE id=ANY($1::uuid[])',[result.product.category_ids])).rows:[];
 return {revision:await inventoryRevision(c),categories,products:result.product?[{...result.product,kind:'product'}]:[],drafts:result.draft?[{...result.draft,kind:'draft'}]:[],removeDraftIds:result.removeDraftIds??[]};
}
