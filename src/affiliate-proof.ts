import type {Router,Request} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
import {marketUrl} from './scraping.js';
import {startEnrichment} from './enrichment-admin.js';
import {audit} from './offers.js';
const id=z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),headers=z.record(z.string().max(80),z.string().max(1000));
const step=z.discriminatedUnion('type',[
 z.strictObject({type:z.literal('extract'),name:z.string().regex(/^[a-zA-Z]\w{0,40}$/),source:z.enum(['dom','localStorage','sessionStorage','cookie','requestHeader']),selector:z.string().max(600).optional(),attribute:z.string().max(80).optional(),key:z.string().max(100).optional(),sourceUrl:z.url().max(2000).optional()}),
 z.strictObject({type:z.literal('request'),url:z.url().max(4000),method:z.enum(['GET','POST']),headers:headers.optional(),body:headers.optional(),bodyEncoding:z.enum(['json','form']).optional(),responsePath:z.string().regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/).max(200)}),
 z.strictObject({type:z.literal('fill'),selector:z.string().min(1).max(600),value:z.string().max(4000)}),
 z.strictObject({type:z.literal('click'),selector:z.string().min(1).max(600)})
]);
export const affiliateRecipe=z.strictObject({id,name:z.string().min(1).max(100),loginUrl:z.url(),allowedOrigins:z.array(z.url()).min(1).max(10),affiliateOrigins:z.array(z.url()).min(1).max(10),batchSize:z.number().int().min(1).max(3),intervalMs:z.number().int().min(20000).max(60000),steps:z.array(step).min(1).max(15)});
type Recipe=z.infer<typeof affiliateRecipe>;
type Actor={id:string;extension_session_id:string};
type Item={id:string;title:string;originalUrl:string;affiliateUrl?:string;error?:string};
type Proof={id:string;owner:string;marketplaceId:string;expiresAt:number;items:Item[];runId?:string;starting?:boolean};
function validateRecipe(recipe:Recipe,market:{id:string;allowed_hosts:string[]}){
 if(recipe.id!==market.id)throw new HttpError(400,'A receita deve pertencer ao marketplace selecionado.');
 for(const origin of [...recipe.allowedOrigins,...recipe.affiliateOrigins]){marketUrl(origin,market.allowed_hosts);if(new URL(origin).origin!==origin)throw new HttpError(400,'Cadastre somente origens HTTPS, sem caminho.');}
 marketUrl(recipe.loginUrl,market.allowed_hosts);if(!recipe.allowedOrigins.includes(new URL(recipe.loginUrl).origin))throw new HttpError(400,'Página de sessão fora das origens configuradas.');
 for(const s of recipe.steps){
  if(s.type==='extract'){
   if(['originalUrl','__proto__','constructor','prototype'].includes(s.name))throw new HttpError(400,'Nome de variável reservado.');
   if(s.source==='dom'&&!s.selector||s.source!=='dom'&&!s.key)throw new HttpError(400,'Configure a origem da variável.');
   if(s.source==='requestHeader'){
    if(!s.sourceUrl||!/^x-[\w-]+$/i.test(s.key!))throw new HttpError(400,'Configure somente um header X- e a URL exata da chamada de origem.');
    marketUrl(s.sourceUrl,market.allowed_hosts);if(!recipe.allowedOrigins.includes(new URL(s.sourceUrl).origin))throw new HttpError(400,'Origem do header não autorizada.');
   }
  }
  if(s.type==='request'){
   marketUrl(s.url,market.allowed_hosts);if(!recipe.allowedOrigins.includes(new URL(s.url).origin))throw new HttpError(400,'Destino de conversão não autorizado.');
   for(const [key,value] of Object.entries(s.headers??{})){if(/^(cookie|authorization|host|origin|referer|proxy-|sec-)/i.test(key))throw new HttpError(400,'Header reservado.');if(/^x-/i.test(key)&&!/^\{\{[a-zA-Z]\w*\}\}$/.test(value))throw new HttpError(400,'Headers de sessão devem usar variáveis locais, nunca valores fixos.');}
  }
 }
}
export function registerAffiliateProof(router:Router,db:Database,account:(req:Request)=>Promise<Actor>){
 const proofs=new Map<string,Proof>();
 const admin=async(req:Request)=>{const actor=await account(req);if((await db.query('SELECT role FROM users WHERE id=$1',[actor.id])).rows[0]?.role!=='admin')throw new HttpError(403,'O teste exige administrador.');return actor;};
 const own=(proofId:unknown,actor:Actor)=>{for(const [key,p] of proofs)if(p.expiresAt<Date.now())proofs.delete(key);const proof=proofs.get(z.uuid().parse(proofId));if(!proof||proof.owner!==actor.extension_session_id)throw new HttpError(404,'Teste expirado ou de outra sessão.');return proof;};
 const recipeFor=async(marketplaceId:string)=>{const market=(await db.query('SELECT id,allowed_hosts,scraping_enabled FROM marketplaces WHERE id=$1',[marketplaceId])).rows[0];const row=(await db.query('SELECT recipe FROM affiliate_proof_recipes WHERE marketplace_id=$1',[marketplaceId])).rows[0];if(!market?.scraping_enabled||!row)throw new HttpError(400,'Configure uma receita e ative a extração deste marketplace.');const recipe=affiliateRecipe.parse(row.recipe);validateRecipe(recipe,market);return recipe;};
 router.get('/affiliate-proof/config',async(req,res)=>{await admin(req);const markets=(await db.query('SELECT marketplace_id FROM affiliate_proof_recipes ORDER BY marketplace_id')).rows;const recipes=[];for(const m of markets)recipes.push(await recipeFor(m.marketplace_id));res.json({version:1,mock:false,marketplaces:recipes});});
 router.post('/affiliate-proof/recipes/:market',async(req,res)=>{const actor=await admin(req),marketplaceId=id.parse(req.params.market),recipe=affiliateRecipe.parse(req.body),market=(await db.query('SELECT id,allowed_hosts FROM marketplaces WHERE id=$1',[marketplaceId])).rows[0];if(!market)throw new HttpError(404,'Marketplace não encontrado.');validateRecipe(recipe,market);await db.query('INSERT INTO affiliate_proof_recipes(marketplace_id,recipe) VALUES($1,$2) ON CONFLICT(marketplace_id) DO UPDATE SET recipe=$2,updated_at=clock_timestamp()',[marketplaceId,JSON.stringify(recipe)]);await audit(db,actor.id,'extension.affiliate_proof.recipe',marketplaceId);res.json({ok:true});});
 router.post('/affiliate-proof/tests',async(req,res)=>{
  const actor=await admin(req),v=z.strictObject({marketplaceId:id}).parse(req.body),recipe=await recipeFor(v.marketplaceId);
  const rows=(await db.query("SELECT id,url,enrichment_data->>'title' AS title FROM discovery_links WHERE marketplace_id=$1 AND status='pending' AND extraction_status='failed' ORDER BY first_seen_at,id LIMIT 3",[v.marketplaceId])).rows;
  if(!rows.length)throw new HttpError(409,'Não há links com falha para testar.');
  for(const [key,p] of proofs)if(p.expiresAt<Date.now())proofs.delete(key);if(proofs.size>=50)throw new HttpError(429,'Aguarde a expiração dos testes anteriores.');
  const proof:Proof={id:randomUUID(),owner:actor.extension_session_id,marketplaceId:v.marketplaceId,expiresAt:Date.now()+1800000,items:rows.map(r=>({id:r.id,title:r.title||r.url,originalUrl:r.url}))};proofs.set(proof.id,proof);
  await audit(db,actor.id,'extension.affiliate_proof.started',proof.id);res.status(201).json({id:proof.id,expiresAt:proof.expiresAt,items:proof.items,recipe});
 });
 router.post('/affiliate-proof/tests/:id/results',async(req,res)=>{
  const actor=await admin(req),proof=own(req.params.id,actor);if(proof.runId||proof.starting)throw new HttpError(409,'Este teste já foi enviado ao enriquecimento.');const recipe=await recipeFor(proof.marketplaceId);
  const results=z.strictObject({results:z.array(z.strictObject({id:z.uuid(),affiliateUrl:z.url().max(10000).optional(),error:z.enum(['conversion_failed']).optional()}).refine(r=>!!r.affiliateUrl!==!!r.error)).min(1).max(3).refine(rows=>new Set(rows.map(r=>r.id)).size===rows.length)}).parse(req.body).results;
  const assignments=results.map(r=>{const item=proof.items.find(i=>i.id===r.id);if(!item)throw new HttpError(400,'Item fora do teste.');if(r.affiliateUrl){const url=new URL(r.affiliateUrl);if(url.protocol!=='https:'||url.username||url.password||url.port||!recipe.affiliateOrigins.includes(url.origin))throw new HttpError(400,'Link de afiliado fora dos domínios autorizados.');}if((item.affiliateUrl||item.error)&&(item.affiliateUrl!==r.affiliateUrl||item.error!==r.error))throw new HttpError(409,'O item já possui outro resultado.');return {item,result:r};});
  for(const a of assignments)Object.assign(a.item,a.result);res.json({accepted:assignments.length});
 });
 router.post('/affiliate-proof/tests/:id/enrich',async(req,res)=>{
  const actor=await admin(req),proof=own(req.params.id,actor);if(proof.starting)throw new HttpError(409,'O enriquecimento está sendo solicitado.');if(proof.runId)return res.json({id:proof.runId,status:'queued'});
  const converted=proof.items.filter(i=>i.affiliateUrl);if(!converted.length)throw new HttpError(409,'Nenhum link foi convertido.');if(proof.items.some(i=>!i.affiliateUrl&&!i.error))throw new HttpError(409,'Conclua a conversão do lote primeiro.');
  proof.starting=true;try{const run=await startEnrichment(db,proof.marketplaceId,actor.id,true,3,{linkIds:converted.map(i=>i.id),navigationUrls:Object.fromEntries(converted.map(i=>[i.id,i.affiliateUrl!]))});proof.runId=run.id;await audit(db,actor.id,'extension.affiliate_proof.enrichment',run.id);res.status(202).json(run);}finally{proof.starting=false;}
 });
 router.get('/affiliate-proof/tests/:id',async(req,res)=>{const actor=await admin(req),proof=own(req.params.id,actor),run=proof.runId?(await db.query('SELECT id,status,total,error FROM enrichment_runs WHERE id=$1',[proof.runId])).rows[0]:null,items=proof.runId?(await db.query('SELECT link_id,status,error FROM enrichment_items WHERE run_id=$1 ORDER BY link_id',[proof.runId])).rows:[];res.json({id:proof.id,expiresAt:proof.expiresAt,items:proof.items,run,runItems:items});});
}
