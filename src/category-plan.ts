import {createHash} from 'node:crypto';
import {HttpError} from './security.js';
import type {CategoryNode,CategoryOperation} from './category-contracts.js';
interface ProductReference {id:string;category_path:string[];category_ids:string[];updated_at:string|Date}
interface OfferReference {id:string;product_id:string;updated_at:string|Date}
interface LinkReference {
 id:string;product_id:string|null;confirmed_category_id:string|null;
 product_assigned_by:string|null;product_assigned_at:string|Date|null;
 category_confirmed_by:string|null;category_confirmed_at:string|Date|null;enrichment_version:number;
}
interface MappingReference {id:string;category_id:string;updated_at:string|Date}
interface FilterReference {id:string;filters:Record<string,unknown>&{categoryId?:string;category?:string}}
export interface CategorySnapshot {
 nodes:CategoryNode[];products:ProductReference[];offers:OfferReference[];
 links:LinkReference[];mappings:MappingReference[];filters:FilterReference[];
}
export const categoryKey=(path:string[])=>JSON.stringify(path.map(p=>p.toLowerCase()));
export const isWithin=(node:CategoryNode,parent:CategoryNode)=>parent.normalized_path.every((part,i)=>node.normalized_path[i]===part);
function operationContext(nodes:CategoryNode[],input:CategoryOperation){
 const source=nodes.find(n=>n.id===input.sourceId);
 if(!source)throw new HttpError(404,'Categoria não encontrada. Atualize a lista.');
 const branch=nodes.filter(n=>isWithin(n,source)).sort((a,b)=>a.path.length-b.path.length||a.id.localeCompare(b.id));
 const branchIds=new Set(branch.map(n=>n.id));
 const targetId=input.action==='move'?input.parentId:input.targetId;
 const target=targetId?nodes.find(n=>n.id===targetId):null;
 if(targetId&&!target)throw new HttpError(400,'Categoria de destino não encontrada.');
 if(target&&branchIds.has(target.id))throw new HttpError(400,'O destino não pode ser a própria categoria nem um descendente.');
 if(input.action==='merge'&&!target)throw new HttpError(400,'Escolha a categoria de destino para unir.');
 if(input.action==='rename'&&!input.name)throw new HttpError(400,'Informe o novo nome.');
 return {source,target,branch,branchIds};
}
type Context=ReturnType<typeof operationContext>;
function affectedReferences(snapshot:CategorySnapshot,{source,branchIds}:Context){
 const affectedProducts=snapshot.products.filter(p=>p.category_ids.includes(source.id));
 const productIds=new Set(affectedProducts.map(p=>p.id));
 const affectedLinks=snapshot.links.filter(l=>branchIds.has(l.confirmed_category_id??'')||productIds.has(l.product_id??''));
 const affectedMappings=snapshot.mappings.filter(m=>branchIds.has(m.category_id));
 const affectedFilters=snapshot.filters.filter(f=>branchIds.has(f.filters.categoryId??'')||isLegacyFilter(f,source));
 return {affectedProducts,affectedLinks,affectedMappings,affectedFilters,productIds};
}
function isLegacyFilter(filter:FilterReference,source:CategoryNode){
 return !filter.filters.categoryId&&source.path.length===1&&String(filter.filters.category||'').toLowerCase()===source.normalized_path[0];
}
function destinationPath(context:Context,input:CategoryOperation,node:CategoryNode,destinations:Map<string,CategoryNode|null>){
 if(node.id===context.source.id){
  if(input.action==='rename')return [...node.path.slice(0,-1),input.name!];
  if(input.action==='move')return [...(context.target?.path??[]),node.path.at(-1)!];
  return context.target!.path;
 }
 const parent=context.branch.find(n=>n.path.length===node.path.length-1&&isWithin(node,n))!;
 // Reuse canonical spelling when a merge already mapped this parent to an existing node.
 return [...destinations.get(parent.id)!.path,node.path.at(-1)!];
}
function changedTree(nodes:CategoryNode[],context:Context,input:CategoryOperation){
 const finalNodes=nodes.filter(n=>!context.branchIds.has(n.id)).map(n=>({...n,path:[...n.path]}));
 const knownPaths=new Map(finalNodes.map(n=>[categoryKey(n.path),n]));
 const destinations=new Map<string,CategoryNode|null>(),removed:string[]=[];
 for(const node of context.branch){
  if(input.action==='delete'){
   destinations.set(node.id,context.target??null);removed.push(node.id);continue;
  }
  const path=destinationPath(context,input,node,destinations);
  if(path.length>10)throw new HttpError(400,'A operação ultrapassaria o limite de 10 níveis.');
  const known=knownPaths.get(categoryKey(path));
  if(known){
   if(input.action!=='merge')throw new HttpError(409,'Já existe uma categoria nesse destino. Use Unir para consolidá-las.');
   destinations.set(node.id,known);removed.push(node.id);
  }else{
   const updated={...node,path,normalized_path:path.map(n=>n.toLowerCase())};
   finalNodes.push(updated);knownPaths.set(categoryKey(path),updated);destinations.set(node.id,updated);
  }
 }
 return {finalNodes,destinations,removed};
}
export const categoryRevision=(snapshot:CategorySnapshot,input:CategoryOperation)=>createHash('sha256').update(JSON.stringify({snapshot,input})).digest('hex');
export function categoryPlan(snapshot:CategorySnapshot,input:CategoryOperation){
 const context=operationContext(snapshot.nodes,input),affected=affectedReferences(snapshot,context);
 const inUse=affected.affectedProducts.length+affected.affectedLinks.length+affected.affectedMappings.length+affected.affectedFilters.length;
 if(input.action==='delete'&&!context.target&&inUse)throw new HttpError(400,'Esta árvore está em uso. Escolha um destino para preservar produtos, revisões, mapeamentos e filtros.');
 const tree=changedTree(snapshot.nodes,context,input);
 const changed=context.branch.some(n=>tree.removed.includes(n.id)||JSON.stringify(n.path)!==JSON.stringify(tree.destinations.get(n.id)?.path));
 if(!changed)throw new HttpError(400,'A operação não altera a categoria.');
 const impact={categories:context.branch.length,removedCategories:tree.removed.length,products:affected.affectedProducts.length,
  offers:snapshot.offers.filter(o=>affected.productIds.has(o.product_id)).length,reviewLinks:affected.affectedLinks.length,
  mappings:affected.affectedMappings.length,savedFilters:affected.affectedFilters.length};
 const revision=categoryRevision(snapshot,input);
 return {...context,...tree,...affected,revision,impact,
  preview:{revision,action:input.action,sourcePath:context.source.path,targetPath:tree.destinations.get(context.source.id)?.path??null,impact,
   changes:context.branch.slice(0,25).map(n=>({from:n.path,to:tree.destinations.get(n.id)?.path??null,removed:tree.removed.includes(n.id)}))}};
}
