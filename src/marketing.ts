import type { Express } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';
import type { Config } from './config.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';

export const metaPixelInput = z.strictObject({
  enabled: z.boolean(),
  pixelId: z.string().regex(/^[0-9]{5,30}$/),
  version: z.number().int().positive(),
});
const settings = (row: any) => ({
  enabled: row.enabled, pixelId: row.pixel_id, version: row.version,
});

export function registerPublicMarketing(app: Express, db: Database, config: Config) {
  app.get('/api/marketing', async (_req, res) => {
    const row = (await db.query('SELECT enabled,pixel_id FROM meta_pixel_settings WHERE id=true')).rows[0];
    const enabled = row.enabled && config.NODE_ENV === 'production' && config.APP_ORIGIN.startsWith('https://');
    res.set('Cache-Control', 'no-store').json({
      enabled, pixelId: enabled ? row.pixel_id : null, allowedOrigin: config.APP_ORIGIN,
    });
  });
}

export function registerMarketingAdmin(app: Express, db: Database) {
  app.get('/api/admin/marketing', async (_req, res) => {
    res.json(settings((await db.query('SELECT enabled,pixel_id,version FROM meta_pixel_settings WHERE id=true')).rows[0]));
  });
  app.put('/api/admin/marketing', async (req, res) => {
    const value = metaPixelInput.parse(req.body), client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('UPDATE meta_pixel_settings SET enabled=$1,pixel_id=$2,version=version+1,updated_at=clock_timestamp() WHERE id=true AND version=$3 RETURNING enabled,pixel_id,version', [value.enabled, value.pixelId, value.version]);
      if (!result.rows.length) throw new HttpError(409, 'A configuração mudou. Recarregue antes de salvar.');
      await audit(client, req.user!.id, 'marketing.updated', 'meta-pixel');
      await client.query('COMMIT');
      res.json(settings(result.rows[0]));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
}
