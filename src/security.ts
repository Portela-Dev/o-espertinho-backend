import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Database } from './db.js';
import type { Config } from './config.js';
export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function equal(a: string, b: string) { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); }
export interface User { id: string; email: string; name: string; avatar: string|null; role: 'user'|'admin'; access_profile_id?:string; permissions?:string[] }
declare global { namespace Express { interface Request { sessionId?: string; user?: User; csrfHash?: string; adminVerifiedAt?: Date } } }
export const AUTH_SESSION_MS=30*86400000;
const ANONYMOUS_SESSION_MS=12*3600000;
export const SIGNED_OUT_COOKIE='espertinho.signed_out';
const cookieOptions=(config:Config,maxAge:number)=>({secure:config.NODE_ENV==='production',sameSite:'lax' as const,path:'/',maxAge});
export function setSignedOut(res:Response,config:Config,signedOut:boolean){
 if(signedOut)res.cookie(SIGNED_OUT_COOKIE,'1',{...cookieOptions(config,AUTH_SESSION_MS),httpOnly:true});
 else res.clearCookie(SIGNED_OUT_COOKIE,{secure:config.NODE_ENV==='production',sameSite:'lax',path:'/',httpOnly:true});
}
export function sessionMiddleware(db: Database, config: Config) {
  return async (req: Request,res: Response,next: NextFunction) => {
    try {
      const cookie=req.cookies['espertinho.sid'];
      if (typeof cookie==='string' && /^[a-f0-9]{64}$/.test(cookie)) {
        const { rows }=await db.query(`SELECT s.id,s.csrf_hash,s.admin_verified_at,s.expires_at<clock_timestamp()+interval '29 days' AS renew_due,u.id AS user_id,u.email,u.name,u.avatar,u.role,u.blocked,u.access_profile_id,p.permissions FROM sessions s LEFT JOIN users u ON u.id=s.user_id LEFT JOIN access_profiles p ON p.id=u.access_profile_id WHERE s.id=$1 AND s.expires_at>now()`,[hash(cookie)]);
        if (rows[0]) {
          const r=rows[0];req.sessionId=r.id;req.csrfHash=r.csrf_hash;req.adminVerifiedAt=r.admin_verified_at?new Date(r.admin_verified_at):undefined;
          // A late automatic response must not undo an explicit sign-out in another tab.
          if(r.user_id&&(r.blocked||req.cookies[SIGNED_OUT_COOKIE]==='1')){
            await db.query('DELETE FROM sessions WHERE id=$1',[r.id]);delete req.sessionId;delete req.csrfHash;return next();
          }
          if(r.user_id){
            res.set('Cache-Control','private, no-store');
            req.user={id:r.user_id,email:r.email,name:r.name,avatar:r.avatar,role:r.role,access_profile_id:r.access_profile_id,permissions:r.permissions??[]};
            const csrf=req.cookies['XSRF-TOKEN'];
            // Refresh at most daily. Keep the same identifiers so other tabs retain valid XSRF tokens.
            if(r.renew_due&&typeof csrf==='string'&&equal(hash(csrf),r.csrf_hash)){
              const renewed=await db.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '30 days' WHERE id=$1 AND expires_at>clock_timestamp() RETURNING id",[r.id]);
              if(renewed.rows.length){const opts=cookieOptions(config,AUTH_SESSION_MS);res.cookie('espertinho.sid',cookie,{...opts,httpOnly:true});res.cookie('XSRF-TOKEN',csrf,{...opts,httpOnly:false});}
              else{delete req.user;delete req.sessionId;delete req.csrfHash;}
            }
          }
        }
      }
      next();
    } catch(e) { next(e); }
  };
}
export async function newSession(db: Pick<Database,'query'>,res: Response,config: Config,userId: string|null, recentlyVerified=false) {
  const sid=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex'),ttl=userId?AUTH_SESSION_MS:ANONYMOUS_SESSION_MS;
  await db.query("INSERT INTO sessions(id,user_id,csrf_hash,expires_at,admin_verified_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond',CASE WHEN $5 THEN clock_timestamp() ELSE NULL END)",[hash(sid),userId,hash(csrf),ttl,recentlyVerified]);
  const opts=cookieOptions(config,ttl);
  res.cookie('espertinho.sid',sid,{...opts,httpOnly:true}); res.cookie('XSRF-TOKEN',csrf,{...opts,httpOnly:false});
}
export function csrfMiddleware(config: Config) {
  return (req: Request,_res: Response,next: NextFunction) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    if (req.get('origin') !== config.APP_ORIGIN) return next(new HttpError(403,'Origem não autorizada.'));
    const token=req.get('X-XSRF-TOKEN');
    if (!token || !req.csrfHash || !equal(hash(token),req.csrfHash)) return next(new HttpError(403,'Token XSRF inválido. Atualize a página.'));
    next();
  };
}
export function requireUser(req: Request,_res: Response,next: NextFunction) { next(req.user ? undefined : new HttpError(401,'Entre com Google para continuar.')); }
function extensionAdminPermissions(section:string,method:string):string[]{
 const sections:Record<string,string[]>={sources:['discovery'],manual:['catalog','selectors'],runs:['catalog','discovery','updates']};
 if(sections[section])return sections[section];
 return method==='GET'?['catalog','discovery','updates','marketplaces','selectors']:['marketplaces'];
}
function adminPermissions(parts:string[],method:string):string[]{
 const resource=parts[0];
 const fixed:Record<string,string[]>={users:['users'],'access-profiles':['users'],stats:['overview'],audit:['activity'],'offer-refresh':['updates'],selectors:['selectors'],'category-tree':['catalog'],'category-options':['catalog'],products:['catalog'],offers:['catalog'],'link-imports':['catalog']};
 if(fixed[resource])return fixed[resource];
 if(resource==='extension-catalog')return extensionAdminPermissions(parts[1],method);
 if(resource==='catalog-marketplaces')return method==='GET'?['catalog','selectors','marketplaces','discovery']:['marketplaces'];
 if(resource==='discovery')return parts[1]==='enrichment'?['discovery','catalog']:['discovery'];
 return [];
}
export function requireAdmin(req: Request,_res: Response,next: NextFunction) {
 if(req.user?.role==='admin')return next();
 const parts=req.path.split('/').filter(Boolean).map(part=>part.toLowerCase());
 const allowed=adminPermissions(parts,req.method),granted=req.user?.permissions??[];
 next(allowed.some(permission=>granted.includes(permission))?undefined:new HttpError(403,'Seu perfil não tem permissão para esta área administrativa.'));
}
export const ADMIN_VERIFICATION_MS=15*60*1000;
export function requireRecentAdmin(req:Request,_res:Response,next:NextFunction){
 const resource=req.path.split('/').find(Boolean)?.toLowerCase()??'';
 const sensitive=!['GET','HEAD','OPTIONS'].includes(req.method)&&['users','access-profiles','marketplaces','catalog-marketplaces','selectors','offer-refresh','discovery','extension-catalog'].includes(resource);
 if(sensitive&&(!req.adminVerifiedAt||Date.now()-req.adminVerifiedAt.getTime()>ADMIN_VERIFICATION_MS))return next(new HttpError(403,'Confirme sua conta Google para concluir esta operação.','ADMIN_REAUTH_REQUIRED'));
 next();
}
