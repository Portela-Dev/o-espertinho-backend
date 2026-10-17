import express from 'express';
import {registerUserAdmin} from './user-admin.js';
import {registerPriceHistory} from './price-history.js';
import {registerOfferRefreshAdmin} from './offer-refresh.js';
import {registerApiDocs} from './api-docs.js';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import {getProduct,registerPublicProducts,registerProductAdmin} from './products.js';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { HttpError, sessionMiddleware, csrfMiddleware, newSession, setSignedOut, SIGNED_OUT_COOKIE, hash, requireUser, requireAdmin, encrypt, decrypt, marketplaceURL, type User } from './security.js';
import { ProviderService, credentialFields, type ProviderId } from './providers.js';
import { type OfferExtractor } from './scraping.js';
import { RemoteOfferExtractor } from './remote-extractor.js';
import { classificationText,requiredCategory,resolveClassification } from './classifications.js';
import { registerScrapingAdmin,assertRegisteredLink } from './scraping-admin.js';
import { registerMeliCallback, registerMeliAdminOAuth, meliRedirectUri } from './mercadolivre-oauth.js';
import { audit, withMeliCredentials, credentials, insertCandidate, refreshOffer, runRule } from './offers.js';
const uuid=z.uuid();
const provider=z.enum(['amazon','mercadolivre']);
const text=(max=120)=>z.string().trim().min(1).max(max);
const filtersSchema=z.object({q:z.string().max(160).default(''),marketplace:z.string().regex(/^(?:[a-z][a-z0-9_-]{1,39})?$/).default(''),category:z.string().max(80).default(''),categoryId:z.union([z.uuid(),z.literal('')]).default(''),maxPrice:z.coerce.number().int().min(0).max(100000000).default(0),sort:z.enum(['recent','price_asc','discount']).default('recent')});
const ruleSchema=z.object({marketplaceId:provider,name:text(),keywords:text(160),category:text(80),maxPriceCents:z.number().int().positive().max(100000000).nullable().default(null),minDiscount:z.number().int().min(0).max(99).default(0),intervalMinutes:z.number().int().min(60).max(10080).default(360),enabled:z.boolean().default(true)});
const editSchema=z.object({title:text(300),description:z.string().max(4000).default(''),category:requiredCategory.default('Outros'),subcategory:classificationText.optional(),conditions:z.string().max(1500).default(''),featured:z.boolean().default(false),priceCents:z.number().int().positive().max(100000000).optional(),originalPriceCents:z.number().int().positive().max(100000000).nullable().optional(),expiresAt:z.iso.datetime().optional()});
const manualSchema=editSchema.extend({productId:uuid,sellerName:z.string().trim().max(200).default(''),marketplaceId:provider,externalId:text(100),productUrl:z.url(),affiliateUrl:z.url(),imageUrl:z.url().nullable().default(null),priceCents:z.number().int().positive().max(100000000),originalPriceCents:z.number().int().positive().max(100000000).nullable().default(null),expiresAt:z.iso.datetime(),authorizedContent:z.literal(true)});
export interface Identity { sub:string; email:string; emailVerified:boolean; name:string; avatar?:string; authoritative:boolean }
export interface AppOptions { extractor?:OfferExtractor; providers?:ProviderService; verifyGoogle?:(token:string)=>Promise<Identity> }
export function createApp(db: Database,config: Config,options: AppOptions={}) {
  const app=express(), providers=options.providers??new ProviderService();
  const google=new OAuth2Client(config.GOOGLE_CLIENT_ID);
  app.disable('x-powered-by'); app.set('trust proxy','loopback');
  app.use(helmet(),express.json({limit:'64kb'}),cookieParser());
  app.use('/api',rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-8',legacyHeaders:false,skip:()=>config.NODE_ENV==='test',message:{error:'Muitos acessos. Aguarde um minuto.'}}));
  app.get('/api/health',async(_req,res)=>{await db.query('SELECT 1');res.json({status:'ok'});});
  app.get('/api/config',(_req,res)=>res.json({googleClientId:config.GOOGLE_CLIENT_ID,loginAvailable:!!config.GOOGLE_CLIENT_ID}));
  registerApiDocs(app,config);
  app.use('/api',sessionMiddleware(db,config));
  app.get('/api/auth/session',async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!req.sessionId || typeof req.cookies['XSRF-TOKEN']!=='string' || hash(req.cookies['XSRF-TOKEN'])!==req.csrfHash){
      if(req.sessionId)await db.query('DELETE FROM sessions WHERE id=$1',[req.sessionId]);
      await newSession(db,res,config,req.user?.id??null);
    }
    res.json({user:req.user??null,autoSignInAllowed:req.cookies[SIGNED_OUT_COOKIE]!=='1'});
  });
  registerMeliCallback(app,config);
  app.use('/api',csrfMiddleware(config));
  app.post('/api/auth/google',rateLimit({windowMs:60000,limit:15,skip:()=>config.NODE_ENV==='test',message:{error:'Muitas tentativas de login. Aguarde.'}}),async(req,res)=>{
    if(!config.GOOGLE_CLIENT_ID) throw new HttpError(503,'Login Google não configurado. Defina GOOGLE_CLIENT_ID no backend.');
    const {credential,automatic}=z.object({credential:text(10000),automatic:z.boolean().default(false)}).parse(req.body);
    if(automatic&&req.cookies[SIGNED_OUT_COOKIE]==='1')throw new HttpError(409,'Você saiu da conta. Escolha Entrar para acessar novamente.');
    let identity: Identity;
    try {
      if(options.verifyGoogle) identity=await options.verifyGoogle(credential);
      else {
        const ticket=await google.verifyIdToken({idToken:credential,audience:config.GOOGLE_CLIENT_ID}); const p=ticket.getPayload();
        if(!p?.sub||!p.email) throw new Error('Token incompleto');
        identity={sub:p.sub,email:p.email,emailVerified:!!p.email_verified,name:p.name||p.email,avatar:p.picture,authoritative:p.email.toLowerCase().endsWith('@gmail.com')||!!p.hd};
      }
    } catch { throw new HttpError(401,'Não foi possível validar sua conta Google.'); }
    if(!identity.emailVerified || !identity.authoritative) throw new HttpError(403,'Use uma conta Gmail ou Google Workspace com e-mail verificado.');
    const email=identity.email.toLowerCase(), client=await db.connect(); let user: User;
    try {
      await client.query('BEGIN');
      if(!(await client.query('SELECT id FROM sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE',[req.sessionId])).rows.length)throw new HttpError(409,'A sessão mudou. Atualize a página antes de entrar.');
      const {rows}=await client.query('SELECT * FROM users WHERE google_sub=$1 OR email=$2 FOR UPDATE',[identity.sub,email]);
      const current=rows.find(r=>r.google_sub===identity.sub)??rows[0];
      if(current?.blocked)throw new HttpError(403,'Sua conta está bloqueada. Entre em contato com a administração.');
      if(current?.google_sub && current.google_sub!==identity.sub) throw new HttpError(409,'Esta conta precisa de revisão pelo administrador.');
      const id=current?.id??randomUUID();
      if(current) {
        const r=await client.query('UPDATE users SET google_sub=$2,name=$3,avatar=$4 WHERE id=$1 RETURNING id,email,name,avatar,role',[id,identity.sub,identity.name,identity.avatar??null]); user=r.rows[0];
      } else {
        const r=await client.query("INSERT INTO users(id,email,google_sub,name,avatar,role) VALUES($1,$2,$3,$4,$5,'user') RETURNING id,email,name,avatar,role",[id,email,identity.sub,identity.name,identity.avatar??null]); user=r.rows[0];
      }
      if(req.sessionId) await client.query('DELETE FROM sessions WHERE id=$1',[req.sessionId]);
      await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const access=(await db.query('SELECT u.access_profile_id,p.permissions FROM users u JOIN access_profiles p ON p.id=u.access_profile_id WHERE u.id=$1 AND u.blocked=false',[user!.id])).rows[0];
    if(!access)throw new HttpError(403,'Sua conta está bloqueada.');
    Object.assign(user!,access);
    await newSession(db,res,config,user!.id);if(!automatic)setSignedOut(res,config,false); res.set('Cache-Control','no-store').json({user:user!});
  });
  app.post('/api/auth/logout',async(req,res)=>{if(req.sessionId) await db.query('DELETE FROM sessions WHERE id=$1',[req.sessionId]);await newSession(db,res,config,null);setSignedOut(res,config,true);res.json({ok:true});});
  registerPublicProducts(app,db);
  registerPriceHistory(app,db);
  app.get('/api/marketplaces',async(_req,res)=>res.json((await db.query('SELECT id,name,website_url,logo_url FROM marketplaces ORDER BY name')).rows));
  app.get('/api/categories',async(_req,res)=>{
    const {rows}=await db.query("SELECT DISTINCT p.category FROM products p WHERE EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id AND o.status='published' AND o.availability_status='available' AND o.affiliate_url IS NOT NULL) ORDER BY p.category");res.json(rows.map(r=>r.category));
  });
  app.get('/api/offers',async(req,res)=>{
    const f=filtersSchema.parse(req.query), page=z.coerce.number().int().min(1).max(10000).default(1).parse(req.query.page);
    const clauses=["o.status='published'","o.availability_status='available'"], args:unknown[]=[];
    const add=(sql:string,value:unknown)=>{args.push(value);clauses.push(sql.replace('?',`$${args.length}`));};
    if(f.q) add("o.title ILIKE ?",`%${f.q.replaceAll('%','\\%').replaceAll('_','\\_')}%`);
    if(f.marketplace) add('o.marketplace_id=?',f.marketplace);
    if(f.categoryId) add('o.category_ids @> ARRAY[?]::uuid[]',f.categoryId);else if(f.category) add('o.category=?',f.category);
    if(f.maxPrice) add('o.price_cents<=?',f.maxPrice);
    const where=clauses.join(' AND '), order=f.sort==='price_asc'?'o.price_cents ASC':f.sort==='discount'?'COALESCE((o.original_price_cents-o.price_cents)::float / NULLIF(o.original_price_cents,0),0) DESC':'o.featured DESC,o.published_at DESC';
    const count=await db.query(`SELECT count(*)::int AS total FROM offers o WHERE ${where}`,args);
    const {rows}=await db.query(`SELECT o.*,(SELECT name FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_logo_url FROM offers o WHERE ${where} ORDER BY ${order},o.id LIMIT 24 OFFSET $${args.length+1}`,[...args,(page-1)*24]);
    res.json({items:rows,total:count.rows[0].total,page,pageSize:24});
  });
  app.get('/api/offers/:id',async(req,res)=>{
    const {rows}=await db.query("SELECT offers.*,(SELECT name FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_logo_url FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",[uuid.parse(req.params.id)]);
    if(!rows[0]) throw new HttpError(404,'Esta oferta não está mais disponível.');res.json(rows[0]);
  });
  app.post('/api/offers/:id/click',rateLimit({windowMs:60000,limit:60,skip:()=>config.NODE_ENV==='test',message:{error:'Aguarde antes de tentar novamente.'}}),async(req,res)=>{
    const id=uuid.parse(req.params.id), placement=z.enum(['home','search','detail','favorites','collection']).default('detail').parse(req.body.placement);
    const {rows}=await db.query("SELECT offers.*,(SELECT name FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_logo_url FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",[id]);
    if(!rows[0]?.affiliate_url) throw new HttpError(410,'Esta oferta não está mais disponível.');
    await assertRegisteredLink(db,rows[0].marketplace_id,rows[0].affiliate_url);
    // Aggregate, unverified clicks only. Do not attach Google ID, user ID, IP or session ID.
    await db.query('INSERT INTO click_events(id,offer_id,marketplace_id,placement) VALUES($1,$2,$3,$4)',[randomUUID(),id,rows[0].marketplace_id,placement]);res.json({ok:true});
  });
  app.use('/api/me',requireUser,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/api/me/favorites',async(req,res)=>{const {rows}=await db.query('SELECT o.*,(SELECT name FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_logo_url FROM favorites f JOIN offers o ON o.id=f.offer_id WHERE f.user_id=$1 ORDER BY f.created_at DESC',[req.user!.id]);res.json(rows);});
  app.put('/api/me/favorites/:id',async(req,res)=>{
    const id=uuid.parse(req.params.id), exists=await db.query("SELECT id FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",[id]);
    if(!exists.rows.length) throw new HttpError(404,'Oferta indisponível.');
    await db.query('INSERT INTO favorites(user_id,offer_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user!.id,id]);res.json({ok:true});
  });
  app.delete('/api/me/favorites/:id',async(req,res)=>{await db.query('DELETE FROM favorites WHERE user_id=$1 AND offer_id=$2',[req.user!.id,uuid.parse(req.params.id)]);res.json({ok:true});});
  app.get('/api/me/filters',async(req,res)=>{const {rows}=await db.query('SELECT * FROM saved_filters WHERE user_id=$1 ORDER BY created_at DESC',[req.user!.id]);res.json(rows);});
  app.post('/api/me/filters',async(req,res)=>{
    const v=z.object({name:text(80),filters:filtersSchema}).parse(req.body);
    const {rows}=await db.query('INSERT INTO saved_filters(id,user_id,name,filters) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),req.user!.id,v.name,JSON.stringify(v.filters)]);res.status(201).json(rows[0]);
  });
  app.delete('/api/me/filters/:id',async(req,res)=>{await db.query('DELETE FROM saved_filters WHERE id=$1 AND user_id=$2',[uuid.parse(req.params.id),req.user!.id]);res.json({ok:true});});
  app.get('/api/me/collections',async(req,res)=>{
    const {rows}=await db.query('SELECT c.*,(SELECT count(*)::int FROM collection_items i WHERE i.collection_id=c.id) AS item_count FROM collections c WHERE c.user_id=$1 ORDER BY c.created_at DESC',[req.user!.id]);res.json(rows);
  });
  app.post('/api/me/collections',async(req,res)=>{
    const v=z.object({name:text(80),description:z.string().max(400).default('')}).parse(req.body);
    const {rows}=await db.query('INSERT INTO collections(id,user_id,name,description) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),req.user!.id,v.name,v.description]);res.status(201).json(rows[0]);
  });
  const ownedCollection=async(id:string,userId:string)=>{const {rows}=await db.query('SELECT * FROM collections WHERE id=$1 AND user_id=$2',[uuid.parse(id),userId]);if(!rows[0]) throw new HttpError(404,'Catálogo não encontrado.');return rows[0];};
  app.get('/api/me/collections/:id',async(req,res)=>{const collection=await ownedCollection(String(req.params.id),req.user!.id);const {rows}=await db.query('SELECT o.*,(SELECT name FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_logo_url FROM collection_items i JOIN offers o ON o.id=i.offer_id WHERE i.collection_id=$1 ORDER BY i.created_at DESC',[collection.id]);res.json({...collection,items:rows});});
  app.patch('/api/me/collections/:id',async(req,res)=>{await ownedCollection(String(req.params.id),req.user!.id);const v=z.object({name:text(80),description:z.string().max(400).default('')}).parse(req.body);await db.query('UPDATE collections SET name=$2,description=$3 WHERE id=$1',[req.params.id,v.name,v.description]);res.json({ok:true});});
  app.delete('/api/me/collections/:id',async(req,res)=>{await ownedCollection(String(req.params.id),req.user!.id);await db.query('DELETE FROM collections WHERE id=$1',[req.params.id]);res.json({ok:true});});
  app.put('/api/me/collections/:id/items/:offerId',async(req,res)=>{
    await ownedCollection(String(req.params.id),req.user!.id);const id=uuid.parse(req.params.offerId);
    const found=await db.query("SELECT id FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",[id]);if(!found.rows.length) throw new HttpError(404,'Oferta indisponível.');
    await db.query('INSERT INTO collection_items(collection_id,offer_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.params.id,id]);res.json({ok:true});
  });
  app.delete('/api/me/collections/:id/items/:offerId',async(req,res)=>{await ownedCollection(String(req.params.id),req.user!.id);await db.query('DELETE FROM collection_items WHERE collection_id=$1 AND offer_id=$2',[req.params.id,uuid.parse(req.params.offerId)]);res.json({ok:true});});
  app.delete('/api/me/account',async(req,res)=>{
    if(req.user!.role==='admin') throw new HttpError(409,'A conta administradora deve ser transferida antes da exclusão.');
    await db.query('DELETE FROM users WHERE id=$1',[req.user!.id]);await newSession(db,res,config,null);setSignedOut(res,config,true);res.json({ok:true});
  });
  app.use('/api/admin',requireUser,requireAdmin,(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  registerUserAdmin(app,db);
  registerProductAdmin(app,db);
  registerOfferRefreshAdmin(app,db);
  registerScrapingAdmin(app,db,options.extractor??(config.SCRAPER_SERVICE_URL?new RemoteOfferExtractor(config.SCRAPER_SERVICE_URL,config.EXTRACTION_SERVICE_TOKEN):{extract:async()=>{throw new HttpError(503,'Configure SCRAPER_SERVICE_URL e inicie o extrator para coletar ofertas.');}}));
  registerMeliAdminOAuth(app,db,config,providers);
  app.get('/api/admin/marketplaces',async(_req,res)=>{
    const {rows}=await db.query('SELECT * FROM marketplaces ORDER BY name');
    res.json(rows.map(r=>({id:r.id,name:r.name,enabled:r.enabled,configured:!!r.credentials_encrypted,oauthConnected:r.id==='mercadolivre'&&!!(r.credentials_encrypted&&decrypt(r.credentials_encrypted,config.ENCRYPTION_KEY).refreshToken),oauthRedirectUri:r.id==='mercadolivre'?(config.MELI_REDIRECT_URI||new URL('/api/admin/mercadolivre/callback',config.APP_ORIGIN).href):undefined,oauthReady:r.id==='mercadolivre'&&(()=>{try{meliRedirectUri(config);return true;}catch{return false;}})(),fields:credentialFields[r.id as ProviderId]??[],connection_status:r.connection_status,last_checked_at:r.last_checked_at,last_error:r.last_error,automaticDiscovery:r.id==='amazon',documentation:r.id==='amazon'?'https://associados.amazon.com.br/creatorsapi/docs/en-us/introduction':'https://www.mercadolivre.com.br/l/afiliados-home'})));
  });
  app.put('/api/admin/marketplaces/:id',async(req,res)=>{
    const id=provider.parse(req.params.id),v=z.object({enabled:z.boolean(),credentials:z.record(z.string(),z.string().max(10000))}).parse(req.body);
    const client=await db.connect();try{await client.query('BEGIN');
    const {rows}=await client.query('SELECT * FROM marketplaces WHERE id=$1 FOR UPDATE',[id]);
    const secrets=rows[0].credentials_encrypted?decrypt(rows[0].credentials_encrypted,config.ENCRYPTION_KEY):{};
    if(id==='mercadolivre' && credentialFields[id].some(f=>v.credentials[f.key]?.trim() && v.credentials[f.key].trim()!==secrets[f.key])){delete secrets.refreshToken;delete secrets.accessToken;delete secrets.accessTokenExpiresAt;}
    for(const f of credentialFields[id]) if(v.credentials[f.key]?.trim()) secrets[f.key]=v.credentials[f.key].trim();
    if(v.enabled) for(const f of credentialFields[id]) if(f.required&&!secrets[f.key]) throw new HttpError(400,`Preencha ${f.label}.`);
    await client.query("UPDATE marketplaces SET enabled=$2,credentials_encrypted=$3,connection_status='unverified',last_error=NULL,updated_at=now() WHERE id=$1",[id,v.enabled,Object.keys(secrets).length?encrypt(secrets,config.ENCRYPTION_KEY):null]);
    await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    await audit(db,req.user!.id,'marketplace.updated',id);res.json({ok:true});
  });
  app.delete('/api/admin/marketplaces/:id/credentials',async(req,res)=>{const id=provider.parse(req.params.id);await db.query("UPDATE marketplaces SET enabled=false,credentials_encrypted=NULL,connection_status='not_configured',last_error=NULL WHERE id=$1",[id]);await audit(db,req.user!.id,'marketplace.credentials_removed',id);res.json({ok:true});});
  app.post('/api/admin/marketplaces/:id/test',async(req,res)=>{
    const id=provider.parse(req.params.id);
    try {const status=id==='mercadolivre'?await withMeliCredentials(db,config,secrets=>providers.check(id,secrets)):await providers.check(id,(await credentials(db,config,id)).secrets);await db.query('UPDATE marketplaces SET connection_status=$2,last_checked_at=now(),last_error=NULL WHERE id=$1',[id,status]);res.json({ok:true,message:status==='catalog_only'?'API geral autenticada. Isso não habilita descoberta nem geração de links de afiliado.':'Consulta oficial executada com sucesso.'});}
    catch(e){await db.query("UPDATE marketplaces SET connection_status='error',last_checked_at=now(),last_error=$2 WHERE id=$1",[id,e instanceof HttpError?e.message:'Falha de conexão.']);throw e;}
  });
  app.get('/api/admin/category-options',async(_req,res)=>res.json((await db.query('SELECT category,subcategory FROM offer_category_options ORDER BY lower(category),lower(subcategory)')).rows));
  app.get('/api/admin/offers',async(req,res)=>{
    const status=z.enum(['all','pending','published','rejected','expired']).default('pending').parse(req.query.status);
    const page=z.coerce.number().int().min(1).default(1).parse(req.query.page);
    const where=status==='all'?'TRUE':'status=$1',args=status==='all'?[]:[status];
    const {rows}=await db.query(`SELECT * FROM offers WHERE ${where} ORDER BY updated_at DESC LIMIT 50 OFFSET $${args.length+1}`,[...args,(page-1)*50]);res.json(rows);
  });
  app.post('/api/admin/offers',async(req,res)=>{
    const v=manualSchema.parse(req.body),product=await getProduct(db,v.productId);
    if(v.marketplaceId==='amazon') throw new HttpError(400,'Importe produtos Amazon pela Creators API para utilizar preços e imagens autorizados.');
    marketplaceURL(v.productUrl,v.marketplaceId);marketplaceURL(v.affiliateUrl,v.marketplaceId);
    if(new Date(v.expiresAt)<=new Date()||new Date(v.expiresAt)>new Date(Date.now()+7*86400000)) throw new HttpError(400,'Defina validade futura de até sete dias.');
    if(v.imageUrl&&!v.imageUrl.startsWith('https://')) throw new HttpError(400,'A imagem deve usar HTTPS.');
    const classification={category:product.category,subcategory:product.subcategory};
    const {rows}=await db.query(`INSERT INTO offers(id,marketplace_id,external_id,title,description,category,image_url,product_url,affiliate_url,price_cents,original_price_cents,source,conditions,featured,expires_at,subcategory,product_id,seller_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',$12,$13,$14,$15,$16,$17) RETURNING *`,[randomUUID(),v.marketplaceId,v.externalId,v.title,v.description,classification.category,v.imageUrl,v.productUrl,v.affiliateUrl,v.priceCents,v.originalPriceCents,v.conditions,v.featured,v.expiresAt,classification.subcategory,v.productId,v.sellerName]);
    await audit(db,req.user!.id,'offer.created',rows[0].id);res.status(201).json(rows[0]);
  });
  app.post('/api/admin/amazon/import',async(req,res)=>{
    const v=z.object({asin:z.string().regex(/^[A-Z0-9]{10}$/),productId:uuid,category:text(80).default('Outros')}).parse(req.body),{secrets}=await credentials(db,config,'amazon');
    await getProduct(db,v.productId);const c=await providers.refresh('amazon',secrets,v.asin);if(!c) throw new HttpError(404,'Produto sem oferta disponível na API.');await insertCandidate(db,'amazon',c,v.category,v.productId);res.json({ok:true});
  });
  app.post('/api/admin/mercadolivre/import',async(req,res)=>{
    const v=z.object({itemId:z.string().regex(/^MLB\d+$/),productId:uuid,affiliateUrl:z.url(),category:text(80).default('Outros'),authorizedContent:z.literal(true)}).parse(req.body);
    await getProduct(db,v.productId);marketplaceURL(v.affiliateUrl,'mercadolivre');
    const c=await withMeliCredentials(db,config,secrets=>providers.refresh('mercadolivre',secrets,v.itemId));
    if(!c)throw new HttpError(404,'Item indisponível na API geral.');c.affiliateUrl=v.affiliateUrl;await insertCandidate(db,'mercadolivre',c,v.category,v.productId);res.json({ok:true});
  });
  const getOffer=async(id:string)=>{const {rows}=await db.query('SELECT * FROM offers WHERE id=$1',[uuid.parse(id)]);if(!rows[0]) throw new HttpError(404,'Oferta não encontrada.');return rows[0];};
  app.patch('/api/admin/offers/:id',async(req,res)=>{
    const offer=await getOffer(String(req.params.id)),v=editSchema.parse(req.body);
    if(offer.source==='api' && (v.title!==offer.title || v.description!==offer.description || v.conditions!==offer.conditions)) throw new HttpError(400,'Conteúdo recebido da API deve ser preservado.');
    if(offer.source==='api' && (v.priceCents!==undefined||v.originalPriceCents!==undefined||v.expiresAt!==undefined)) throw new HttpError(400,'Preço e validade de ofertas da API são atualizados pelo conector.');
    if(v.expiresAt && (new Date(v.expiresAt)<=new Date()||new Date(v.expiresAt)>new Date(Date.now()+7*86400000))) throw new HttpError(400,'Defina validade futura de até sete dias.');
    const product=await getProduct(db,offer.product_id),classification={category:product.category,subcategory:product.subcategory};
    await db.query("UPDATE offers SET title=$2,description=$3,category=$4,conditions=$5,featured=$6,subcategory=$7,status='pending',updated_at=now() WHERE id=$1",[offer.id,v.title,v.description,classification.category,v.conditions,v.featured,classification.subcategory]);if(offer.source!=='api')await db.query(`UPDATE offers SET price_cents=$2,original_price_cents=$3,expires_at=$4,verified_at=now(),data_updated_at=now(),availability_status='available',refresh_status='updated',last_refresh_error=NULL WHERE id=$1`,[offer.id,v.priceCents??offer.price_cents,v.originalPriceCents===undefined?offer.original_price_cents:v.originalPriceCents,v.expiresAt??offer.expires_at]);await audit(db,req.user!.id,'offer.edited',offer.id);res.json({ok:true});
  });
  app.put('/api/admin/offers/:id/classification',async()=>{throw new HttpError(409,'Edite a categoria e a subcategoria na aba Produtos.');});
  app.delete('/api/admin/offers/:id',async(req,res)=>{
    const id=uuid.parse(req.params.id),v=z.object({expectedUpdatedAt:z.iso.datetime()}).parse(req.body);
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const offer=(await client.query('SELECT status,updated_at FROM offers WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!offer)throw new HttpError(404,'Oferta não encontrada.');
      if(offer.status!=='expired')throw new HttpError(409,'Somente ofertas encerradas podem ser excluídas.');
      if(new Date(offer.updated_at).getTime()!==new Date(v.expectedUpdatedAt).getTime())throw new HttpError(409,'A oferta foi alterada. Atualize a lista antes de excluir.');
      await client.query('DELETE FROM offers WHERE id=$1',[id]);
      await audit(client,req.user!.id,'offer.deleted',id);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    res.json({ok:true});
  });
  app.post('/api/admin/offers/:id/refresh',async(req,res)=>{
    const offer=await getOffer(String(req.params.id));if(offer.source!=='api') throw new HttpError(409,'Oferta manual: confira os dados na loja e edite o preço e a validade para uma nova revisão.');
    res.json(await refreshOffer(db,config,providers,offer));
  });
  app.post('/api/admin/offers/:id/review',async(req,res)=>{
    const v=z.object({action:z.enum(['publish','reject','expire']),expectedUpdatedAt:z.iso.datetime().optional()}).parse(req.body);let offer=await getOffer(String(req.params.id));
    if(v.action==='publish') {
      if(!v.expectedUpdatedAt || new Date(v.expectedUpdatedAt).getTime()!==new Date(offer.updated_at).getTime()) throw new HttpError(409,'A oferta foi alterada. Atualize a revisão antes de publicar.');
      const oldPrice=offer.price_cents,oldConditions=offer.conditions,oldTitle=offer.title;
      if(offer.source==='api') offer=await refreshOffer(db,config,providers,offer);
      if(offer.price_cents!==oldPrice || offer.conditions!==oldConditions || offer.title!==oldTitle) throw new HttpError(409,'A oferta mudou. Confira os novos dados e aprove novamente.');
      if(!offer.affiliate_url||new Date(offer.expires_at)<=new Date()) throw new HttpError(409,'Oferta sem link válido ou expirada.');
      await assertRegisteredLink(db,offer.marketplace_id,offer.affiliate_url);
    }
    const status={publish:'published',reject:'rejected',expire:'expired'}[v.action];
    await db.query('UPDATE offers SET status=$2,reviewed_by=$3,reviewed_at=now(),published_at=CASE WHEN $2=\'published\' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1',[offer.id,status,req.user!.id]);await audit(db,req.user!.id,`offer.${status}`,offer.id);res.json({ok:true});
  });
  app.get('/api/admin/rules',async(_req,res)=>{res.json((await db.query('SELECT * FROM search_rules ORDER BY created_at DESC')).rows);});
  app.post('/api/admin/rules',async()=>{throw new HttpError(409,'Cadastre o produto e vincule os links manualmente. Buscas automáticas não podem escolher o produto.');});
  app.patch('/api/admin/rules/:id',async(req,res)=>{const v=z.object({enabled:z.literal(false)}).parse(req.body);await db.query('UPDATE search_rules SET enabled=$2 WHERE id=$1',[uuid.parse(req.params.id),v.enabled]);res.json({ok:true});});
  app.delete('/api/admin/rules/:id',async(req,res)=>{await db.query('DELETE FROM search_rules WHERE id=$1',[uuid.parse(req.params.id)]);res.json({ok:true});});
  app.post('/api/admin/rules/:id/run',async(req,res)=>{
    const {rows}=await db.query('SELECT * FROM search_rules WHERE id=$1',[uuid.parse(req.params.id)]);if(!rows[0]) throw new HttpError(404,'Busca não encontrada.');await runRule(db,config,providers,rows[0]);res.json({ok:true});
  });
  app.get('/api/admin/runs',async(_req,res)=>{res.json((await db.query('SELECT r.*,s.name AS rule_name FROM sync_runs r LEFT JOIN search_rules s ON s.id=r.rule_id ORDER BY started_at DESC LIMIT 50')).rows);});
  app.get('/api/admin/stats',async(req,res)=>{
    const days=z.coerce.number().int().min(1).max(365).default(30).parse(req.query.days),since=new Date(Date.now()-days*86400000);
    const [counts,clicks,top,daily]=await Promise.all([
      db.query('SELECT status,count(*)::int AS count FROM offers GROUP BY status'),
      db.query('SELECT m.id,m.name,count(c.id)::int AS clicks FROM marketplaces m LEFT JOIN click_events c ON c.marketplace_id=m.id AND c.created_at>=$1 GROUP BY m.id,m.name ORDER BY clicks DESC',[since]),
      db.query('SELECT o.id,o.title,o.marketplace_id,count(c.id)::int AS clicks FROM offers o JOIN click_events c ON c.offer_id=o.id WHERE c.created_at>=$1 GROUP BY o.id,o.title,o.marketplace_id ORDER BY clicks DESC LIMIT 10',[since]),
      db.query("SELECT to_char(created_at,'YYYY-MM-DD') AS day,count(*)::int AS clicks FROM click_events WHERE created_at>=$1 GROUP BY day ORDER BY day",[since])
    ]);res.json({days,offers:counts.rows,marketplaces:clicks.rows,top:top.rows,daily:daily.rows,totalClicks:clicks.rows.reduce((n,r)=>n+r.clicks,0)});
  });
  app.get('/api/admin/audit',async(_req,res)=>{res.json((await db.query('SELECT a.*,u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100')).rows);});
  app.use('/api',(_req,_res,next)=>next(new HttpError(404,'Recurso não encontrado.')));
  app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(err instanceof ZodError) return res.status(400).json({error:'Confira os campos preenchidos.',fields:err.issues.map(i=>({field:i.path.join('.'),message:i.message}))});
    if(err instanceof HttpError) return res.status(err.status).json({error:err.message});
    if((err as any)?.code==='23505') return res.status(409).json({error:'Este registro já existe.'});
    if((err as any)?.type==='entity.parse.failed') return res.status(400).json({error:'JSON inválido.'});
    if((err as any)?.type==='entity.too.large') return res.status(413).json({error:'Conteúdo excede o tamanho permitido.'});
    console.error('Falha interna da API:',err instanceof Error?err.name:'UnknownError');return res.status(500).json({error:'Não foi possível concluir. Tente novamente.'});
  });
  return app;
}
