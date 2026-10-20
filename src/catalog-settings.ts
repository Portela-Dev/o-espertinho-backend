import { z } from 'zod';
import type { Express } from 'express';
import type { Database } from './db.js';
import { affiliateRecipe, validateRecipe } from './catalog-recipe.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
export const blockRule = z.strictObject({
    kind: z.enum(['login', 'challenge', 'access_denied', 'rate_limit', 'unavailable']), match: z.enum(['url_contains', 'selector', 'text']), value: z.string().trim().min(1).max(600)
});
export const catalogSettings = z.strictObject({
    intervalMs: z.number().int().min(100).max(600000).default(2000),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    humanTimeoutMs: z.number().int().min(60000).max(3600000).default(900000),
    categorySeparator: z.string().max(10).default('>'),
    blockRules: z.array(blockRule).max(40).default([]),
    recipe: affiliateRecipe.nullable().default(null),
});
export async function getCatalogSettings(db: Pick<Database, 'query'>, marketplaceId: string) {
    const row = (await db.query('SELECT * FROM extension_catalog_settings WHERE marketplace_id=$1', [marketplaceId])).rows[0];
    return {
        version: row?.version ?? 0, config: catalogSettings.parse(row?.config ?? {})
    };
}
export function registerCatalogSettings(app: Express, db: Database) {
    app.post('/api/admin/extension-catalog/sources/:id/resume', async (req, res) => {
        const id = z.uuid().parse(req.params.id);
        z.strictObject({}).parse(req.body);
        if (!(await db.query('UPDATE discovery_sources SET paused_at=NULL,pause_reason=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING id', [id])).rows.length)
            throw new HttpError(404, 'Fonte não encontrada.');
        await audit(db, req.user!.id, 'extension_catalog.source_resumed', id);
        res.json({
            ok: true
        });
    });
    app.get('/api/admin/extension-catalog/settings/:id', async (req, res) => {
        const market = (await db.query('SELECT id,name,catalog_executor FROM marketplaces WHERE id=$1', [req.params.id])).rows[0];
        if (!market)
            throw new HttpError(404, 'Marketplace não encontrado.');
        res.json({
            ...market, ...await getCatalogSettings(db, market.id)
        });
    });
    app.put('/api/admin/extension-catalog/settings/:id', async (req, res) => {
        const input = z.strictObject({
            version: z.number().int().nonnegative(), executor: z.literal('extension'), config: catalogSettings
        }).parse(req.body);
        const c = await db.connect();
        try {
            await c.query('BEGIN');
            const market = (await c.query('SELECT id,allowed_hosts,catalog_executor FROM marketplaces WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
            if (!market)
                throw new HttpError(404, 'Marketplace não encontrado.');
            if (input.config.recipe)
                validateRecipe(input.config.recipe, market);
            const current = await getCatalogSettings(c, market.id);
            if (current.version !== input.version)
                throw new HttpError(409, 'Configuração alterada. Recarregue.');
            await c.query('INSERT INTO extension_catalog_settings(marketplace_id,config) VALUES($1,$2) ON CONFLICT(marketplace_id) DO UPDATE SET config=$2,version=extension_catalog_settings.version+1,updated_at=clock_timestamp()', [market.id, JSON.stringify(input.config)]);
            await c.query('UPDATE marketplaces SET catalog_executor=$2 WHERE id=$1', [market.id, input.executor]);
            await audit(c, req.user!.id, 'extension_catalog.settings', market.id);
            await c.query('COMMIT');
            res.json(await getCatalogSettings(db, market.id));
        }
        catch (e) {
            await c.query('ROLLBACK');
            throw e;
        }
        finally {
            c.release();
        }
    });
}
