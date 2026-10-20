import request from 'supertest';
import { randomBytes, createHash } from 'node:crypto';
import { testDatabase, testConfig, client, createApp, identity } from './helpers.mjs';
export async function catalogFixture(t) {
  const { db } = await testDatabase();t.after(()=>db.end());
  const app = createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)});
  const browser=client(app);await browser.login('admin');
  const extensionId='a'.repeat(32), verifier=randomBytes(32).toString('hex');
  const call=(method,path,body,token)=>request(app)[method]('/api/extension'+path)
    .set('Origin','chrome-extension://'+extensionId).set('X-Espertinho-Extension-Id',extensionId)
    .set('Authorization',token?'Bearer '+token:'').send(body);
  const pair=await call('post','/auth/start',{challenge:createHash('sha256').update(verifier).digest('hex')});
  // client helper uses the application origin; the extension approval endpoint has its own origin.
  await browser.agent.post('/api/extension/auth/approve').set('Origin','http://localhost:3000').set('X-XSRF-TOKEN',browser.csrf).send({code:pair.body.deviceCode});
  const auth=await call('post','/auth/poll',{deviceCode:pair.body.deviceCode,verifier});
  if(auth.status!==200)throw new Error(JSON.stringify(auth.body));
  return {db,app,browser,auth:auth.body,call:(method,path,body)=>call(method,path,body,auth.body.token)};
}
