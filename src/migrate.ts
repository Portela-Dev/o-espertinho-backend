import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createDatabase, type Database } from './db.js';
const digest=(sql:string)=>createHash('sha256').update(sql).digest('hex');
export function migrationChecksums(sql:string){const lf=sql.replaceAll('\r\n','\n');return {canonical:digest(lf),compatible:[digest(sql),digest(lf),digest(lf.replaceAll('\n','\r\n'))]};}
export async function migrate(db: Database) {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(73914201)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(dir,name),'utf8');
      const checksums=migrationChecksums(sql),checksum=checksums.canonical;
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name]);
      if (existing.rows.length) { if (!checksums.compatible.includes(existing.rows[0].checksum)) throw new Error(`Migration alterada: ${name}`); continue; }
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,checksum]); await client.query('COMMIT'); }
      catch (e) { await client.query('ROLLBACK'); throw e; }
      console.log(`Migration aplicada: ${name}`);
    }
  } finally { await client.query('SELECT pg_advisory_unlock(73914201)'); client.release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = createDatabase(loadConfig().DATABASE_URL);
  try { await migrate(db); } finally { await db.end(); }
}
