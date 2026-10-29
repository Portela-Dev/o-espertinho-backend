import {registerPublicSeo} from './seo.js';
import {registerCategoryAdmin} from './category-admin.js';
import { registerPublicSharing, registerSharingAdmin } from './sharing.js';
import { registerPublicMarketing, registerMarketingAdmin } from './marketing.js';
import {
  registerReviewAiAdmin,
  registerReviewAiExtension,
} from './review-ai.js';
import { registerCatalogPurge } from './catalog-purge.js';
import { registerCatalogAdmin } from './catalog-admin.js';
import { registerCatalogManual } from './catalog-manual.js';
import { registerCatalogPublication } from './catalog-publication.js';
import { registerCatalogResults } from './catalog-results.js';
import { registerCatalogRuns } from './catalog-runs.js';
import { registerCatalogSettings } from './catalog-settings.js';
import { registerEnrichmentAdmin } from './enrichment-admin.js';
import { registerDiscoveryRuns } from './discovery-runs.js';
import { registerDiscoveryAdmin } from './discovery-admin.js';
import { pagedQuery, wantsPage } from './pagination.js';
import express from 'express';
import { registerExtension } from './extension-auth.js';
import { registerUserAdmin } from './user-admin.js';
import { registerPriceHistory } from './price-history.js';
import { registerApiDocs } from './api-docs.js';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  getProduct,
  registerPublicProducts,
  registerProductAdmin,
} from './products.js';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Database } from './db.js';
import {
  HttpError,
  sessionMiddleware,
  csrfMiddleware,
  newSession,
  markSignedOut,
  clearSignedOut,
  SIGNED_OUT_COOKIE,
  hash,
  requireUser,
  requireAdmin,
  requireRecentAdmin,
  type User,
} from './security.js';
import { classificationText, requiredCategory } from './classifications.js';
import {
  registerScrapingAdmin,
  assertRegisteredLink,
} from './scraping-admin.js';
import { audit } from './offers.js';
const uuid = z.uuid();
const text = (max = 120) => z.string().trim().min(1).max(max);
const filtersSchema = z.object({
  q: z.string().max(160).default(''),
  marketplace: z
    .string()
    .regex(/^(?:[a-z][a-z0-9_-]{1,39})?$/)
    .default(''),
  category: z.string().max(80).default(''),
  categoryId: z.union([z.uuid(), z.literal('')]).default(''),
  maxPrice: z.coerce.number().int().min(0).max(100000000).default(0),
  sort: z.enum(['recent', 'price_asc', 'discount']).default('recent'),
});
const editSchema = z.object({
  title: text(300),
  description: z.string().max(4000).default(''),
  category: requiredCategory.default('Outros'),
  subcategory: classificationText.optional(),
  conditions: z.string().max(1500).default(''),
  featured: z.boolean().default(false),
  priceCents: z.number().int().positive().max(100000000).optional(),
  originalPriceCents: z
    .number()
    .int()
    .positive()
    .max(100000000)
    .nullable()
    .optional(),
  expiresAt: z.iso.datetime().optional(),
});
export interface Identity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  avatar?: string;
  authoritative: boolean;
  nonce?: string;
}
export interface AppOptions {
  verifyGoogle?: (token: string) => Promise<Identity>;
}
export function createApp(
  db: Database,
  config: Config,
  options: AppOptions = {},
) {
  const app = express();
  const google = new OAuth2Client(config.GOOGLE_CLIENT_ID);
  const verifyIdentity = async (credential: string): Promise<Identity> => {
    let identity: Identity;
    try {
      if (options.verifyGoogle)
        identity = await options.verifyGoogle(credential);
      else {
        const ticket = await google.verifyIdToken({
          idToken: credential,
          audience: config.GOOGLE_CLIENT_ID,
        });
        const p = ticket.getPayload();
        if (!p?.sub || !p.email) throw new Error('Token incompleto');
        identity = {
          sub: p.sub,
          email: p.email,
          emailVerified: !!p.email_verified,
          name: p.name || p.email,
          avatar: p.picture,
          nonce: (p as any).nonce,
          authoritative: p.email.toLowerCase().endsWith('@gmail.com') || !!p.hd,
        };
      }
    } catch {
      throw new HttpError(401, 'Não foi possível validar sua conta Google.');
    }
    if (!identity.emailVerified || !identity.authoritative)
      throw new HttpError(
        403,
        'Use uma conta Gmail ou Google Workspace com e-mail verificado.',
      );
    return identity;
  };
  app.disable('x-powered-by');
  app.set('trust proxy', (config.TRUST_PROXY || 'loopback').split(','));
  app.use(helmet(), express.json({ limit: '64kb' }), cookieParser());
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: () => config.NODE_ENV === 'test',
      message: { error: 'Muitos acessos. Aguarde um minuto.' },
    }),
  );
  app.get('/api/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.get('/api/config', (_req, res) =>
    res.json({
      googleClientId: config.GOOGLE_CLIENT_ID,
      loginAvailable: !!config.GOOGLE_CLIENT_ID,
    }),
  );
  app.use('/api', sessionMiddleware(db, config));
  registerApiDocs(app, config);
  app.get('/api/auth/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (
      !req.sessionId ||
      typeof req.cookies['XSRF-TOKEN'] !== 'string' ||
      hash(req.cookies['XSRF-TOKEN']) !== req.csrfHash
    ) {
      if (req.sessionId)
        await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
      await newSession(db, res, config, req.user?.id ?? null);
    }
    res.json({
      user: req.user ?? null,
      autoSignInAllowed: req.cookies[SIGNED_OUT_COOKIE] !== '1',
    });
  });
  registerExtension(app, db, config, (router, account) => {
    registerCatalogRuns(router, db, account);
    registerReviewAiExtension(router, db, account);
    registerCatalogResults(router, db, account);
  });
  app.use('/api', csrfMiddleware(config));
  app.post(
    '/api/auth/google',
    rateLimit({
      windowMs: 60000,
      limit: 15,
      skip: () => config.NODE_ENV === 'test',
      message: { error: 'Muitas tentativas de login. Aguarde.' },
    }),
    async (req, res) => {
      if (!config.GOOGLE_CLIENT_ID)
        throw new HttpError(
          503,
          'Login Google não configurado. Defina GOOGLE_CLIENT_ID no backend.',
        );
      const { credential, automatic } = z
        .object({
          credential: text(10000),
          automatic: z.boolean().default(false),
        })
        .parse(req.body);
      if (automatic && req.cookies[SIGNED_OUT_COOKIE] === '1')
        throw new HttpError(
          409,
          'Você saiu da conta. Escolha Entrar para acessar novamente.',
        );
      const identity = await verifyIdentity(credential);
      const email = identity.email.toLowerCase(),
        client = await db.connect();
      let user: User;
      try {
        await client.query('BEGIN');
        if (
          !(
            await client.query(
              'SELECT id FROM sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE',
              [req.sessionId],
            )
          ).rows.length
        )
          throw new HttpError(
            409,
            'A sessão mudou. Atualize a página antes de entrar.',
          );
        const { rows } = await client.query(
          'SELECT * FROM users WHERE google_sub=$1 OR email=$2 FOR UPDATE',
          [identity.sub, email],
        );
        const current =
          rows.find((r) => r.google_sub === identity.sub) ?? rows[0];
        if (current?.blocked)
          throw new HttpError(
            403,
            'Sua conta está bloqueada. Entre em contato com a administração.',
          );
        if (current?.google_sub && current.google_sub !== identity.sub)
          throw new HttpError(
            409,
            'Esta conta precisa de revisão pelo administrador.',
          );
        const id = current?.id ?? randomUUID();
        if (current) {
          const r = await client.query(
            'UPDATE users SET google_sub=$2,name=$3,avatar=$4 WHERE id=$1 RETURNING id,email,name,avatar,role',
            [id, identity.sub, identity.name, identity.avatar ?? null],
          );
          user = r.rows[0];
        } else {
          const r = await client.query(
            "INSERT INTO users(id,email,google_sub,name,avatar,role) VALUES($1,$2,$3,$4,$5,'user') RETURNING id,email,name,avatar,role",
            [id, email, identity.sub, identity.name, identity.avatar ?? null],
          );
          user = r.rows[0];
        }
        if (req.sessionId)
          await client.query('DELETE FROM sessions WHERE id=$1', [
            req.sessionId,
          ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      const access = (
        await db.query(
          'SELECT u.access_profile_id,p.permissions FROM users u JOIN access_profiles p ON p.id=u.access_profile_id WHERE u.id=$1 AND u.blocked=false',
          [user!.id],
        )
      ).rows[0];
      if (!access) throw new HttpError(403, 'Sua conta está bloqueada.');
      Object.assign(user!, access);
      await newSession(db, res, config, user!.id, !automatic);
      if (!automatic) {
        clearSignedOut(res, config);
      }
      res.set('Cache-Control', 'no-store').json({ user: user! });
    },
  );
  const reauthLimit = rateLimit({
    windowMs: 60000,
    limit: 10,
    skip: () => config.NODE_ENV === 'test',
    message: { error: 'Muitas confirmações. Aguarde um minuto.' },
  });
  app.post(
    '/api/auth/reauth/challenge',
    requireUser,
    reauthLimit,
    async (req, res) => {
      if (req.user!.role !== 'admin' && !req.user!.permissions?.length)
        throw new HttpError(403, 'Acesso administrativo necessário.');
      const nonce = randomBytes(32).toString('hex');
      await db.query(
        "UPDATE sessions SET reauth_nonce_hash=$2,reauth_nonce_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1",
        [req.sessionId, hash(nonce)],
      );
      res.set('Cache-Control', 'no-store').json({ nonce });
    },
  );
  app.post('/api/auth/reauth', requireUser, reauthLimit, async (req, res) => {
    const { credential } = z
        .object({ credential: text(10000) })
        .parse(req.body),
      identity = await verifyIdentity(credential);
    if (
      typeof identity.nonce !== 'string' ||
      !/^[a-f0-9]{64}$/.test(identity.nonce)
    )
      throw new HttpError(403, 'Confirmação sem desafio válido.');
    const result = await db.query(
      'UPDATE sessions s SET admin_verified_at=clock_timestamp(),reauth_nonce_hash=NULL,reauth_nonce_expires_at=NULL FROM users u WHERE s.id=$1 AND s.user_id=u.id AND u.id=$2 AND u.google_sub=$3 AND u.blocked=false AND s.expires_at>clock_timestamp() AND s.reauth_nonce_hash=$4 AND s.reauth_nonce_expires_at>clock_timestamp() RETURNING s.id',
      [req.sessionId, req.user!.id, identity.sub, hash(identity.nonce)],
    );
    if (!result.rows.length)
      throw new HttpError(
        403,
        'Confirmação inválida ou expirada. Use a mesma conta conectada.',
      );
    await audit(db, req.user!.id, 'session.admin_verified', req.user!.id);
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.post('/api/auth/logout', async (req, res) => {
    if (req.sessionId)
      await db.query('DELETE FROM sessions WHERE id=$1', [req.sessionId]);
    await newSession(db, res, config, null);
    markSignedOut(res, config);
    res.json({ ok: true });
  });
  registerPublicProducts(app, db);
  registerPublicSeo(app, db);
  registerPublicSharing(app, db);
  registerPublicMarketing(app, db, config);
  registerPriceHistory(app, db);
  app.get('/api/marketplaces', async (_req, res) =>
    res.json(
      (
        await db.query(
          'SELECT id,name,website_url,logo_url FROM marketplaces ORDER BY name',
        )
      ).rows,
    ),
  );
  app.get('/api/categories', async (_req, res) => {
    const { rows } = await db.query(
      "SELECT DISTINCT p.category FROM products p WHERE EXISTS(SELECT 1 FROM offers o WHERE o.product_id=p.id AND o.status='published' AND o.availability_status='available' AND o.affiliate_url IS NOT NULL) ORDER BY p.category",
    );
    res.json(rows.map((r) => r.category));
  });
  app.get('/api/offers', async (req, res) => {
    const f = filtersSchema.parse(req.query),
      page = z.coerce
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(1)
        .parse(req.query.page);
    const clauses = [
        "o.status='published'",
        "o.availability_status='available'",
      ],
      args: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      args.push(value);
      clauses.push(sql.replace('?', `$${args.length}`));
    };
    if (f.q)
      add(
        'o.title ILIKE ?',
        '%' +
          f.q.replaceAll('%', String.raw`\%`).replaceAll('_', String.raw`\_`) +
          '%',
      );
    if (f.marketplace) add('o.marketplace_id=?', f.marketplace);
    if (f.categoryId) add('o.category_ids @> ARRAY[?]::uuid[]', f.categoryId);
    else if (f.category) add('o.category=?', f.category);
    if (f.maxPrice) add('o.price_cents<=?', f.maxPrice);
    const where = clauses.join(' AND '),
      order = {
        price_asc: 'o.price_cents ASC',
        discount:
          'COALESCE((o.original_price_cents-o.price_cents)::float / NULLIF(o.original_price_cents,0),0) DESC',
        recent: 'o.featured DESC,o.published_at DESC',
      }[f.sort];
    const count = await db.query(
      `SELECT count(*)::int AS total FROM offers o WHERE ${where}`,
      args,
    );
    const { rows } = await db.query(
      `SELECT o.*,(SELECT name FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_logo_url FROM offers o WHERE ${where} ORDER BY ${order},o.id LIMIT 24 OFFSET $${args.length + 1}`,
      [...args, (page - 1) * 24],
    );
    res.json({ items: rows, total: count.rows[0].total, page, pageSize: 24 });
  });
  app.get('/api/offers/:id', async (req, res) => {
    const { rows } = await db.query(
      "SELECT offers.*,(SELECT name FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_logo_url FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",
      [uuid.parse(req.params.id)],
    );
    if (!rows[0])
      throw new HttpError(404, 'Esta oferta não está mais disponível.');
    res.json(rows[0]);
  });
  app.post(
    '/api/offers/:id/click',
    rateLimit({
      windowMs: 60000,
      limit: 60,
      skip: () => config.NODE_ENV === 'test',
      message: { error: 'Aguarde antes de tentar novamente.' },
    }),
    async (req, res) => {
      const id = uuid.parse(req.params.id),
        placement = z
          .enum(['home', 'search', 'detail', 'favorites', 'collection'])
          .default('detail')
          .parse(req.body.placement);
      const { rows } = await db.query(
        "SELECT offers.*,(SELECT name FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=offers.marketplace_id) AS marketplace_logo_url FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",
        [id],
      );
      if (!rows[0]?.affiliate_url)
        throw new HttpError(410, 'Esta oferta não está mais disponível.');
      await assertRegisteredLink(
        db,
        rows[0].marketplace_id,
        rows[0].affiliate_url,
      );
      // Aggregate, unverified clicks only. Do not attach Google ID, user ID, IP or session ID.
      await db.query(
        'INSERT INTO click_events(id,offer_id,marketplace_id,placement) VALUES($1,$2,$3,$4)',
        [randomUUID(), id, rows[0].marketplace_id, placement],
      );
      res.json({ ok: true });
    },
  );
  app.use('/api/me', requireUser, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/me/favorites', async (req, res) => {
    const result = await pagedQuery(
      db,
      req.query,
      'SELECT o.*,(SELECT name FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_logo_url FROM favorites f JOIN offers o ON o.id=f.offer_id WHERE f.user_id=$1 ORDER BY f.created_at DESC,f.offer_id',
      [req.user!.id],
    );
    res.json(result);
  });
  app.put('/api/me/favorites/:id', async (req, res) => {
    const id = uuid.parse(req.params.id),
      exists = await db.query(
        "SELECT id FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",
        [id],
      );
    if (!exists.rows.length) throw new HttpError(404, 'Oferta indisponível.');
    await db.query(
      'INSERT INTO favorites(user_id,offer_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [req.user!.id, id],
    );
    res.json({ ok: true });
  });
  app.delete('/api/me/favorites/:id', async (req, res) => {
    await db.query('DELETE FROM favorites WHERE user_id=$1 AND offer_id=$2', [
      req.user!.id,
      uuid.parse(req.params.id),
    ]);
    res.json({ ok: true });
  });
  app.get('/api/me/filters', async (req, res) => {
    const result = await pagedQuery(
      db,
      req.query,
      'SELECT * FROM saved_filters WHERE user_id=$1 ORDER BY created_at DESC,id',
      [req.user!.id],
    );
    res.json(result);
  });
  app.post('/api/me/filters', async (req, res) => {
    const v = z
      .object({ name: text(80), filters: filtersSchema })
      .parse(req.body);
    const { rows } = await db.query(
      'INSERT INTO saved_filters(id,user_id,name,filters) VALUES($1,$2,$3,$4) RETURNING *',
      [randomUUID(), req.user!.id, v.name, JSON.stringify(v.filters)],
    );
    res.status(201).json(rows[0]);
  });
  app.delete('/api/me/filters/:id', async (req, res) => {
    await db.query('DELETE FROM saved_filters WHERE id=$1 AND user_id=$2', [
      uuid.parse(req.params.id),
      req.user!.id,
    ]);
    res.json({ ok: true });
  });
  app.get('/api/me/collections', async (req, res) => {
    const result = await pagedQuery(
      db,
      req.query,
      'SELECT c.*,(SELECT count(*)::int FROM collection_items i WHERE i.collection_id=c.id) AS item_count FROM collections c WHERE c.user_id=$1 ORDER BY c.created_at DESC,id',
      [req.user!.id],
    );
    res.json(result);
  });
  app.post('/api/me/collections', async (req, res) => {
    const v = z
      .object({ name: text(80), description: z.string().max(400).default('') })
      .parse(req.body);
    const { rows } = await db.query(
      'INSERT INTO collections(id,user_id,name,description) VALUES($1,$2,$3,$4) RETURNING *',
      [randomUUID(), req.user!.id, v.name, v.description],
    );
    res.status(201).json(rows[0]);
  });
  const ownedCollection = async (id: string, userId: string) => {
    const { rows } = await db.query(
      'SELECT * FROM collections WHERE id=$1 AND user_id=$2',
      [uuid.parse(id), userId],
    );
    if (!rows[0]) throw new HttpError(404, 'Catálogo não encontrado.');
    return rows[0];
  };
  app.get('/api/me/collections/:id', async (req, res) => {
    const collection = await ownedCollection(
      String(req.params.id),
      req.user!.id,
    );
    const result = await pagedQuery(
      db,
      req.query,
      'SELECT o.*,(SELECT name FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_name, (SELECT logo_url FROM marketplaces WHERE id=o.marketplace_id) AS marketplace_logo_url FROM collection_items i JOIN offers o ON o.id=i.offer_id WHERE i.collection_id=$1 ORDER BY i.created_at DESC,o.id',
      [collection.id],
    );
    res.json({
      ...collection,
      ...(Array.isArray(result) ? { items: result } : result),
    });
  });
  app.patch('/api/me/collections/:id', async (req, res) => {
    await ownedCollection(String(req.params.id), req.user!.id);
    const v = z
      .object({ name: text(80), description: z.string().max(400).default('') })
      .parse(req.body);
    await db.query(
      'UPDATE collections SET name=$2,description=$3 WHERE id=$1',
      [req.params.id, v.name, v.description],
    );
    res.json({ ok: true });
  });
  app.delete('/api/me/collections/:id', async (req, res) => {
    await ownedCollection(String(req.params.id), req.user!.id);
    await db.query('DELETE FROM collections WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  });
  app.put('/api/me/collections/:id/items/:offerId', async (req, res) => {
    await ownedCollection(String(req.params.id), req.user!.id);
    const id = uuid.parse(req.params.offerId);
    const found = await db.query(
      "SELECT id FROM offers WHERE id=$1 AND status='published' AND availability_status='available'",
      [id],
    );
    if (!found.rows.length) throw new HttpError(404, 'Oferta indisponível.');
    await db.query(
      'INSERT INTO collection_items(collection_id,offer_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, id],
    );
    res.json({ ok: true });
  });
  app.delete('/api/me/collections/:id/items/:offerId', async (req, res) => {
    await ownedCollection(String(req.params.id), req.user!.id);
    await db.query(
      'DELETE FROM collection_items WHERE collection_id=$1 AND offer_id=$2',
      [req.params.id, uuid.parse(req.params.offerId)],
    );
    res.json({ ok: true });
  });
  app.delete('/api/me/account', async (req, res) => {
    if (req.user!.role === 'admin')
      throw new HttpError(
        409,
        'A conta administradora deve ser transferida antes da exclusão.',
      );
    await db.query('DELETE FROM users WHERE id=$1', [req.user!.id]);
    await newSession(db, res, config, null);
    markSignedOut(res, config);
    res.json({ ok: true });
  });
  app.use(
    '/api/admin',
    requireUser,
    requireAdmin,
    requireRecentAdmin,
    (_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
  );
  registerUserAdmin(app, db);
  registerProductAdmin(app, db);
  registerCategoryAdmin(app, db);
  registerCatalogPurge(app, db);
  registerSharingAdmin(app, db);
  registerMarketingAdmin(app, db);
  registerCatalogSettings(app, db);
  registerCatalogAdmin(app, db);
  registerCatalogManual(app, db);
  registerDiscoveryAdmin(app, db);
  registerDiscoveryRuns(app, db);
  registerEnrichmentAdmin(app, db);
  registerReviewAiAdmin(app, db);
  registerCatalogPublication(app, db);
  registerScrapingAdmin(app, db);
  app.get('/api/admin/category-options', async (_req, res) =>
    res.json(
      (
        await db.query(
          'SELECT category,subcategory FROM offer_category_options ORDER BY lower(category),lower(subcategory)',
        )
      ).rows,
    ),
  );
  app.get('/api/admin/offers', async (req, res) => {
    const status = z
      .enum(['all', 'pending', 'published', 'rejected', 'expired'])
      .default('pending')
      .parse(req.query.status);
    const page = z.coerce
      .number()
      .int()
      .min(1)
      .default(1)
      .parse(req.query.page);
    const where = status === 'all' ? 'TRUE' : 'o.status=$1',
      args = status === 'all' ? [] : [status];
    const sql = `SELECT o.*,p.name AS product_name,p.sku AS product_sku,m.name AS marketplace_name FROM offers o JOIN products p ON p.id=o.product_id JOIN marketplaces m ON m.id=o.marketplace_id WHERE ${where} ORDER BY o.updated_at DESC,o.id`;
    if (wantsPage(req.query)) {
      res.json(await pagedQuery(db, req.query, sql, args));
      return;
    }
    const { rows } = await db.query(
      `${sql} LIMIT 50 OFFSET $${args.length + 1}`,
      [...args, (page - 1) * 50],
    );
    res.json(rows);
  });
  const getOffer = async (id: string) => {
    const { rows } = await db.query('SELECT * FROM offers WHERE id=$1', [
      uuid.parse(id),
    ]);
    if (!rows[0]) throw new HttpError(404, 'Oferta não encontrada.');
    return rows[0];
  };
  app.patch('/api/admin/offers/:id', async (req, res) => {
    const offer = await getOffer(String(req.params.id)),
      v = editSchema.parse(req.body);
    if (
      v.expiresAt &&
      (new Date(v.expiresAt) <= new Date() ||
        new Date(v.expiresAt) > new Date(Date.now() + 7 * 86400000))
    )
      throw new HttpError(400, 'Defina validade futura de até sete dias.');
    const product = await getProduct(db, offer.product_id),
      classification = {
        category: product.category,
        subcategory: product.subcategory,
      };
    await db.query(
      "UPDATE offers SET title=$2,description=$3,category=$4,conditions=$5,featured=$6,subcategory=$7,status='pending',updated_at=now() WHERE id=$1",
      [
        offer.id,
        v.title,
        v.description,
        classification.category,
        v.conditions,
        v.featured,
        classification.subcategory,
      ],
    );
    await db.query(
      `UPDATE offers SET price_cents=$2,original_price_cents=$3,expires_at=$4,verified_at=now(),data_updated_at=now(),availability_status='available',refresh_status='updated',last_refresh_error=NULL WHERE id=$1`,
      [
        offer.id,
        v.priceCents ?? offer.price_cents,
        v.originalPriceCents === undefined
          ? offer.original_price_cents
          : v.originalPriceCents,
        v.expiresAt ?? offer.expires_at,
      ],
    );
    await audit(db, req.user!.id, 'offer.edited', offer.id);
    res.json({ ok: true });
  });
  app.put('/api/admin/offers/:id/classification', async () => {
    throw new HttpError(
      409,
      'Edite a categoria e a subcategoria na aba Produtos.',
    );
  });
  app.delete('/api/admin/offers/:id', async (req, res) => {
    const id = uuid.parse(req.params.id),
      v = z.object({ expectedUpdatedAt: z.iso.datetime() }).parse(req.body);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const offer = (
        await client.query(
          'SELECT status,updated_at FROM offers WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!offer) throw new HttpError(404, 'Oferta não encontrada.');
      if (offer.status !== 'expired')
        throw new HttpError(
          409,
          'Somente ofertas encerradas podem ser excluídas.',
        );
      if (
        new Date(offer.updated_at).getTime() !==
        new Date(v.expectedUpdatedAt).getTime()
      )
        throw new HttpError(
          409,
          'A oferta foi alterada. Atualize a lista antes de excluir.',
        );
      await client.query('DELETE FROM offers WHERE id=$1', [id]);
      await audit(client, req.user!.id, 'offer.deleted', id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  });
  app.post('/api/admin/offers/:id/review', async (req, res) => {
    const v = z
      .object({
        action: z.enum(['publish', 'reject', 'expire']),
        expectedUpdatedAt: z.iso.datetime().optional(),
      })
      .parse(req.body);
    let offer = await getOffer(String(req.params.id));
    if (v.action === 'publish') {
      if (
        !v.expectedUpdatedAt ||
        new Date(v.expectedUpdatedAt).getTime() !==
          new Date(offer.updated_at).getTime()
      )
        throw new HttpError(
          409,
          'A oferta foi alterada. Atualize a revisão antes de publicar.',
        );
      if (!offer.affiliate_url || new Date(offer.expires_at) <= new Date())
        throw new HttpError(409, 'Oferta sem link válido ou expirada.');
      await assertRegisteredLink(db, offer.marketplace_id, offer.affiliate_url);
    }
    const status = {
      publish: 'published',
      reject: 'rejected',
      expire: 'expired',
    }[v.action];
    await db.query(
      "UPDATE offers SET status=$2,reviewed_by=$3,reviewed_at=now(),published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,updated_at=now() WHERE id=$1",
      [offer.id, status, req.user!.id],
    );
    await audit(db, req.user!.id, `offer.${status}`, offer.id);
    res.json({ ok: true });
  });
  app.get('/api/admin/stats', async (req, res) => {
    const days = z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .parse(req.query.days),
      since = new Date(Date.now() - days * 86400000);
    const [counts, clicks, top, daily] = await Promise.all([
      db.query(
        'SELECT status,count(*)::int AS count FROM offers GROUP BY status',
      ),
      db.query(
        `WITH clicks AS (
          SELECT marketplace_id,count(*)::int AS total FROM click_events WHERE created_at>=$1 GROUP BY marketplace_id
        ), published AS (
          SELECT marketplace_id,count(*)::int AS total FROM offers WHERE status='published' GROUP BY marketplace_id
        ) SELECT m.id,m.name,m.logo_url,m.website_url,COALESCE(c.total,0)::int AS clicks,COALESCE(p.total,0)::int AS "publishedOffers"
          FROM marketplaces m LEFT JOIN clicks c ON c.marketplace_id=m.id LEFT JOIN published p ON p.marketplace_id=m.id
          ORDER BY clicks DESC,m.id`,
        [since],
      ),
      pagedQuery(
        db,
        {
          ...req.query,
          page: req.query.topPage ?? 1,
          pageSize: req.query.pageSize ?? 5,
        },
        'SELECT o.id,o.title,o.marketplace_id,count(c.id)::int AS clicks FROM offers o JOIN click_events c ON c.offer_id=o.id WHERE c.created_at>=$1 GROUP BY o.id,o.title,o.marketplace_id ORDER BY clicks DESC,o.id',
        [since],
        10,
      ),
      db.query(
        "SELECT to_char(created_at,'YYYY-MM-DD') AS day,count(*)::int AS clicks FROM click_events WHERE created_at>=$1 GROUP BY day ORDER BY day",
        [since],
      ),
    ]);
    res.json({
      days,
      offers: counts.rows,
      marketplaces: clicks.rows,
      top: Array.isArray(top) ? top : top.items,
      topTotal: Array.isArray(top) ? top.length : top.total,
      topPage: Array.isArray(top) ? 1 : top.page,
      topPageSize: Array.isArray(top) ? 10 : top.pageSize,
      daily: daily.rows,
      totalClicks: clicks.rows.reduce((n, r) => n + r.clicks, 0),
    });
  });
  app.get('/api/admin/audit', async (req, res) =>
    res.json(
      await pagedQuery(
        db,
        req.query,
        'SELECT a.*,u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC,a.id',
        [],
        100,
      ),
    ),
  );
  app.use('/api', (_req, _res, next) =>
    next(new HttpError(404, 'Recurso não encontrado.')),
  );
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ZodError)
        return res.status(400).json({
          error: 'Confira os campos preenchidos.',
          fields: err.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        });
      if (err instanceof HttpError)
        return res.status(err.status).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        });
      if ((err as any)?.code === '23505')
        return res.status(409).json({ error: 'Este registro já existe.' });
      if ((err as any)?.type === 'entity.parse.failed')
        return res.status(400).json({ error: 'JSON inválido.' });
      if ((err as any)?.type === 'entity.too.large')
        return res
          .status(413)
          .json({ error: 'Conteúdo excede o tamanho permitido.' });
      console.error(
        'Falha interna da API:',
        err instanceof Error ? err.name : 'UnknownError',
      );
      return res
        .status(500)
        .json({ error: 'Não foi possível concluir. Tente novamente.' });
    },
  );
  return app;
}
