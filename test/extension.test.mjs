import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import {
  testDatabase,
  testConfig,
  client,
  createApp,
  identity,
} from "./helpers.mjs";
const extensionId = "a".repeat(32),
  base = "http://localhost:3000";
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t, options = {}) {
  const { db } = await testDatabase();
  t.after(() => db.end());
  const app = createApp(db, {...testConfig(),...options.config}, {
    sessionProofTransport: options.transport,
    verifyGoogle: async (token) => identity(token),
  });
  const browser = client(app);
  await browser.login("admin");
  const post = (path, body, token) =>
    request(app)
      .post("/api/extension" + path)
      .set("Origin", "chrome-extension://" + extensionId)
      .set("X-Espertinho-Extension-Id", extensionId)
      .set("Authorization", token ? "Bearer " + token : "")
      .send(body);
  const get = (path, token) =>
    request(app)
      .get("/api/extension" + path)
      .set("X-Espertinho-Extension-Id", extensionId)
      .set("Authorization", token ? "Bearer " + token : "");
  const start = async () => {
    const verifier = randomBytes(32).toString("hex");
    const r = await post("/auth/start", { challenge: digest(verifier) });
    assert.equal(r.status, 200);
    return { ...r.body, verifier };
  };
  const approve = (pair, person = browser) =>
    person.agent
      .post("/api/extension/auth/approve")
      .set("Origin", base)
      .set("X-XSRF-TOKEN", person.csrf)
      .send({ code: pair.deviceCode });
  const login = async () => {
    const pair = await start();
    assert.equal((await approve(pair)).status, 200);
    const r = await post("/auth/poll", {
      deviceCode: pair.deviceCode,
      verifier: pair.verifier,
    });
    assert.equal(r.status, 200);
    return r.body;
  };
  return { db, app, browser, post, get, start, approve, login };
}
test("pareamento exige sessão real, XSRF, permissão e prova de posse de uso único", async (t) => {
  const { app, browser, post, get, start, approve } = await fixture(t);
  const pair = await start();
  assert.equal((await get("/catalog/config")).status, 401);
  assert.equal(
    (
      await request(app)
        .post("/api/extension/auth/approve")
        .set("Origin", base)
        .send({ code: pair.deviceCode })
    ).status,
    403,
  );
  const alice = client(app);
  await alice.login("alice");
  assert.equal((await approve(pair, alice)).status, 403);
  assert.equal(
    (
      await post("/auth/poll", {
        deviceCode: pair.deviceCode,
        verifier: pair.verifier,
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await post("/auth/poll", {
        deviceCode: pair.deviceCode,
        verifier: "0".repeat(64),
      })
    ).status,
    403,
  );
  assert.equal((await approve(pair, browser)).status, 200);
  const results = await Promise.all([
    post("/auth/poll", {
      deviceCode: pair.deviceCode,
      verifier: pair.verifier,
    }),
    post("/auth/poll", {
      deviceCode: pair.deviceCode,
      verifier: pair.verifier,
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 410]);
  const token = results.find((r) => r.status === 200).body.token;
  assert.equal(
    (await get("/session", token)).body.user.permissions.includes(
      "affiliate_links",
    ),
    true,
  );
  assert.equal(
    (
      await request(app)
        .get("/api/extension/session")
        .set("X-Espertinho-Extension-Id", "b".repeat(32))
        .set("Authorization", "Bearer " + token)
    ).status,
    401,
  );
});
test("perfil delegado pode conectar; remoção da permissão revoga o acesso imediatamente", async (t) => {
  const { app, db, browser, start, approve, post, get } = await fixture(t);
  const alice = client(app);
  const logged = await alice.login("alice");
  const profile = await browser.mutate("post", "/api/admin/access-profiles", {
    name: "Operador de links",
    permissions: ["affiliate_links"],
  });
  assert.equal(profile.status, 201);
  await db.query("UPDATE users SET access_profile_id=$2 WHERE id=$1", [
    logged.body.user.id,
    profile.body.id,
  ]);
  const pair = await start();
  assert.equal((await approve(pair, alice)).status, 200);
  const session = await post("/auth/poll", {
    deviceCode: pair.deviceCode,
    verifier: pair.verifier,
  });
  assert.equal((await get("/catalog/config", session.body.token)).status, 200);
  await db.query("UPDATE access_profiles SET permissions='{}' WHERE id=$1", [
    profile.body.id,
  ]);
  assert.equal((await get("/catalog/config", session.body.token)).status, 403);
  assert.equal(
    (await post("/auth/refresh", { refreshToken: session.body.refreshToken }))
      .status,
    403,
  );
});
test("renovação gira o token; logout e saída do site invalidam a extensão", async (t) => {
  const { browser, post, get, login } = await fixture(t),
    old = await login();
  const renewed = await post("/auth/refresh", {
    refreshToken: old.refreshToken,
  });
  assert.equal(renewed.status, 200);
  assert.equal(
    (await post("/auth/refresh", { refreshToken: old.refreshToken })).status,
    401,
  );
  assert.equal((await get("/session", old.token)).status, 401);
  assert.equal((await get("/session", renewed.body.token)).status, 200);
  assert.equal(
    (await post("/auth/logout", {}, renewed.body.token)).status,
    200,
  );
  assert.equal((await get("/session", renewed.body.token)).status, 401);
  const auth = await login();
  await browser.mutate("post", "/api/auth/logout");
  assert.equal((await get("/session", auth.token)).status, 401);
});

test('rotas de prova e demonstração não existem; autenticação está disponível sem mocks',async t=>{const f=await fixture(t);const auth=await f.login();for(const path of ['/config','/queue','/session-proof/marketplaces','/affiliate-proof/config'])assert.equal((await f.get(path,auth.token)).status,404);});

for (const appOrigin of ['http://localhost:4200', 'https://oespertinho.com.br']) {
  test('autorização usa a marca do frontend sem cópias antigas: ' + appOrigin, async (t) => {
    const {db} = await testDatabase();
    t.after(() => db.end());
    const app = createApp(db, {...testConfig(), APP_ORIGIN: appOrigin});
    const start = await request(app).post('/api/extension/auth/start')
      .set('X-Espertinho-Extension-Id', extensionId)
      .set('Origin', 'chrome-extension://' + extensionId)
      .send({challenge: digest('brand-test')});
    assert.equal(start.status, 200);
    const page = await request(app).get('/api/extension/auth/connect?code=' + start.body.deviceCode);
    assert.equal(page.status, 200);
    for (const file of ['espertinho-icon-caramelo-v9-32.png', 'espertinho-icon-caramelo-v9-180.png', 'espertinho-mascote-caramelo-v9-384.png']) {
      assert.ok(page.text.includes(appOrigin + '/brand/' + file));
    }
    assert.equal(page.text.includes('/auth/assets/icon.png'), false);
    assert.equal(page.text.includes('/auth/assets/mascot.png'), false);
    assert.ok(page.text.includes('Só é esperto que compara antes de comprar'));
    const policy = page.headers['content-security-policy'];
    assert.equal(policy.split(';').find(directive => directive.startsWith('img-src ')), "img-src 'self' data: " + appOrigin);
    assert.ok(policy.includes("script-src 'self'"));
    assert.equal(page.headers['cache-control'], 'no-store');
    for (const file of ['icon.png', 'mascot.png']) {
      assert.equal((await request(app).get('/api/extension/auth/assets/' + file)).status, 404);
    }
    const styles = await request(app).get('/api/extension/auth/assets/connect.css');
    assert.equal(styles.status, 200);
    assert.match(styles.text, /align-items:center;gap:8px/);
    assert.equal((await request(app).get('/api/extension/auth/connect?code=' + '0'.repeat(16))).status, 410);
    assert.equal((await request(app).get('/api/extension/auth/connect')).status, 400);
  });
}
