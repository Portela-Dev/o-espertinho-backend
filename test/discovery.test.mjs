import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import SwaggerParser from '@apidevtools/swagger-parser';
import {testDatabase,testConfig,client,createApp,identity,seedOffer} from './helpers.mjs';
import {defaultDiscoveryConfig,discoveryConfigSchema} from '../dist/discovery-config.js';
let db,admin,user,app,extractCalls=0;
before(async()=>{({db}=await testDatabase());app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token),extractor:{extract:async()=>{extractCalls++;throw new Error('Must not access marketplaces');}}});admin=client(app);user=client(app);await admin.login('admin');await user.login('alice');});
after(async()=>db.end());
const config=(mode='single')=>{const c=defaultDiscoveryConfig();c.extraction.itemSelector='.product-card';c.pagination.mode=mode;if(['next','load_more'].includes(mode))c.pagination.nextSelector='a.next';if(mode==='url')c.pagination.urlTemplate='https://www.amazon.com.br/s?k=monitor&page={page}';return c;};
const profileBody=(name,mode)=>({name,marketplaceId:'amazon',config:config(mode)});
async function profile(name,mode){const r=await admin.mutate('post','/api/admin/discovery/profiles',profileBody(name,mode));assert.equal(r.status,201,JSON.stringify(r.body));return r.body;}
const sourceBody=(p,name='Monitores')=>({marketplaceId:'amazon',profileId:p.id,name,url:'https://www.amazon.com.br/s?k=monitor&rh=n%3A16364755011#ignored',sourceCategoryPath:['Informática','Monitores'],enabled:true,intervalHours:12,notes:'Página de busca'});

test('discovery saves and retrieves all five pagination modes, selectors, limits and failure settings without running extraction',async()=>{
 const defaults=await admin.get('/api/admin/discovery/defaults');assert.equal(defaults.status,200);assert.equal(defaults.body.executionAvailable,true);assert.deepEqual(defaults.body.config,defaultDiscoveryConfig());
 for(const mode of ['single','next','url','load_more','scroll']){
  const c=config(mode);c.rendering.frameSelector='iframe.catalog';c.pagination.previousSelector='.previous';c.pagination.currentPageSelector='[aria-current=page]';c.pagination.totalPagesSelector='.total';c.pagination.endSelector='.end';
  c.failures.timeout={action:mode==='url'?'skip_page':'stop_section',retries:3,delayMs:1500,backoffMultiplier:2};c.limits.requestIntervalMs=100;
  const r=await admin.mutate('post','/api/admin/discovery/profiles',{name:'Modo '+mode,marketplaceId:'amazon',config:c});assert.equal(r.status,201,JSON.stringify(r.body));assert.deepEqual(r.body.config,c);assert.equal(r.body.version,1);
  const get=await admin.get('/api/admin/discovery/profiles/'+r.body.id);assert.deepEqual(get.body.config,c);
 }
 assert.equal(extractCalls,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM offers')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM sync_runs')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM offer_refresh_runs')).rows[0].n,0);
});

test('sources preserve section query parameters, strip fragments, require same-marketplace profile and do not create products',async()=>{
 const p=await profile('Perfil fontes');const r=await admin.mutate('post','/api/admin/discovery/sources',sourceBody(p));assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.url,'https://www.amazon.com.br/s?k=monitor&rh=n%3A16364755011');assert.deepEqual(r.body.source_category_path,['Informática','Monitores']);assert.equal(r.body.enabled,true);assert.equal(r.body.interval_hours,12);
 const get=await admin.get('/api/admin/discovery/sources/'+r.body.id);assert.equal(get.body.profile_id,p.id);assert.equal(get.headers['cache-control'],'no-store');
 const duplicate=await admin.mutate('post','/api/admin/discovery/sources',sourceBody(p,'Duplicada'));assert.equal(duplicate.status,409);
 const mismatch=await admin.mutate('post','/api/admin/discovery/sources',{...sourceBody(p),marketplaceId:'mercadolivre',url:'https://www.mercadolivre.com.br/ofertas'});assert.equal(mismatch.status,409);
 const nonexistent=await admin.mutate('post','/api/admin/discovery/sources',{...sourceBody(p),profileId:randomUUID(),url:'https://www.amazon.com.br/novos'});assert.equal(nonexistent.status,409);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM products')).rows[0].n,0);
 for(const url of ['http://www.amazon.com.br/s','https://localhost/s','https://www.amazon.com.br.evil.com/s','https://www.amazon.com.br:444/s','https://user:password@www.amazon.com.br/s','javascript:alert(1)','not-a-url'])assert.equal((await admin.mutate('post','/api/admin/discovery/sources',{...sourceBody(p),url})).status,400,url);
});

