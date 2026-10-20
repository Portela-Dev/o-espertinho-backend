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
  assert.equal((await get("/config")).status, 401);
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
  assert.equal((await get("/config", session.body.token)).status, 200);
  await db.query("UPDATE access_profiles SET permissions='{}' WHERE id=$1", [
    profile.body.id,
  ]);
  assert.equal((await get("/config", session.body.token)).status, 403);
  assert.equal(
    (await post("/auth/refresh", { refreshToken: session.body.refreshToken }))
      .status,
    403,
  );
});
test("lotes são reservados, resultados idempotentes e nenhum produto real é criado", async (t) => {
  const { db, post, get, login } = await fixture(t),
    auth = await login(),
    config = await get("/config", auth.token);
  assert.equal(config.body.mock, true);
  const a = await post("/batches/claim", { marketplaceId: "demo" }, auth.token),
    b = await post("/batches/claim", { marketplaceId: "demo" }, auth.token);
  assert.equal(a.body.items.length, 2);
  assert.ok(!b.body.items.some((i) => a.body.items.some((j) => j.id === i.id)));
  const results = a.body.items.map((item) => ({
    id: item.id,
    affiliateUrl: item.originalUrl + "?affiliate=demo",
  }));
  assert.equal(
    (
      await post(
        "/batches/results",
        { leaseId: b.body.leaseId, results },
        auth.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await post(
        "/batches/results",
        {
          leaseId: a.body.leaseId,
          results: [{ ...results[0], affiliateUrl: "https://evil.test/" }],
        },
        auth.token,
      )
    ).status,
    400,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await post(
          "/batches/results",
          { leaseId: a.body.leaseId, results },
          auth.token,
        )
      ).status,
      200,
    );
  assert.equal(
    (await get("/queue", auth.token)).body.items.filter(
      (i) => i.state === "done",
    ).length,
    2,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM products")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM offers")).rows[0].n,
    0,
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
test("mocks ficam desativados em produção e podem ser desligados em desenvolvimento", async (t) => {
  const { db } = await fixture(t);
  for (const config of [
    { ...testConfig(), NODE_ENV: "production" },
    { ...testConfig(), EXTENSION_MOCK_ENABLED: "false" },
  ]) {
    const app = createApp(db, config);
    assert.equal((await request(app).get("/api/extension/config")).status, 404);
  }
});


test('session proof uses real extension auth, scoped domains, ephemeral private results and no cookie echo',async t=>{
 let resolve,submitted,automatic=false;
 const result=()=>({requestId:crypto.randomUUID(),status:'available',title:'Generic product',priceCents:12300,missing:[],finalUrl:'https://shop.example.com/failed',navigationStatuses:[200],cookiesImported:1,storageOriginsImported:0});
 const f=await fixture(t,{config:{MANUAL_EXTRACTOR_URL:'http://127.0.0.1:3011',MANUAL_EXTRACTION_SERVICE_TOKEN:'a'.repeat(40)},transport:async(url,options)=>{submitted=JSON.parse(options.body);if(automatic)return Response.json(result());return new Promise(done=>{resolve=done;});}});
 const auth=await f.login();
 await f.db.query("UPDATE marketplaces SET website_url='https://shop.example.com',allowed_hosts=ARRAY['shop.example.com','example.com'],scraping_enabled=true WHERE id='amazon'");
 await f.db.query("INSERT INTO scraping_profiles(marketplace_id,rules,wait_timeout_ms,validity_minutes) VALUES('amazon',$1,15000,360) ON CONFLICT(marketplace_id) DO UPDATE SET rules=$1",[JSON.stringify([{field:'title',selectors:['h1'],mode:'text',required:true},{field:'price',selectors:['.price'],mode:'text',required:true}])]);
 const base='/session-proof',cookie={name:'session',value:'PRIVATE-COOKIE',domain:'.example.com',path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'};
 const body={marketplaceId:'amazon',url:'https://shop.example.com/product?tracking=remove#fragment',consent:true,session:{cookies:[cookie],origins:[]}};
 assert.equal((await f.get(base+'/marketplaces')).status,401);
 const markets=await f.get(base+'/marketplaces',auth.token);assert.equal(markets.status,200);assert.ok(markets.body.marketplaces.some(m=>m.id==='amazon'&&m.cookieDomains.includes('example.com')));
 for(const bad of [{...body,consent:false},{...body,url:'https://foreign.example/product'},{...body,session:{cookies:[{...cookie,domain:'.com'}],origins:[]}},{...body,session:{cookies:[cookie],origins:[{origin:'https://foreign.example',localStorage:[]}]}}])assert.equal((await f.post(base+'/tests',bad,auth.token)).status,400);
 const created=await f.post(base+'/tests',body,auth.token);assert.equal(created.status,202,JSON.stringify(created.body));assert.equal(submitted.url,'https://shop.example.com/product');assert.equal(submitted.session.cookies[0].value,'PRIVATE-COOKIE');assert.equal(submitted.profile.allowedHosts.includes('example.com'),true);
 assert.equal((await f.post(base+'/tests',body,auth.token)).status,429);
 const second=await f.login();assert.equal((await f.get(base+'/tests/'+created.body.id,second.token)).status,404);
 resolve(Response.json({requestId:crypto.randomUUID(),status:'technical_failure',reason:'incomplete',title:null,priceCents:null,missing:['title','price'],finalUrl:'https://shop.example.com/login',navigationStatuses:[302,200],cookiesImported:1,storageOriginsImported:0,cookies:'PRIVATE-COOKIE'}));
 let response;for(let i=0;i<20;i++){response=await f.get(base+'/tests/'+created.body.id,auth.token);if(response.body.status==='completed')break;await new Promise(ok=>setTimeout(ok,5));}
 assert.equal(response.body.status,'completed');assert.equal(response.body.result.finalUrl,'https://shop.example.com/login');assert.equal(JSON.stringify([created.body,response.body]).includes('PRIVATE-COOKIE'),false);
 const logs=(await f.db.query('SELECT action,entity_id FROM audit_logs')).rows;assert.equal(JSON.stringify(logs).includes('PRIVATE-COOKIE'),false);
 automatic=true;
 const batchBody={marketplaceId:'amazon',batchFailed:true,consent:true,session:body.session};
 assert.equal((await f.post(base+'/tests',batchBody,auth.token)).status,400);
 const failedId=crypto.randomUUID();
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,extraction_status) VALUES($1,'amazon','https://shop.example.com/failed','failed'),($2,'amazon','https://shop.example.com/completed','completed')",[failedId,crypto.randomUUID()]);
 await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,extraction_status,status) VALUES($1,'amazon','https://shop.example.com/archived','failed','archived')",[crypto.randomUUID()]);
 const batch=await f.post(base+'/tests',batchBody,auth.token);assert.equal(batch.status,202);assert.equal(batch.body.batch,undefined);
 for(let i=0;i<20;i++){response=await f.get(base+'/tests/'+batch.body.id,auth.token);if(response.body.status==='completed')break;await new Promise(ok=>setTimeout(ok,5));}
 assert.equal(response.body.batch.total,1);assert.equal(response.body.batch.completed,1);assert.equal(response.body.batch.intervalMs,20000);assert.equal(response.body.batch.items[0].discoveryLinkId,failedId);assert.equal(submitted.url,'https://shop.example.com/failed');assert.equal(JSON.stringify(response.body).includes('PRIVATE-COOKIE'),false);
 assert.equal((await f.get(base+'/tests/'+batch.body.id,second.token)).status,404);
 assert.equal((await f.db.query('SELECT extraction_status FROM discovery_links WHERE id=$1',[failedId])).rows[0].extraction_status,'failed');
 await f.db.query("INSERT INTO access_profiles(id,name,permissions) VALUES('proof-editor','Proof editor',ARRAY['affiliate_links'])");await f.db.query("UPDATE users SET role='user',access_profile_id='proof-editor' WHERE id=$1",[auth.user.id]);assert.equal((await f.get(base+'/marketplaces',auth.token)).status,403);
});

test('session proof batch is sequential, spaces every attempt and preserves technical failures per link',async()=>{
 const {runProofBatch}=await import('../dist/extension-session-proof.js');
 const targets=Array.from({length:5},(_,i)=>({url:'https://shop.example.com/'+i}));
 const batch={total:5,completed:0,intervalMs:20000,items:[]},events=[];let active=0;
 await runProofBatch(batch,targets,async target=>{assert.equal(++active,1);events.push(target.url);await Promise.resolve();active--;if(target===targets[1])throw new Error('PRIVATE-CREDENTIAL');return {status:'available',priceCents:100};},async ms=>{assert.equal(ms,20000);assert.equal(active,0);events.push('wait');});
 assert.equal(batch.completed,5);assert.equal(batch.items.length,5);assert.equal(events.filter(e=>e==='wait').length,4);assert.equal(events[0],targets[0].url);assert.ok(batch.items[1].error);assert.equal(batch.items[2].result.status,'available');assert.equal(JSON.stringify(batch).includes('PRIVATE-CREDENTIAL'),false);
});
