import {randomBytes,createHash} from 'node:crypto';
import type {Express} from 'express';
import type {Config} from './config.js';
import type {Database} from './db.js';
import type {ProviderService} from './providers.js';
import {HttpError,hash,encrypt,decrypt} from './security.js';
import {audit} from './offers.js';
export const meliCallbackPath='/api/admin/mercadolivre/callback';
const completePath='/api/admin/mercadolivre/oauth/complete';
export function meliRedirectUri(config: Config) {
  const value=config.MELI_REDIRECT_URI||new URL(meliCallbackPath,config.APP_ORIGIN).href;
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!==meliCallbackPath) throw new HttpError(400,'Configure MELI_REDIRECT_URI com uma URL HTTPS terminada em '+meliCallbackPath+'.');
  return url.href;
}
const fingerprint=(c: Record<string,string>)=>hash(JSON.stringify([c.clientId,c.clientSecret]));
// Registered before the admin guard: the HTTPS tunnel need not share localhost cookies.
// This bridge only forwards an authorization code to our fixed application origin.
// Tokens are exchanged exclusively by the session-bound, admin-only completion route.
export function registerMeliCallback(app: Express,config: Config) {
  app.get(meliCallbackPath,(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    const state=typeof req.query.state==='string'?req.query.state:'';
    if(!/^[a-f0-9]{64}$/.test(state))throw new HttpError(400,'Retorno OAuth inválido. Inicie a conexão novamente.');
    const target=new URL(completePath,config.APP_ORIGIN);target.searchParams.set('state',state);
    if(typeof req.query.error==='string')target.searchParams.set('error','denied');
    else if(typeof req.query.code==='string'&&req.query.code.length>0&&req.query.code.length<=4096)target.searchParams.set('code',req.query.code);
    else throw new HttpError(400,'O Mercado Livre não retornou um código de autorização.');
    res.redirect(303,target.href);
  });
}
export function registerMeliAdminOAuth(app: Express,db: Database,config: Config,providers: ProviderService) {
  app.post('/api/admin/mercadolivre/oauth/start',async(req,res)=>{
    const redirectUri=meliRedirectUri(config);
    const row=(await db.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre'")).rows[0];
    const c=row?.credentials_encrypted?decrypt(row.credentials_encrypted,config.ENCRYPTION_KEY):{};
    if(!c.clientId||!c.clientSecret)throw new HttpError(400,'Salve o Client ID e o Client Secret antes de conectar sua conta.');
    const state=randomBytes(32).toString('hex'), verifier=config.MELI_OAUTH_PKCE==='true'?randomBytes(32).toString('base64url'):'';
    await db.query('DELETE FROM marketplace_oauth_states WHERE expires_at<=now() OR session_id=$1',[req.sessionId]);
    await db.query('INSERT INTO marketplace_oauth_states(state_hash,session_id,user_id,credentials_hash,redirect_uri,verifier_encrypted,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[hash(state),req.sessionId,req.user!.id,fingerprint(c),redirectUri,verifier?encrypt({verifier},config.ENCRYPTION_KEY):null,new Date(Date.now()+600000)]);
    const url=new URL('https://auth.mercadolivre.com.br/authorization');
    url.search=new URLSearchParams({response_type:'code',client_id:c.clientId,redirect_uri:redirectUri,state}).toString();
    if(verifier){url.searchParams.set('code_challenge',createHash('sha256').update(verifier).digest('base64url'));url.searchParams.set('code_challenge_method','S256');}
    res.json({url:url.href});
  });
  app.get(completePath,async(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    const finish=(status:string)=>res.redirect(303,new URL('/admin?meli_oauth='+status,config.APP_ORIGIN).href);
    const state=typeof req.query.state==='string'?req.query.state:'';
    if(!/^[a-f0-9]{64}$/.test(state))return finish('invalid');
    // Atomic consumption rejects replay, expiry, another browser and a different administrator.
    const result=await db.query('DELETE FROM marketplace_oauth_states WHERE state_hash=$1 AND session_id=$2 AND user_id=$3 AND expires_at>now() RETURNING *',[hash(state),req.sessionId,req.user!.id]);
    const pending=result.rows[0];if(!pending)return finish('invalid');
    if(req.query.error)return finish('denied');
    if(typeof req.query.code!=='string'||!req.query.code||req.query.code.length>4096)return finish('invalid');
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      const row=(await client.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre' FOR UPDATE")).rows[0];
      const c=row?.credentials_encrypted?decrypt(row.credentials_encrypted,config.ENCRYPTION_KEY):{};
      if(fingerprint(c)!==pending.credentials_hash)throw new HttpError(409,'As credenciais foram alteradas. Inicie a conexão novamente.');
      await providers.authorizeMeli(c,req.query.code,pending.redirect_uri,pending.verifier_encrypted?decrypt(pending.verifier_encrypted,config.ENCRYPTION_KEY).verifier:'');
      await client.query("UPDATE marketplaces SET credentials_encrypted=$1,connection_status='catalog_only',last_checked_at=now(),last_error=NULL,updated_at=now() WHERE id='mercadolivre'",[encrypt(c,config.ENCRYPTION_KEY)]);
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
      return finish('failed');
    } finally {client.release();}
    await audit(db,req.user!.id,'marketplace.oauth_connected','mercadolivre');
    return finish('success');
  });
}