test('versions prevent lost updates and linked profiles cannot be removed or moved to another marketplace',async()=>{
 const p=await profile('Perfil versão'),body=sourceBody(p,'Fonte versão');body.url='https://www.amazon.com.br/versao';const s=(await admin.mutate('post','/api/admin/discovery/sources',body)).body;
 const input={...profileBody('Perfil atualizado','next'),version:p.version};const updated=await admin.mutate('put','/api/admin/discovery/profiles/'+p.id,input);assert.equal(updated.status,200);assert.equal(updated.body.version,2);assert.equal((await admin.mutate('put','/api/admin/discovery/profiles/'+p.id,input)).status,409);
 assert.equal((await admin.mutate('put','/api/admin/discovery/profiles/'+p.id,{...input,marketplaceId:'mercadolivre',version:2})).status,409);
 assert.equal((await admin.mutate('delete','/api/admin/discovery/profiles/'+p.id,{version:2})).status,409);
 const sourceInput={...body,enabled:false,name:'Seção alterada',version:s.version};const saved=await admin.mutate('put','/api/admin/discovery/sources/'+s.id,sourceInput);assert.equal(saved.status,200);assert.equal(saved.body.version,2);assert.equal(saved.body.enabled,false);
 assert.equal((await admin.mutate('put','/api/admin/discovery/sources/'+s.id,sourceInput)).status,409);assert.equal((await admin.mutate('delete','/api/admin/discovery/sources/'+s.id,{version:1})).status,409);
 assert.equal((await admin.mutate('delete','/api/admin/discovery/sources/'+s.id,{version:2})).status,200);assert.equal((await admin.get('/api/admin/discovery/sources/'+s.id)).status,404);assert.equal((await admin.mutate('delete','/api/admin/discovery/profiles/'+p.id,{version:2})).status,200);
 assert.equal((await admin.mutate('delete','/api/admin/discovery/profiles/'+p.id,{version:2})).status,404);
 const audits=await db.query("SELECT action FROM audit_logs WHERE action LIKE 'discovery.%'");assert.ok(audits.rows.some(r=>r.action==='discovery.profile.updated'));assert.ok(audits.rows.some(r=>r.action==='discovery.sources.deleted'));
});

test('lists are filtered, ordered, paginated and validate limits with a separate profile selector',async()=>{
 const first=await admin.get('/api/admin/discovery/profiles?pageSize=2&page=1&marketplaceId=amazon');const second=await admin.get('/api/admin/discovery/profiles?pageSize=2&page=2&marketplaceId=amazon');assert.equal(first.status,200);assert.equal(first.body.items.length,2);assert.ok(first.body.total>=5);assert.notEqual(first.body.items[0].id,second.body.items[0].id);
 const filtered=await admin.get('/api/admin/discovery/profiles?q=Modo%20scroll&marketplaceId=amazon');assert.equal(filtered.body.total,1);assert.equal(filtered.body.items[0].name,'Modo scroll');assert.equal((await admin.get('/api/admin/discovery/sources?enabled=false')).body.total,0);
 assert.equal((await admin.get('/api/admin/discovery/profiles?q=%25')).body.total,0);assert.equal((await admin.get('/api/admin/discovery/profiles?marketplaceId=mercadolivre')).body.total,0);
 for(const query of ['page=0','pageSize=51','pageSize=1.5','enabled=anything','marketplaceId=bad%27'])assert.equal((await admin.get('/api/admin/discovery/sources?'+query)).status,400);
 const options=await admin.get('/api/admin/discovery/profile-options?marketplaceId=amazon');assert.equal(options.status,200);assert.ok(options.body.length>=5);assert.deepEqual(Object.keys(options.body[0]).sort(),['id','marketplace_id','name']);
});

