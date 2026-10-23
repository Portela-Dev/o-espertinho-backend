import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
export async function audit(db: Pick<Database,'query'>,userId: string|null,action: string,id: string) { await db.query('INSERT INTO audit_logs(id,user_id,action,entity_id) VALUES($1,$2,$3,$4)',[randomUUID(),userId,action,id]); }
export async function workerTick(db: Database) {
  await db.query('DELETE FROM offer_import_previews WHERE expires_at<clock_timestamp() AND offer_id IS NULL');
  await db.query('DELETE FROM sessions WHERE expires_at<now()');
  await db.query('DELETE FROM extension_sessions WHERE refresh_expires_at<clock_timestamp()');
  await db.query("UPDATE extension_catalog_runs SET status='failed',reason='intervention_expired',updated_at=clock_timestamp() WHERE expires_at<clock_timestamp() AND status NOT IN ('completed','failed','cancelled')");
  await db.query("DELETE FROM offer_price_history WHERE day<(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-364");

  const retention=new Date(Date.now()-365*86400000);
  await db.query('DELETE FROM click_events WHERE created_at<$1',[retention]);
  await db.query('DELETE FROM audit_logs WHERE created_at<$1',[retention]);
}
