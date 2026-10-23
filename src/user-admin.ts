import { pagedQuery } from './pagination.js';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { HttpError } from './security.js';
import { audit } from './offers.js';

export const accessPermissions = [
  { id: 'overview', name: 'Visão geral e métricas' },
  { id: 'catalog', name: 'Produtos, links e revisão de ofertas' },
  { id: 'marketplaces', name: 'Marketplaces e integrações' },
  { id: 'selectors', name: 'Seletores e testes de extração' },
  { id: 'discovery', name: 'Configuração de exploração de marketplaces' },
  { id: 'updates', name: 'Consultar execuções e atualizar preços' },
  { id: 'activity', name: 'Registro de atividade' },
  { id: 'affiliate_links', name: 'Gerar links de afiliados pela extensão' },
  {
    id: 'purge',
    name: 'Expurgar ofertas, produtos e dependências (exclusão física)',
  },
  {
    id: 'users',
    name: 'Gestão de usuários e perfis (permite conceder acesso administrativo)',
  },
] as const;
const profileInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(''),
  permissions: z
    .array(
      z.enum([
        'overview',
        'catalog',
        'marketplaces',
        'selectors',
        'updates',
        'activity',
        'users',
        'affiliate_links',
        'discovery',
        'purge',
      ]),
    )
    .max(10)
    .transform((v) => [...new Set(v)]),
});
const userColumns =
  'u.id,u.email,u.name,u.avatar,u.role,u.access_profile_id,u.blocked,u.created_at,p.name AS profile_name';
