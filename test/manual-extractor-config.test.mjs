import{test}from'node:test';
import assert from'node:assert/strict';
import{mkdtemp,mkdir,readFile,writeFile,copyFile,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join,resolve,sep}from'node:path';
import{spawnSync}from'node:child_process';
import{parseEnv}from'node:util';
import{loadConfig}from'../dist/config.js';
const token='test-only-manual-token-at-least-32-characters';
test('manual endpoint settings are independent and invalid URLs or dummy credentials fail closed',()=>{
 const values={NODE_ENV:'test',APP_ORIGIN:'http://localhost:4200',DATABASE_URL:'test',ENCRYPTION_KEY:Buffer.alloc(32).toString('base64'),EXTENSION_BACKEND_URL:'http://localhost:3000',SCRAPER_SERVICE_URL:'',MANUAL_EXTRACTOR_URL:'',MANUAL_EXTRACTION_SERVICE_TOKEN:''};
 const saved=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
 try{
  Object.assign(process.env,values);assert.equal(loadConfig().MANUAL_EXTRACTOR_URL,'');
  process.env.MANUAL_EXTRACTOR_URL='http://127.0.0.1:3011';process.env.MANUAL_EXTRACTION_SERVICE_TOKEN=token;assert.equal(loadConfig().MANUAL_EXTRACTION_SERVICE_TOKEN,token);
  for(const origin of ['file:///tmp/','http://user:pass@localhost:3011/','http://localhost:3011/path','http://localhost:3011/?x=1','http://localhost:3011/#hash']){process.env.MANUAL_EXTRACTOR_URL=origin;assert.throws(()=>loadConfig());}
  process.env.MANUAL_EXTRACTOR_URL='http://127.0.0.1:3011';
  for(const secret of ['short','DUMMY_REPLACE_WITH_A_REAL_SERVICE_TOKEN','not-valid-secret-'.repeat(20)]){process.env.MANUAL_EXTRACTION_SERVICE_TOKEN=secret;assert.throws(()=>loadConfig(),error=>!error.message.includes(secret));}
 }finally{for(const[key,value]of Object.entries(saved)){if(value===undefined){delete process.env[key];}else{process.env[key]=value;}}}
});
test('local setup copies only the manual secret, preserves job settings and refuses conflicting existing values',async()=>{
 const root=await mkdtemp(join(tmpdir(),'espertinho-manual-config-'));
 try{
  const backend=join(root,'backend'),extractor=join(root,'o-espertinho-extractor');await mkdir(join(backend,'scripts'),{recursive:true});await mkdir(extractor);
  const script=join(backend,'scripts','setup-manual-extractor.mjs');await copyFile('scripts/setup-manual-extractor.mjs',script);
  const target=join(backend,'.env'),source=join(extractor,'.env');const original='EXTRACTION_SERVICE_TOKEN=legacy-token-preserved\nSCRAPER_SERVICE_URL=http://127.0.0.1:3010\nOTHER_SETTING=preserved\n';
  await writeFile(target,original);await writeFile(source,`EXTRACTION_SERVICE_TOKEN=${token}\nEXTRACTION_PORT=3011\nPRIVATE_UNRELATED=not-copied\n`);
  const run=()=>spawnSync(process.execPath,[script],{cwd:backend,encoding:'utf8'});
  const first=run();assert.equal(first.status,0,first.stderr);assert.ok(!first.stdout.includes(token));
  const content=await readFile(target,'utf8');const env=parseEnv(content);assert.equal(env.EXTRACTION_SERVICE_TOKEN,'legacy-token-preserved');assert.equal(env.SCRAPER_SERVICE_URL,'http://127.0.0.1:3010');assert.equal(env.OTHER_SETTING,'preserved');assert.equal(env.MANUAL_EXTRACTION_SERVICE_TOKEN,token);assert.equal(env.MANUAL_EXTRACTOR_URL,'http://127.0.0.1:3011');assert.equal(env.PRIVATE_UNRELATED,undefined);
  assert.equal(run().status,0);assert.equal(await readFile(target,'utf8'),content);
  await writeFile(source,'EXTRACTION_SERVICE_TOKEN=another-valid-token-more-than-32-characters\n');assert.notEqual(run().status,0);assert.equal(await readFile(target,'utf8'),content);
  await writeFile(source,`EXTRACTION_SERVICE_TOKEN=${token}\nEXTRACTION_PORT=3011\n`);await writeFile(target,content.replace('http://127.0.0.1:3011','https://remote.example.com'));assert.notEqual(run().status,0);
  await writeFile(target,original+'MANUAL_EXTRACTOR_URL=\nMANUAL_EXTRACTION_SERVICE_TOKEN=\n');assert.equal(run().status,0);assert.equal(parseEnv(await readFile(target,'utf8')).MANUAL_EXTRACTION_SERVICE_TOKEN,token);
  for(const value of [`EXTRACTION_SERVICE_TOKEN=DUMMY_REPLACE_WITH_REAL_SECRET_12345\n`,`EXTRACTION_SERVICE_TOKEN=${token}\nEXTRACTION_PORT=0\n`]){await writeFile(source,value);assert.notEqual(run().status,0);}
 }finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
});
