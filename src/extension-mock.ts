import express, { type Express, type Request } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {registerSessionProof} from './extension-session-proof.js';
import {registerAffiliateProof} from './affiliate-proof.js';
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import {
  csrfMiddleware,
  equal,
  hash,
  HttpError,
  requireUser,
} from "./security.js";

const secret = () => randomBytes(32).toString("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const linkPermission = "affiliate_links";
interface Pair {
  challenge: string;
  extensionId: string;
  expires: number;
  userId?: string;
  sessionId?: string;
}
interface Item {
  id: string;
  title: string;
  originalUrl: string;
  state: "pending" | "leased" | "done" | "failed";
  lease?: string;
  until?: number;
  owner?: string;
  affiliateUrl?: string;
  error?: string;
}
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function registerExtensionMock(
  app: Express,
  db: Database,
  config: Config,
  transport:typeof fetch=fetch,
) {
  // The data plane is deliberately unavailable in production. Authentication uses real accounts.
  if (
    config.NODE_ENV === "production" ||
    config.EXTENSION_MOCK_ENABLED === "false"
  )
    return;
  const router = express.Router(),
    base = new URL(config.EXTENSION_BACKEND_URL ?? "http://localhost:3000")
      .origin;
  const pairs = new Map<string, Pair>();
  const queues = new Map<string, Item[]>();
  const sweep = () => {
    for (const [code, p] of pairs)
      if (p.expires < Date.now()) pairs.delete(code);
  };
  const extensionId = (req: Request) => {
    const id = req.get("X-Espertinho-Extension-Id") ?? "";
    if (!/^[a-p]{32}$/.test(id))
      throw new HttpError(403, "Identificador da extensão inválido.");
    const origin = req.get("Origin");
    if (origin && origin !== `chrome-extension://${id}`)
      throw new HttpError(403, "Origem da extensão inválida.");
    return id;
  };
  const requirePermission = (permissions: string[]) => {
    if (!permissions.includes(linkPermission))
      throw new HttpError(
        403,
        "Seu perfil precisa da permissão Gerar links de afiliados.",
        "EXTENSION_PERMISSION_REQUIRED",
      );
  };
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      skip: () => config.NODE_ENV === "test",
      message: { error: "Muitas solicitações da extensão. Aguarde um minuto." },
    }),
  );
  router.use((req, res, next) => {
    const origin = req.get("Origin");
    if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      res.set("Access-Control-Allow-Origin", origin).vary("Origin");
      res.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Espertinho-Extension-Id",
      );
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
    }
    next();
  });
  router.post("/auth/start", (req, res) => {
    const id = extensionId(req),
      { challenge } = z.object({ challenge: hex }).parse(req.body);
    sweep();
    if (pairs.size >= 100)
      throw new HttpError(429, "Muitas conexões pendentes. Aguarde.");
    const code = randomBytes(8).toString("hex");
    pairs.set(code, {
      challenge,
      extensionId: id,
      expires: Date.now() + 300000,
    });
    res.json({
      deviceCode: code,
      verificationUrl: `${base}/api/extension/auth/connect?code=${code}`,
      expiresAt: Date.now() + 300000,
      intervalMs: 3000,
    });
  });
  router.get("/auth/connect", (req, res) => {
    const code = z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .parse(req.query.code);
    sweep();
    if (!pairs.has(code))
      throw new HttpError(
        410,
        "Conexão expirada. Inicie novamente na extensão.",
      );
    res
      .type("html")
      .send(
        `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conectar extensão — O Espertinho</title><script src="/api/extension/auth/connect.js" defer></script></head><body><main><h1>Conectar extensão ao O Espertinho</h1><p>Autorize somente se você iniciou esta conexão na extensão.</p><p id="status" role="status">Verificando sua conta…</p><p><a href="${escape(config.APP_ORIGIN)}" target="_blank" rel="noopener noreferrer">Entrar no O Espertinho com Google</a></p><button type="button" id="reload">Verificar login novamente</button> <button type="button" id="approve" disabled>Autorizar extensão</button><p>As ofertas são demonstrativas. A prova de sessão só envia cookies ao servidor quando você aciona explicitamente a captura na extensão; eles são usados no teste e não são salvos no banco.</p></main></body></html>`,
      );
  });
  router.get("/auth/connect.js", (_req, res) =>
    res.type("application/javascript").send(`
let csrf='';const status=document.querySelector('#status'),button=document.querySelector('#approve');
async function check(){button.disabled=true;try{const r=await fetch('/api/auth/session',{cache:'no-store'});if(!r.ok)throw Error('Falha ao consultar sessão.');const {user}=await r.json();csrf=decodeURIComponent(document.cookie.split('; ').find(v=>v.startsWith('XSRF-TOKEN='))?.slice(11)||'');if(!user){status.textContent='Entre com Google no site e depois clique em Verificar login novamente.';return;}if(!user.permissions?.includes('affiliate_links')){status.textContent='Seu perfil não tem permissão para gerar links de afiliados.';return;}status.textContent='Conectar como '+user.email;button.disabled=false;}catch(e){status.textContent=e.message;}}
document.querySelector('#reload').addEventListener('click',check);button.addEventListener('click',async()=>{button.disabled=true;try{const r=await fetch('/api/extension/auth/approve',{method:'POST',headers:{'Content-Type':'application/json','X-XSRF-TOKEN':csrf},body:JSON.stringify({code:new URL(location.href).searchParams.get('code')})});const body=await r.json();if(!r.ok)throw Error(body.error||'Não foi possível autorizar.');status.textContent='Extensão autorizada. Você pode fechar esta aba e voltar à extensão.';}catch(e){status.textContent=e.message;button.disabled=false;}});check();`),
  );
  router.post(
    "/auth/approve",
    csrfMiddleware({ ...config, APP_ORIGIN: base }),
    requireUser,
    (req, res) => {
      requirePermission(req.user!.permissions ?? []);
      sweep();
      const { code } = z
          .object({ code: z.string().regex(/^[a-f0-9]{16}$/) })
          .parse(req.body),
        pair = pairs.get(code);
      if (!pair || pair.userId)
        throw new HttpError(410, "Conexão expirada ou já autorizada.");
      pair.userId = req.user!.id;
      pair.sessionId = req.sessionId;
      res.json({ ok: true });
    },
  );
  router.post("/auth/poll", async (req, res) => {
    const id = extensionId(req),
      { deviceCode, verifier } = z
        .object({
          deviceCode: z.string().regex(/^[a-f0-9]{16}$/),
          verifier: hex,
        })
        .parse(req.body);
    sweep();
    const p = pairs.get(deviceCode);
    if (!p) throw new HttpError(410, "Conexão expirada.");
    if (p.extensionId !== id || !equal(p.challenge, hash(verifier)))
      throw new HttpError(403, "Prova de conexão inválida.");
    if (!p.userId) {
      res.status(202).json({ pending: true });
      return;
    }
    const user = (
      await db.query(
        "SELECT u.id,u.email,u.name,u.avatar,p.permissions FROM users u JOIN access_profiles p ON p.id=u.access_profile_id JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND s.expires_at>clock_timestamp() AND u.blocked=false",
        [p.userId, p.sessionId],
      )
    ).rows[0];
    if (!user) throw new HttpError(401, "Entre novamente no site.");
    requirePermission(user.permissions);
    // Consume before awaiting INSERT: concurrent polls cannot mint multiple sessions.
    if (!pairs.delete(deviceCode))
      throw new HttpError(410, "Conexão já utilizada.");
    const token = secret(),
      refreshToken = secret();
    await db.query(
      "DELETE FROM extension_sessions WHERE refresh_expires_at<clock_timestamp()",
    );
    await db.query(
      "INSERT INTO extension_sessions(id,user_id,browser_session_id,extension_id,token_hash,refresh_hash,expires_at,refresh_expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '15 minutes',clock_timestamp()+interval '7 days')",
      [
        randomUUID(),
        p.userId,
        p.sessionId,
        id,
        hash(token),
        hash(refreshToken),
      ],
    );
    res.json({ token, refreshToken, expiresAt: Date.now() + 900000, user });
  });
  const account = async (req: Request, refresh = false) => {
    const id = extensionId(req),
      value = refresh
        ? z.object({ refreshToken: hex }).parse(req.body).refreshToken
        : req.get("Authorization")?.replace(/^Bearer /, "");
    if (!value || !/^[a-f0-9]{64}$/.test(value))
      throw new HttpError(401, "Conecte sua conta na extensão.");
    const column = refresh ? "refresh_hash" : "token_hash",
      expiry = refresh ? "refresh_expires_at" : "expires_at";
    const user = (
      await db.query(
        `SELECT e.id AS extension_session_id,u.id,u.email,u.name,u.avatar,p.permissions FROM extension_sessions e JOIN users u ON u.id=e.user_id JOIN access_profiles p ON p.id=u.access_profile_id JOIN sessions s ON s.id=e.browser_session_id WHERE e.${column}=$1 AND e.extension_id=$2 AND e.${expiry}>clock_timestamp() AND s.expires_at>clock_timestamp() AND u.blocked=false`,
        [hash(value), id],
      )
    ).rows[0];
    if (!user)
      throw new HttpError(401, "Sessão expirada ou revogada. Entre novamente.");
    requirePermission(user.permissions);
    return user;
  };
  registerSessionProof(router,db,config,account,transport);
  registerAffiliateProof(router,db,account);
  router.post("/auth/refresh", async (req, res) => {
    const user = await account(req, true),
      token = secret(),
      refreshToken = secret();
    const updated = await db.query(
      "UPDATE extension_sessions SET token_hash=$2,refresh_hash=$3,expires_at=clock_timestamp()+interval '15 minutes' WHERE id=$1 AND refresh_hash=$4 RETURNING id",
      [
        user.extension_session_id,
        hash(token),
        hash(refreshToken),
        hash(req.body.refreshToken),
      ],
    );
    if (!updated.rows.length)
      throw new HttpError(401, "Renovação já utilizada.");
    res.json({ token, refreshToken, expiresAt: Date.now() + 900000, user });
  });
  router.post("/auth/logout", async (req, res) => {
    const user = await account(req);
    await db.query("DELETE FROM extension_sessions WHERE id=$1", [
      user.extension_session_id,
    ]);
    res.json({ ok: true });
  });
  router.get("/session", async (req, res) =>
    res.json({ user: await account(req), mock: true }),
  );

  const queue = (userId: string) => {
    if (!queues.has(userId))
      queues.set(
        userId,
        Array.from({ length: 5 }, (_, i) => ({
          id: `demo-${i + 1}`,
          title: `Produto demonstrativo ${i + 1}`,
          originalUrl: `${base}/api/extension/demo/product/${i + 1}`,
          state: "pending",
        })),
      );
    return queues.get(userId)!;
  };
  router.get("/config", async (req, res) => {
    await account(req);
    res.json({
      version: 1,
      mock: true,
      marketplaces: [
        {
          id: "demo",
          name: "Loja demonstrativa",
          loginUrl: `${base}/api/extension/demo/store`,
          allowedOrigins: [base],
          batchSize: 2,
          intervalMs: 1000,
          steps: [
            {
              type: "extract",
              name: "csrf",
              source: "dom",
              selector: 'meta[name="demo-csrf"]',
              attribute: "content",
            },
            {
              type: "request",
              url: `${base}/api/extension/demo/convert`,
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Demo-CSRF": "{{csrf}}",
              },
              body: { url: "{{originalUrl}}" },
              responsePath: "affiliateUrl",
            },
          ],
          affiliateOrigins: [base],
        },
      ],
    });
  });
  router.get("/queue", async (req, res) => {
    const user = await account(req);
    res.json({
      mock: true,
      items: queue(user.id).map(
        ({ id, title, state, affiliateUrl, error }) => ({
          id,
          title,
          state,
          affiliateUrl,
          error,
        }),
      ),
    });
  });
  router.post("/batches/claim", async (req, res) => {
    const user = await account(req),
      { marketplaceId } = z
        .object({ marketplaceId: z.literal("demo") })
        .parse(req.body),
      items = queue(user.id);
    const leaseId = randomUUID();
    const batch = items
      .filter(
        (i) =>
          i.state === "pending" ||
          (i.state === "leased" && (i.until ?? 0) < Date.now()),
      )
      .slice(0, 2);
    for (const item of batch)
      Object.assign(item, {
        state: "leased",
        lease: leaseId,
        until: Date.now() + 120000,
        owner: user.extension_session_id,
      });
    res.json({
      mock: true,
      marketplaceId,
      leaseId,
      leaseExpiresAt: Date.now() + 120000,
      remaining: items.filter(
        (i) => i.state === "pending" || i.state === "leased",
      ).length,
      items: batch.map(({ id, title, originalUrl }) => ({
        id,
        title,
        originalUrl,
      })),
    });
  });
  router.post("/batches/results", async (req, res) => {
    const user = await account(req),
      body = z
        .object({
          leaseId: z.uuid(),
          results: z
            .array(
              z
                .object({
                  id: z.string().max(80),
                  affiliateUrl: z.url().max(2000).optional(),
                  error: z.string().max(300).optional(),
                })
                .refine((v) => !!v.affiliateUrl !== !!v.error),
            )
            .min(1)
            .max(2)
            .refine((v) => new Set(v.map((i) => i.id)).size === v.length),
        })
        .parse(req.body);
    const assignments = body.results.map((result) => {
      const item = queue(user.id).find((i) => i.id === result.id);
      if (
        !item ||
        item.lease !== body.leaseId ||
        item.owner !== user.extension_session_id ||
        (item.until ?? 0) < Date.now()
      )
        throw new HttpError(
          409,
          "Lote expirado ou pertencente a outra sessão.",
        );
      if (result.affiliateUrl) {
        const u = new URL(result.affiliateUrl);
        if (
          u.origin !== base ||
          u.username ||
          u.password ||
          u.pathname !== new URL(item.originalUrl).pathname ||
          u.searchParams.get("affiliate") !== "demo"
        )
          throw new HttpError(400, "Link demonstrativo inválido.");
      }
      if (
        ["done", "failed"].includes(item.state) &&
        (item.affiliateUrl !== result.affiliateUrl ||
          item.error !== result.error)
      )
        throw new HttpError(409, "Este item já possui outro resultado.");
      return { item, result };
    });
    for (const { item, result } of assignments)
      Object.assign(item, {
        state: result.error ? "failed" : "done",
        ...result,
      });
    res.json({ mock: true, accepted: assignments.length });
  });
  router.post("/queue/reset", async (req, res) => {
    const user = await account(req);
    queues.delete(user.id);
    res.json({ mock: true, items: queue(user.id) });
  });
  router.get("/demo/store", (_req, res) =>
    res
      .type("html")
      .send(
        '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="demo-csrf" content="demonstration-only"><title>Loja demonstrativa</title></head><body><h1>Loja demonstrativa</h1><p>Ambiente local de testes. Nenhuma compra ou comissão real.</p></body></html>',
      ),
  );
  router.get("/demo/product/:id", (_req, res) =>
    res
      .type("html")
      .send(
        '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Produto demonstrativo</title></head><body><h1>Produto demonstrativo</h1><p>Sem oferta real.</p></body></html>',
      ),
  );
  router.post("/demo/convert", (req, res) => {
    if (
      req.get("Origin") !== base ||
      req.get("X-Demo-CSRF") !== "demonstration-only"
    )
      throw new HttpError(
        403,
        "Abra a loja demonstrativa antes de gerar os links.",
      );
    const { url } = z.object({ url: z.url() }).parse(req.body),
      u = new URL(url);
    if (
      u.origin !== base ||
      !/^\/api\/extension\/demo\/product\/\d+$/.test(u.pathname)
    )
      throw new HttpError(400, "URL demonstrativa inválida.");
    u.searchParams.set("affiliate", "demo");
    res.json({ affiliateUrl: u.href });
  });
  app.use("/api/extension", router, (_req, _res, next) =>
    next(new HttpError(404, "Endpoint da extensão não encontrado.")),
  );
}
