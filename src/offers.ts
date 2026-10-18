import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import type { Config } from './config.js';
import { decrypt, encrypt, HttpError } from './security.js';
import { ProviderService, type Candidate, type ProviderId } from './providers.js';
export async function audit(db: Pick<Database,'query'>,userId: string|null,action: string,id: string) { await db.query('INSERT INTO audit_logs(id,user_id,action,entity_id) VALUES($1,$2,$3,$4)',[randomUUID(),userId,action,id]); }
export async function credentials(db: Database,config: Config,id: ProviderId) {
  const {rows}=await db.query('SELECT * FROM marketplaces WHERE id=$1',[id]);
  if(!rows[0]?.credentials_encrypted) throw new HttpError(400,'Cadastre as credenciais deste marketplace no admin.');
  return {row:rows[0],secrets:decrypt(rows[0].credentials_encrypted,config.ENCRYPTION_KEY)};
}
// Serialize refresh-token rotation across HTTP requests and worker processes.
// Persist rotation even if the subsequent marketplace request fails.
export async function withMeliCredentials<T>(db: Database,config: Config,operation:(secrets:Record<string,string>)=>Promise<T>):Promise<T> {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query("SELECT credentials_encrypted FROM marketplaces WHERE id='mercadolivre' FOR UPDATE")).rows[0];
    if(!row?.credentials_encrypted)throw new HttpError(400,'Cadastre as credenciais do Mercado Livre no admin.');
    const secrets=decrypt(row.credentials_encrypted,config.ENCRYPTION_KEY);
    let value:T|undefined,failure:unknown,failed=false;
    try{value=await operation(secrets);}catch(e){failure=e;failed=true;}
    await client.query("UPDATE marketplaces SET credentials_encrypted=$1 WHERE id='mercadolivre'",[encrypt(secrets,config.ENCRYPTION_KEY)]);
    await client.query('COMMIT');
    if(failed)throw failure;
    return value as T;
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function insertCandidate(db: Database,id: ProviderId,c: Candidate,category: string,productId:string) {
  await db.query(`INSERT INTO offers(id,marketplace_id,external_id,title,description,category,image_url,product_url,affiliate_url,price_cents,original_price_cents,source,conditions,expires_at,product_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'api',$12,$13,$14)
    ON CONFLICT(marketplace_id,affiliate_url) DO NOTHING`,[randomUUID(),id,c.externalId,c.title,c.description,category,c.imageUrl,c.productUrl,c.affiliateUrl,c.priceCents,c.originalPriceCents,c.conditions,c.expiresAt,productId]);
}
export async function runRule(db: Database,config: Config,providers: ProviderService,rule: any) {
  throw new HttpError(409,'Vincule cada link a um produto existente pelo cadastro administrativo.');
}
export async function refreshOffer(db: Database,config: Config,providers: ProviderService,offer: any) {
  if(offer.source!=='api') return offer;
  const candidate=offer.marketplace_id==='mercadolivre'
    ?await withMeliCredentials(db,config,secrets=>providers.refresh('mercadolivre',secrets,offer.external_id))
    :await providers.refresh(offer.marketplace_id,(await credentials(db,config,offer.marketplace_id)).secrets,offer.external_id);
  if(!candidate) { await db.query("UPDATE offers SET status='expired',updated_at=now() WHERE id=$1",[offer.id]); throw new HttpError(409,'Produto sem oferta disponível. A oferta foi expirada.'); }
  const changed=offer.price_cents!==candidate.priceCents || offer.conditions!==candidate.conditions;
  const {rows}=await db.query(`UPDATE offers SET title=$2,image_url=$3,price_cents=$4,original_price_cents=$5,affiliate_url=$6,conditions=$7,verified_at=now(),data_updated_at=now(),refresh_status='updated',availability_status='available',last_refresh_error=NULL,expires_at=$8,updated_at=now(),status=$9 WHERE id=$1 RETURNING *`,[offer.id,candidate.title,candidate.imageUrl,candidate.priceCents,candidate.originalPriceCents,candidate.affiliateUrl??offer.affiliate_url,candidate.conditions,candidate.expiresAt,changed?'pending':offer.status]);
  return rows[0];
}
export async function workerTick(db: Database,config: Config,providers: ProviderService) {
  await db.query('DELETE FROM marketplace_oauth_states WHERE expires_at<=now()');
  await db.query('DELETE FROM sessions WHERE expires_at<now()');
  const retention=new Date(Date.now()-365*86400000);
  await db.query('DELETE FROM click_events WHERE created_at<$1',[retention]);
  await db.query('DELETE FROM audit_logs WHERE created_at<$1',[retention]);
  await db.query('DELETE FROM sync_runs WHERE started_at<$1',[retention]);
  await db.query("UPDATE sync_runs SET status='failed',error='Execução interrompida; tente novamente.',finished_at=now() WHERE status='running' AND started_at<$1",[new Date(Date.now()-10*60000)]);
}
