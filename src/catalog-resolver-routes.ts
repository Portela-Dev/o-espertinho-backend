import type { Express, Router } from 'express';
import { z } from 'zod';
import type { Database } from './db.js';
import type { CatalogActor } from './catalog-contracts.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';
import { pagedQuery } from './pagination.js';
import { catalogTransaction } from './catalog-runs.js';
import { policyInput } from './catalog-identity.js';
import {
  resolverSettings,
  prepareIdentities,
  startResolver,
  claimResolver,
  completeResolver,
  resolverAction,
  runSummary,
  resolverAllowed,
} from './catalog-resolver.js';
export function registerResolverExtension(
  router: Router,
  db: Database,
  account: (req: any) => Promise<CatalogActor>,
) {
  router.post('/catalog/resolver/prepare', async (req, res) => {
    resolverAllowed(await account(req));
    const v = z
      .strictObject({ cursor: z.uuid().nullable().default(null) })
      .parse(req.body);
    res.json(await prepareIdentities(db, v.cursor));
  });
  router.post('/catalog/resolver/start', async (req, res) =>
    res.json(await startResolver(db, await account(req), req.body)),
  );
  router.post('/catalog/resolver/claim', async (req, res) => {
    const v = z.strictObject({ runId: z.uuid() }).parse(req.body);
    res.json(await claimResolver(db, await account(req), v.runId));
  });
  router.post('/catalog/resolver/complete', async (req, res) =>
    res.json(await completeResolver(db, await account(req), req.body)),
  );
  router.post('/catalog/resolver/action', async (req, res) => {
    const v = z
      .strictObject({
        runId: z.uuid(),
        action: z.enum(['pause', 'resume', 'cancel']),
      })
      .parse(req.body);
    res.json(await resolverAction(db, await account(req), v.runId, v.action));
  });
}
export function registerResolverAdmin(app: Express, db: Database) {
  const base = '/api/admin/discovery/enrichment/resolver';
  app.use(base, (req, _res, next) => {
    if (!req.user?.permissions?.includes('catalog'))
      return next(new HttpError(403, 'Permissão de catálogo necessária.'));
    next();
  });
  app.get(base + '/settings', async (_req, res) =>
    res.json({
      settings: await resolverSettings(db),
      policies: (
        await db.query(
          "SELECT id,version,enabled,definition FROM catalog_identity_policies WHERE id<>'_title' ORDER BY id",
        )
      ).rows,
    }),
  );
  app.put(base + '/settings', async (req, res) => {
    const v = z
      .strictObject({
        version: z.number().int().positive(),
        mode: z.enum(['shadow', 'active']),
        maxAttempts: z.number().int().min(1).max(5).optional(),
        concurrency: z.number().int().min(1).max(2),
      })
      .parse(req.body);
    const r = await db.query(
      'UPDATE catalog_resolver_settings SET version=version+1,mode=$2,max_attempts=COALESCE($3,max_attempts),concurrency=$4,updated_by=$5,updated_at=clock_timestamp() WHERE id=true AND version=$1 RETURNING *',
      [v.version, v.mode, v.maxAttempts, v.concurrency, req.user!.id],
    );
    if (!r.rows.length)
      throw new HttpError(409, 'Configuração alterada. Recarregue.');
    await audit(db, req.user!.id, 'catalog_resolver.settings', 'global');
    res.json(r.rows[0]);
  });
  app.put(base + '/policies/:id', async (req, res) => {
    const id = z
        .string()
        .regex(/^[a-z][a-z0-9_-]{1,39}$/)
        .parse(req.params.id),
      v = z
        .strictObject({
          version: z.number().int().nonnegative(),
          enabled: z.boolean(),
          definition: policyInput,
        })
        .parse(req.body);
    res.json(
      await catalogTransaction(db, async (c) => {
        if (
          v.definition.categoryId &&
          !(
            await c.query('SELECT id FROM category_nodes WHERE id=$1', [
              v.definition.categoryId,
            ])
          ).rows.length
        )
          throw new HttpError(400, 'Categoria não encontrada.');
        const previous = (
          await c.query(
            'SELECT version FROM catalog_identity_policies WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if ((previous?.version ?? 0) !== v.version)
          throw new HttpError(409, 'Política alterada. Recarregue.');
        const r = (
          await c.query(
            'INSERT INTO catalog_identity_policies(id,definition,enabled) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET definition=$2,enabled=$3,version=catalog_identity_policies.version+1,updated_at=clock_timestamp() RETURNING *',
            [id, JSON.stringify(v.definition), v.enabled],
          )
        ).rows[0];
        await audit(c, req.user!.id, 'catalog_resolver.policy', id);
        return r;
      }),
    );
  });
  app.get(base + '/runs', async (req, res) =>
    res.json(
      await pagedQuery(
        db,
        { ...req.query, paginate: 'true' },
        'SELECT r.*, (SELECT count(*)::int FROM catalog_resolver_items WHERE run_id=r.id) AS total FROM catalog_resolver_runs r ORDER BY created_at DESC',
      ),
    ),
  );
  app.get(base + '/runs/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      run = (
        await db.query('SELECT * FROM catalog_resolver_runs WHERE id=$1', [id])
      ).rows[0];
    if (!run) throw new HttpError(404, 'Execução não encontrada.');
    res.json(await runSummary(db, run));
  });
  app.get(base + '/items', async (req, res) => {
    const v = z
      .object({
        runId: z.uuid(),
        status: z
          .enum(['', 'accepted', 'excluded', 'failed', 'queued', 'leased', 'skipped'])
          .default(''),
      })
      .parse(req.query);
    res.json(
      await pagedQuery(
        db,
        { ...req.query, paginate: 'true' },
        "SELECT i.id,i.status,i.attempts,i.decision,i.calls,i.tokens,i.elapsed_ms,i.evaluation,i.updated_at,l.enrichment_data->>'title' AS title FROM catalog_resolver_items i LEFT JOIN discovery_links l ON l.id=i.link_id WHERE i.run_id=$1 AND ($2='' OR i.status=$2) ORDER BY i.id",
        [v.runId, v.status],
      ),
    );
  });
  app.patch(base + '/items/:id/evaluation', async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      v = z
        .strictObject({
          evaluation: z.enum([
            'correct',
            'false_merge',
            'duplicate',
            'wrong_category',
            'excluded_valid',
          ]),
        })
        .parse(req.body);
    const row = (
      await db.query(
        'UPDATE catalog_resolver_items SET evaluation=$2 WHERE id=$1 RETURNING id,evaluation',
        [id, v.evaluation],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, 'Resultado não encontrado.');
    await audit(db, req.user!.id, 'catalog_resolver.evaluated', id);
    res.json(row);
  });
  app.post(base + '/prepare', async (req, res) => {
    const v = z
      .strictObject({ cursor: z.uuid().nullable().default(null) })
      .parse(req.body);
    res.json(await prepareIdentities(db, v.cursor));
  });
  app.post(base + '/runs/:id/action', async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      v = z
        .strictObject({ action: z.enum(['pause', 'resume', 'cancel']) })
        .parse(req.body);
    const owner = (
      await db.query(
        'SELECT created_by,extension_session_id FROM catalog_resolver_runs WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!owner) throw new HttpError(404, 'Execução não encontrada.');
    res.json(
      await resolverAction(
        db,
        {
          ...owner,
          id: owner.created_by,
          permissions: ['catalog', 'affiliate_links'],
        },
        id,
        v.action,
      ),
    );
  });
}
