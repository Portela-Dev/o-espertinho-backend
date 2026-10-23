import { fileURLToPath } from "node:url";
import { extensionConnectPage } from "./extension-connect-page.js";
import express, { type Express, type Request } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";


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
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function registerExtension(
  app: Express,
  db: Database,
  config: Config,
  register?: (router: express.Router, account: (req: Request) => Promise<any>) => void,
) {
  const router = express.Router(),
    base = new URL(config.EXTENSION_BACKEND_URL ?? "http://localhost:3000")
      .origin;
  const pairs = new Map<string, Pair>();

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
      limit: 240,
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
  router.use("/auth/assets", express.static(fileURLToPath(new URL("./extension-connect-assets/", import.meta.url)), { index: false, redirect: false, dotfiles: "deny" }));
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
        extensionConnectPage(escape(config.APP_ORIGIN)),
      );
  });
  router.get("/auth/connect.js", (_req, res) =>
    res.type("application/javascript").send(`
let csrf='';function show(message,state='info'){status.textContent=message;status.dataset.state=state;}const status=document.querySelector('#status'),button=document.querySelector('#approve');
async function check(){button.disabled=true;try{const r=await fetch('/api/auth/session',{cache:'no-store'});if(!r.ok)throw Error('Falha ao consultar sessão.');const {user}=await r.json();csrf=decodeURIComponent(document.cookie.split('; ').find(v=>v.startsWith('XSRF-TOKEN='))?.slice(11)||'');if(!user){show('Entre com Google no site e depois clique em Verificar login novamente.');return;}if(!user.permissions?.includes('affiliate_links')){show('Seu perfil não tem permissão para gerar links de afiliados.','error');return;}show('Conectar como '+user.email,'ready');button.disabled=false;}catch(e){show(e.message,'error');}}
document.querySelector('#reload').addEventListener('click',check);button.addEventListener('click',async()=>{button.disabled=true;show('Autorizando extensão…');try{const r=await fetch('/api/extension/auth/approve',{method:'POST',headers:{'Content-Type':'application/json','X-XSRF-TOKEN':csrf},body:JSON.stringify({code:new URL(location.href).searchParams.get('code')})});const body=await r.json();if(!r.ok)throw Error(body.error||'Não foi possível autorizar.');show('Extensão autorizada. Você pode fechar esta aba e voltar à extensão.','success');button.textContent='Extensão conectada';document.querySelector('#reload').hidden=true;document.querySelector('#site-login').hidden=true;}catch(e){show(e.message,'error');button.disabled=false;}});check();`),
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
        `SELECT e.id AS extension_session_id,e.extension_id,u.id,u.email,u.name,u.avatar,p.permissions FROM extension_sessions e JOIN users u ON u.id=e.user_id JOIN access_profiles p ON p.id=u.access_profile_id JOIN sessions s ON s.id=e.browser_session_id WHERE e.${column}=$1 AND e.extension_id=$2 AND e.${expiry}>clock_timestamp() AND s.expires_at>clock_timestamp() AND u.blocked=false`,
        [hash(value), id],
      )
    ).rows[0];
    if (!user)
      throw new HttpError(401, "Sessão expirada ou revogada. Entre novamente.");
    requirePermission(user.permissions);
    return user;
  };
  register?.(router, account);
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
    res.json({ user: await account(req), mock: false }),
  );

  app.use("/api/extension", router);
}
