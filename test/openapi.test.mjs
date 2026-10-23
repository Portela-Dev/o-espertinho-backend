import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import {testDatabase,testConfig,identity,client,createApp} from './helpers.mjs';
let db,app,admin,spec;
before(async()=>{({db}=await testDatabase());app=createApp(db,testConfig(),{verifyGoogle:async t=>identity(t)});admin=client(app);await admin.login('admin');spec=(await admin.get('/api/openapi.json')).body;});
after(async()=>db.end());

test('OpenAPI é válido e descreve todas as rotas existentes',async()=>{
 await SwaggerParser.validate(structuredClone(spec));assert.equal(spec.openapi,'3.0.3');assert.equal(spec.servers[0].url,'/api');
 const ids=new Set();for(const path of Object.values(spec.paths))for(const op of Object.values(path)){assert.ok(!ids.has(op.operationId),'operationId duplicado');ids.add(op.operationId);}
 for(const file of ['sharing.ts','app.ts','products.ts','scraping-admin.ts','price-history.ts','user-admin.ts','catalog-settings.ts','catalog-admin.ts','catalog-manual.ts','catalog-publication.ts']){
  const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');
  for(const match of source.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)){
   const path=match[2].replace(/^\/api/,'').replace(/:([A-Za-z]+)/g,'{$1}');assert.ok(spec.paths[path]?.[match[1]],'Rota sem documentação: '+match[1]+' '+path);
  }
 }
 for(const path of ['/admin/amazon/import','/admin/mercadolivre/import'])assert.equal(spec.paths[path],undefined,'Importação específica removida');
 for(const path of ['/admin/mercadolivre/callback','/admin/mercadolivre/oauth/complete'])assert.equal(spec.paths[path],undefined);
 assert.equal(spec.paths['/admin/link-imports/preview'].post.requestBody.content['application/json'].schema.required.includes('productId'),true);
});

test('Swagger serve HTML, assets e interceptor com CSP do Helmet preservada',async()=>{
 const html=await admin.get('/api/docs/');assert.equal(html.status,200);assert.match(html.text,/O Espertinho/);assert.match(html.headers['content-security-policy'],/script-src 'self'/);assert.ok(!html.headers['content-security-policy'].includes("script-src 'self' 'unsafe-inline'"));
 assert.match(html.text,/swagger-ui-init.js/);assert.match(html.text,/\/api\/docs\/xsrf.js/);
 for(const file of ['swagger-ui.css','swagger-ui-bundle.js','swagger-ui-init.js','xsrf.js']){const response=await admin.get('/api/docs/'+file);assert.equal(response.status,200,file);}
 const interceptor=await admin.get('/api/docs/xsrf.js');assert.match(interceptor.text,/X-XSRF-TOKEN/);assert.match(interceptor.text,/window.location.origin!==origin/);assert.match(interceptor.text,/\/api\/auth\/session/);
 assert.equal(html.headers['cache-control'],'no-store');
});

test('documentação descreve permissões, versões e rotas legadas sem expor configuração privada',async()=>{
 assert.deepEqual(spec.paths['/products/{id}'].get.security,[]);
 assert.ok(spec.paths['/admin/products'].post.security[0].SessionCookie);assert.ok(spec.paths['/admin/products'].post.security[0].XSRFToken);
 assert.match(spec.paths['/admin/products'].post.description,/admin/);
 assert.equal(spec.components.schemas.ProductUpdate.allOf[1].required[0],'expectedUpdatedAt');
 assert.equal(spec.paths['/admin/rules'],undefined);
 const text=JSON.stringify(spec);for(const forbidden of ['ENCRYPTION_KEY','DATABASE_URL','credentials_encrypted','cookie_encrypted'])assert.ok(!text.includes(forbidden));

});

test('Swagger não altera exigências de login, origem ou token XSRF das operações reais',async()=>{
 const visitor=client(app);await visitor.init();assert.equal((await visitor.get('/api/openapi.json')).status,200);assert.equal((await visitor.get('/api/admin/products')).status,401);
 const body={name:'Produto pela API',category:'Tecnologia'};
 assert.equal((await admin.agent.post('/api/admin/products').send(body)).status,403);
 assert.equal((await admin.agent.post('/api/admin/products').set('Origin','http://localhost:3000').set('X-XSRF-TOKEN',admin.csrf).send(body)).status,403);
 assert.equal((await admin.mutate('post','/api/admin/products',body)).status,201);
});