test('configuration rejects impossible pagination, dangerous templates, unknown executable fields and invalid failure policies',async()=>{
 const cases=[c=>c.extraction.itemSelector='',c=>{c.pagination.mode='next';c.pagination.nextSelector='';},c=>{c.pagination.mode='url';c.pagination.urlTemplate='https://www.amazon.com.br/s';},c=>c.limits.requestIntervalMs=99,c=>c.limits.maxPages=1001,c=>c.limits.deduplicate=false,c=>c.failures.blocked.retries=6,c=>c.failures.timeout.action='skip_item',c=>c.failures.navigation.action='skip_page',c=>c.rendering.script='fetch("/secret")',c=>c.extraction.linkAttribute='onclick()',c=>c.pagination.pageStep=0,c=>c.extraction.itemSelector='a'.repeat(601)];
 for(const change of cases){const c=config();change(c);const r=await admin.mutate('post','/api/admin/discovery/profiles',{...profileBody('Inválido'),config:c});assert.equal(r.status,400,JSON.stringify(c));}
 for(const template of ['http://www.amazon.com.br/s?page={page}','https://evil.example.com/{page}','https://www.amazon.com.br/s?page={page}&secret={cookie}']){const c=config('url');c.pagination.urlTemplate=template;assert.equal((await admin.mutate('post','/api/admin/discovery/profiles',{...profileBody('Template inválido'),config:c})).status,400);}
 assert.equal((await admin.mutate('post','/api/admin/discovery/profiles',{...profileBody('Extra'),headers:{Cookie:'secret'}})).status,400);
 assert.equal((await admin.mutate('post','/api/admin/discovery/profiles',profileBody('Modo single'))).status,409);
 assert.equal(discoveryConfigSchema.safeParse(config('scroll')).success,true);
});

test('permission, XSRF and recent Google verification protect configuration endpoints',async()=>{
 const anon=client(app);await anon.init();assert.equal((await anon.get('/api/admin/discovery/profiles')).status,401);assert.equal((await user.get('/api/admin/discovery/profiles')).status,403);
 assert.equal((await admin.agent.post('/api/admin/discovery/profiles').set('Origin','http://localhost:4200').send(profileBody('Sem XSRF'))).status,403);
 const profileId=randomUUID();await db.query('INSERT INTO access_profiles(id,name,permissions) VALUES($1,$2,$3)',[profileId,'Operador descoberta',['discovery']]);await db.query("UPDATE users SET access_profile_id=$1 WHERE email='alice@gmail.com'",[profileId]);
 assert.equal((await user.get('/api/admin/discovery/profiles')).status,200);assert.equal((await user.get('/api/admin/catalog-marketplaces')).status,200);assert.equal((await user.get('/api/admin/selectors/amazon')).status,403);
 const result=await user.mutate('post','/api/admin/discovery/profiles',profileBody('Operador autorizado'));assert.equal(result.status,201);
 await db.query("UPDATE sessions SET admin_verified_at=clock_timestamp()-interval '16 minutes' WHERE user_id=(SELECT id FROM users WHERE email='alice@gmail.com')");
 const expired=await user.mutate('post','/api/admin/discovery/profiles',profileBody('Reautenticação'));assert.equal(expired.status,403);assert.equal(expired.body.code,'ADMIN_REAUTH_REQUIRED');
 const access=await admin.get('/api/admin/access-profiles');assert.ok(access.body.permissions.some(p=>p.id==='discovery'));assert.ok((await db.query("SELECT permissions FROM access_profiles WHERE id='admin'")).rows[0].permissions.includes('discovery'));
});

test('OpenAPI documents configuration bodies, versions, pagination and no-execution contract',async()=>{
 const spec=(await admin.get('/api/openapi.json')).body;await SwaggerParser.validate(structuredClone(spec));
 for(const kind of ['profiles','sources']){for(const method of ['get','post'])assert.ok(spec.paths['/admin/discovery/'+kind][method]);for(const method of ['get','put','delete'])assert.ok(spec.paths['/admin/discovery/'+kind+'/{id}'][method]);assert.ok(spec.paths['/admin/discovery/'+kind+'/{id}'].put.requestBody.content['application/json'].schema.required.includes('version'));}
 assert.match(spec.paths['/admin/discovery/defaults'].get.description,/não inicia nenhum job/i);
});