export function registerUserAdmin(app: Express, db: Database) {
  app.get('/api/admin/access-profiles', async (req, res) => {
    const result = await pagedQuery(
      db,
      req.query,
      'SELECT p.*,(SELECT count(*)::int FROM users u WHERE u.access_profile_id=p.id) AS user_count FROM access_profiles p ORDER BY p.system DESC,lower(p.name),p.id',
    );
    res.json({
      permissions: accessPermissions,
      ...(Array.isArray(result)
        ? { profiles: result }
        : { ...result, profiles: result.items }),
    });
  });
  app.post('/api/admin/access-profiles', async (req, res) => {
    const v = profileInput.parse(req.body),
      id = randomUUID();
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'INSERT INTO access_profiles(id,name,description,permissions) VALUES($1,$2,$3,$4)',
        [id, v.name, v.description, v.permissions],
      );
      await audit(c, req.user!.id, 'profile.created', id);
      await c.query('COMMIT');
      res.status(201).json({ id });
    } catch (e) {
      await c.query('ROLLBACK');
      if ((e as { code?: string }).code === '23505')
        throw new HttpError(409, 'Já existe um perfil com esse nome.');
      throw e;
    } finally {
      c.release();
    }
  });
  app.put('/api/admin/access-profiles/:id', async (req, res) => {
    const v = profileInput
      .extend({ expectedUpdatedAt: z.iso.datetime() })
      .parse(req.body);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const p = (
        await c.query('SELECT * FROM access_profiles WHERE id=$1 FOR UPDATE', [
          req.params.id,
        ])
      ).rows[0];
      if (!p) throw new HttpError(404, 'Perfil não encontrado.');
      if (p.system)
        throw new HttpError(409, 'Os perfis padrão não podem ser alterados.');
      if (new Date(p.updated_at).toISOString() !== v.expectedUpdatedAt)
        throw new HttpError(409, 'O perfil mudou. Recarregue antes de salvar.');
      await c.query(
        'UPDATE access_profiles SET name=$2,description=$3,permissions=$4,updated_at=clock_timestamp() WHERE id=$1',
        [p.id, v.name, v.description, v.permissions],
      );
      await audit(c, req.user!.id, 'profile.updated', p.id);
      await c.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await c.query('ROLLBACK');
      if ((e as { code?: string }).code === '23505')
        throw new HttpError(409, 'Já existe um perfil com esse nome.');
      throw e;
    } finally {
      c.release();
    }
  });
  app.delete('/api/admin/access-profiles/:id', async (req, res) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const p = (
        await c.query('SELECT * FROM access_profiles WHERE id=$1 FOR UPDATE', [
          req.params.id,
        ])
      ).rows[0];
      if (!p) throw new HttpError(404, 'Perfil não encontrado.');
      if (p.system)
        throw new HttpError(409, 'Os perfis padrão não podem ser excluídos.');
      if (
        (
          await c.query(
            'SELECT id FROM users WHERE access_profile_id=$1 LIMIT 1',
            [p.id],
          )
        ).rows.length
      )
        throw new HttpError(
          409,
          'Transfira os usuários deste perfil antes de excluí-lo.',
        );
      await c.query('DELETE FROM access_profiles WHERE id=$1', [p.id]);
      await audit(c, req.user!.id, 'profile.deleted', p.id);
      await c.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await c.query('ROLLBACK');
      if ((e as { code?: string }).code === '23503')
        throw new HttpError(409, 'Este perfil está em uso.');
      throw e;
    } finally {
      c.release();
    }
  });
  app.get('/api/admin/users', async (req, res) => {
    const v = z
      .object({
        q: z.string().trim().max(160).default(''),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(25),
        profile: z.string().max(80).default(''),
        status: z.enum(['all', 'active', 'blocked']).default('all'),
      })
      .parse(req.query);
    const args = [
      `%${v.q
        .replaceAll('\\', String.raw`\\`)
        .replaceAll('%', String.raw`\%`)
        .replaceAll('_', String.raw`\_`)}%`,
      v.profile,
      v.status,
    ];
    const where =
      "(u.name ILIKE $1 OR u.email ILIKE $1) AND ($2='' OR u.access_profile_id=$2) AND ($3='all' OR u.blocked=($3='blocked'))";
    const total = (
      await db.query(
        `SELECT count(*)::int AS total FROM users u WHERE ${where}`,
        args,
      )
    ).rows[0].total;
    const page = v.page;
    const items = (
      await db.query(
        `SELECT ${userColumns} FROM users u JOIN access_profiles p ON p.id=u.access_profile_id WHERE ${where} ORDER BY u.created_at DESC,u.id LIMIT $4 OFFSET $5`,
        [...args, v.pageSize, (page - 1) * v.pageSize],
      )
    ).rows;
    res.json({ items, total, page, pageSize: v.pageSize });
  });
  app.patch('/api/admin/users/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id),
      v = z
        .object({
          profileId: z.string().min(1).max(80),
          blocked: z.boolean(),
          expectedProfileId: z.string().min(1).max(80),
          expectedBlocked: z.boolean(),
        })
        .parse(req.body);
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      // Serialize membership changes, including concurrent attempts to remove the last admin.
      await c.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const u = (await c.query('SELECT * FROM users WHERE id=$1', [id]))
        .rows[0];
      if (!u) throw new HttpError(404, 'Usuário não encontrado.');
      if (
        u.access_profile_id !== v.expectedProfileId ||
        u.blocked !== v.expectedBlocked
      )
        throw new HttpError(
          409,
          'O usuário mudou. Recarregue antes de salvar.',
        );
      if (
        id === req.user!.id &&
        (v.blocked || v.profileId !== u.access_profile_id)
      )
        throw new HttpError(
          409,
          'Peça a outro administrador para alterar seu próprio acesso.',
        );
      if (
        !(
          await c.query(
            'SELECT id FROM access_profiles WHERE id=$1 FOR KEY SHARE',
            [v.profileId],
          )
        ).rows.length
      )
        throw new HttpError(400, 'Selecione um perfil existente.');
      if (
        u.role === 'admin' &&
        !u.blocked &&
        (v.profileId !== 'admin' || v.blocked) &&
        !(
          await c.query(
            "SELECT id FROM users WHERE role='admin' AND blocked=false AND id<>$1 LIMIT 1",
            [id],
          )
        ).rows.length
      )
        throw new HttpError(
          409,
          'É necessário manter pelo menos um administrador ativo.',
        );
      await c.query(
        "UPDATE users SET access_profile_id=$2,role=CASE WHEN $2='admin' THEN 'admin' ELSE 'user' END,blocked=$3 WHERE id=$1",
        [id, v.profileId, v.blocked],
      );
      if (v.blocked)
        await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(
        c,
        req.user!.id,
        v.blocked ? 'user.blocked' : 'user.access_updated',
        id,
      );
      await c.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  });
}
