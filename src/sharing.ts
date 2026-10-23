import { isPublicHttpsUrl } from './public-url.js';
import type { Express } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';

const tokens = new Set(['titulo', 'preco', 'loja', 'url', 'texto']);
const knownTokens = (text: string) =>
  [...text.matchAll(/\{([^{}]+)\}/g)].every((m) => tokens.has(m[1]));

const logo = z
  .string()
  .max(2000)
  .refine(
    (v) => /^\/brand\/social\/[a-z0-9-]+\.svg$/.test(v) || isPublicHttpsUrl(v),
    'Use uma URL HTTPS ou um logo padrão.',
  );
export const sharingChannelSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    name: z.string().trim().min(1).max(60),
    enabled: z.boolean(),
    logoUrl: logo,
    action: z.enum(['url', 'copy']),
    urlTemplate: z.string().max(2000),
    textTemplate: z
      .string()
      .trim()
      .min(1)
      .max(3000)
      .refine(
        (v) => knownTokens(v) && !v.includes('{texto}'),
        'Use {titulo}, {preco}, {loja} e {url} no texto.',
      ),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.action === 'url' &&
      (!knownTokens(v.urlTemplate) ||
        !isPublicHttpsUrl(v.urlTemplate.replace(/\{[^{}]+\}/g, 'sample')) ||
        !/\{(?:url|texto)\}/.test(v.urlTemplate))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['urlTemplate'],
        message:
          'Informe um endereço HTTPS com {url} ou {texto} e variáveis válidas.',
      });
  });
export const sharingSettingsInput = z
  .object({
    enabled: z.boolean(),
    version: z.number().int().positive(),
    channels: z.array(sharingChannelSchema).max(20),
  })
  .strict()
  .refine(
    (v) => new Set(v.channels.map((c) => c.id)).size === v.channels.length,
    'Não repita identificadores de redes.',
  );
function settings(row: any) {
  return { enabled: row.enabled, version: row.version, channels: row.channels };
}
export function registerPublicSharing(app: Express, db: Database) {
  app.get('/api/sharing', async (_req, res) => {
    const row = (
      await db.query(
        'SELECT enabled,channels FROM offer_sharing_settings WHERE id=true',
      )
    ).rows[0];
    res.json({
      enabled: row.enabled,
      channels: row.enabled ? row.channels.filter((c: any) => c.enabled) : [],
    });
  });
}
export function registerSharingAdmin(app: Express, db: Database) {
  app.get('/api/admin/sharing', async (_req, res) =>
    res.json(
      settings(
        (await db.query('SELECT * FROM offer_sharing_settings WHERE id=true'))
          .rows[0],
      ),
    ),
  );
  app.put('/api/admin/sharing', async (req, res) => {
    const v = sharingSettingsInput.parse(req.body),
      c = await db.connect();
    try {
      await c.query('BEGIN');
      const result = await c.query(
        'UPDATE offer_sharing_settings SET enabled=$1,channels=$2,version=version+1,updated_at=clock_timestamp() WHERE id=true AND version=$3 RETURNING *',
        [v.enabled, JSON.stringify(v.channels), v.version],
      );
      if (!result.rows.length)
        throw new HttpError(
          409,
          'A configuração mudou. Recarregue antes de salvar.',
        );
      await audit(c, req.user!.id, 'sharing.updated', 'offer-sharing');
      await c.query('COMMIT');
      res.json(settings(result.rows[0]));
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  });
}