test('migration preserves existing offers/products/categories and only adds a permission and empty configuration tables',async()=>{
 const legacy=await testDatabase({through:'021\uffff'});try{const id=await seedOffer(legacy.db);const before=(await legacy.db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];await legacy.pg.exec(await readFile(new URL('../migrations/022_discovery_configuration.sql',import.meta.url),'utf8'));assert.deepEqual((await legacy.db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0],before);assert.equal((await legacy.db.query('SELECT count(*)::int AS n FROM discovery_sources')).rows[0].n,0);assert.equal((await legacy.db.query('SELECT count(*)::int AS n FROM discovery_profiles')).rows[0].n,0);}finally{await legacy.db.end();}
});


test('discovery contract excludes product details and rejects retired fields on create and update',async()=>{
 const p=await profile('Links only');
 const keys=['itemSelector','linkSelector','linkAttribute'];
 assert.deepEqual(Object.keys(p.config.extraction).sort(),keys.sort());
 const defaults=(await admin.get('/api/admin/discovery/defaults')).body.config;
 assert.deepEqual(Object.keys(defaults.extraction).sort(),keys);
 for(const key of ['titleSelector','priceSelector','imageSelector','imageAttribute','brandSelector','descriptionSelector','categorySelector','categoryScope','categorySeparator']){
  const c=config();c.extraction[key]='legacy';
  assert.equal((await admin.mutate('post','/api/admin/discovery/profiles',{...profileBody('Retired '+key),config:c})).status,400);
  assert.equal((await admin.mutate('put','/api/admin/discovery/profiles/'+p.id,{...profileBody('Links only'),config:c,version:p.version})).status,400);
 }
 const spec=(await admin.get('/api/openapi.json')).body;
 const extraction=spec.paths['/admin/discovery/profiles'].post.requestBody.content['application/json'].schema.properties.config.properties.extraction;
 assert.deepEqual(Object.keys(extraction.properties).sort(),keys);
});

test('links-only migration removes obsolete selectors while preserving source bindings and catalog data',async()=>{
 const legacy=await testDatabase({through:'022\uffff'});
 try{
  const offerId=await seedOffer(legacy.db),profileId=randomUUID(),sourceId=randomUUID(),untouchedId=randomUUID();
  const beforeOffer=(await legacy.db.query('SELECT * FROM offers WHERE id=$1',[offerId])).rows[0];
  const oldConfig=config('scroll');Object.assign(oldConfig.extraction,{titleSelector:'h2',priceSelector:'.price',imageSelector:'img',imageAttribute:'src',brandSelector:'.brand',descriptionSelector:'.summary',categorySelector:'.breadcrumb li',categoryScope:'page',categorySeparator:'>'});
  await legacy.db.query('INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,$2,$3,$4)',[profileId,'amazon','Legacy profile',JSON.stringify(oldConfig)]);
  await legacy.db.query('INSERT INTO discovery_profiles(id,marketplace_id,name,config) VALUES($1,$2,$3,$4)',[untouchedId,'amazon','Clean profile',JSON.stringify(config())]);
  await legacy.db.query('INSERT INTO discovery_sources(id,marketplace_id,profile_id,name,url,source_category_path) VALUES($1,$2,$3,$4,$5,$6)',[sourceId,'amazon',profileId,'Source','https://www.amazon.com.br/s?k=teste',['Origem']]);
  const sourceBefore=(await legacy.db.query('SELECT * FROM discovery_sources WHERE id=$1',[sourceId])).rows[0];
  const sql=await readFile(new URL('../migrations/023_discovery_links_only.sql',import.meta.url),'utf8');await legacy.pg.exec(sql);
  const migrated=(await legacy.db.query('SELECT * FROM discovery_profiles WHERE id=$1',[profileId])).rows[0];
  assert.deepEqual(migrated.config,config('scroll'));assert.equal(migrated.version,2);assert.equal(discoveryConfigSchema.safeParse(migrated.config).success,true);
  assert.deepEqual((await legacy.db.query('SELECT * FROM discovery_sources WHERE id=$1',[sourceId])).rows[0],sourceBefore);
  assert.deepEqual((await legacy.db.query('SELECT * FROM offers WHERE id=$1',[offerId])).rows[0],beforeOffer);
  assert.equal((await legacy.db.query('SELECT version FROM discovery_profiles WHERE id=$1',[untouchedId])).rows[0].version,1);
  await legacy.pg.exec(sql);assert.equal((await legacy.db.query('SELECT version FROM discovery_profiles WHERE id=$1',[profileId])).rows[0].version,2);
 }finally{await legacy.db.end();}
});
