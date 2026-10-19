import type {Router,Request} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Database} from './db.js';
import type {Config} from './config.js';
import {HttpError,encrypt,decrypt} from './security.js';
import {marketUrl} from './scraping.js';
import {manualProfile} from './manual-extractor-profile.js';
import {audit} from './offers.js';
const cookie=z.strictObject({name:z.string().min(1).max(256),value:z.string().max(8192),domain:z.string().max(253),path:z.string().startsWith('/').max(1000),expires:z.number().finite(),httpOnly:z.boolean(),secure:z.literal(true),sameSite:z.enum(['Strict','Lax','None'])});
const input=z.strictObject({marketplaceId:z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),url:z.url().max(10000),consent:z.literal(true),session:z.strictObject({cookies:z.array(cookie).min(1).max(200),origins:z.array(z.strictObject({origin:z.url(),localStorage:z.array(z.strictObject({name:z.string().max(256),value:z.string().max(8192)})).max(100)})).max(10).default([])})});
const proofResult=z.object({requestId:z.uuid(),status:z.enum(['available','unavailable','technical_failure']),reason:z.enum(['invalid_configuration','unsafe_url','blocked','http_error','timeout','incomplete','browser_error']).optional(),title:z.string().max(300).nullable(),priceCents:z.number().int().nonnegative().nullable(),missing:z.array(z.string().max(80)).max(40),finalUrl:z.string().max(10000),navigationStatuses:z.array(z.number().int().min(100).max(599)).max(30),cookiesImported:z.number().int().min(0).max(200),storageOriginsImported:z.number().int().min(0).max(10)});
type Actor={id:string;extension_session_id:string};
type Proof={id:string;owner:string;expiresAt:number;status:'running'|'completed'|'failed';result?:z.infer<typeof proofResult>;error?:string};
export function registerSessionProof(router:Router,db:Database,config:Config,account:(req:Request)=>Promise<Actor>,transport:typeof fetch=fetch){
 const proofs=new Map<string,Proof>();
 const starting=new Set<string>();
 const admin=async(req:Request)=>{const actor=await account(req);if((await db.query('SELECT role FROM users WHERE id=$1',[actor.id])).rows[0]?.role!=='admin')throw new HttpError(403,'A prova de sessão exige uma conta administradora.');return actor;};
 const cleanup=()=>{for(const [id,proof] of proofs)if(proof.expiresAt<Date.now())proofs.delete(id);};
 router.get('/session-proof/marketplaces',async(req,res)=>{
  await admin(req);
  const rows=(await db.query(`SELECT m.id,m.name,m.website_url,m.allowed_hosts,(SELECT l.url FROM discovery_links l WHERE l.marketplace_id=m.id AND l.status='pending' ORDER BY (l.extraction_status='failed') DESC,l.first_seen_at LIMIT 1) AS test_url FROM marketplaces m JOIN scraping_profiles p ON p.marketplace_id=m.id WHERE m.scraping_enabled=true ORDER BY m.name`)).rows;
  res.json({marketplaces:rows.map(m=>({id:m.id,name:m.name,loginUrl:marketUrl(m.website_url,m.allowed_hosts),allowedOrigins:m.allowed_hosts.map((h:string)=>'https://'+h),cookieDomains:m.allowed_hosts,testUrl:m.test_url||''}))});
 });
 router.post('/session-proof/tests',async(req,res)=>{
  const actor=await admin(req),v=input.parse(req.body);cleanup();
  if(starting.size+[...proofs.values()].filter(p=>p.status==='running').length>=2||starting.has(actor.extension_session_id)||[...proofs.values()].some(p=>p.owner===actor.extension_session_id&&p.status==='running'))throw new HttpError(429,'Já existe um teste em andamento. Aguarde.');
  if(proofs.size>=100)throw new HttpError(429,'Aguarde a expiração dos testes anteriores.');
  starting.add(actor.extension_session_id);
  try{
  if(!config.MANUAL_EXTRACTOR_URL||!config.MANUAL_EXTRACTION_SERVICE_TOKEN)throw new HttpError(503,'Configure e inicie o extrator manual para esta prova.');
  const market=(await db.query('SELECT * FROM marketplaces WHERE id=$1',[v.marketplaceId])).rows[0];
  const profile=(await db.query('SELECT * FROM scraping_profiles WHERE marketplace_id=$1',[v.marketplaceId])).rows[0];
  if(!market?.scraping_enabled||!profile)throw new HttpError(400,'Ative a extração e cadastre os seletores do marketplace.');
  marketUrl(v.url,market.allowed_hosts);
  for(const c of v.session.cookies)if(!market.allowed_hosts.includes(c.domain.replace(/^\./u,''))||c.expires!==-1&&c.expires<=Date.now()/1000)throw new HttpError(400,'Cookie fora dos domínios autorizados ou expirado.');
  for(const o of v.session.origins){marketUrl(o.origin,market.allowed_hosts);if(new URL(o.origin).origin!==o.origin)throw new HttpError(400,'Origem de armazenamento inválida.');}
  if(Buffer.byteLength(JSON.stringify(v.session),'utf8')>49152)throw new HttpError(413,'A sessão excede o limite de 48 KiB.');
  const url=new URL(v.url);url.search='';url.hash='';
  const encrypted=encrypt(v.session,config.ENCRYPTION_KEY),id=randomUUID();
  const proof:Proof={id,owner:actor.extension_session_id,expiresAt:Date.now()+300000,status:'running'};
  await audit(db,actor.id,'extension.session_proof.started',id);proofs.set(id,proof);
  const payload={url:url.href,profile:manualProfile(market,profile)};
  void (async()=>{
   try{
    const response=await transport(new URL('/v1/session-proofs',config.MANUAL_EXTRACTOR_URL),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.MANUAL_EXTRACTION_SERVICE_TOKEN},body:JSON.stringify({...payload,session:decrypt(encrypted,config.ENCRYPTION_KEY)}),redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error('Extractor unavailable');
    const result=proofResult.parse(await response.json());if(result.finalUrl)marketUrl(result.finalUrl,market.allowed_hosts);
    proof.result=result;proof.status='completed';
    await audit(db,actor.id,'extension.session_proof.'+result.status+(result.reason?'.'+result.reason:''),id);
   }catch{proof.status='failed';proof.error='O extrator não concluiu a prova. Verifique o container, sua versão e a conexão.';}
  })();
  res.status(202).json({id,status:proof.status,expiresAt:proof.expiresAt});
  }finally{starting.delete(actor.extension_session_id);}
 });
 router.get('/session-proof/tests/:id',async(req,res)=>{const actor=await admin(req);cleanup();const proof=proofs.get(z.uuid().parse(req.params.id));if(!proof||proof.owner!==actor.extension_session_id)throw new HttpError(404,'Teste expirado ou não encontrado.');const {owner:_owner,...view}=proof;res.json(view);});
}
