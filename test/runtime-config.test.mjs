import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {envSchema} from '../dist/config.js';
const required={DATABASE_URL:'postgresql://ci:ci@postgres/ci',ENCRYPTION_KEY:Buffer.alloc(32).toString('base64')};
test('desenvolvimento mantém loopback; produção pode escutar a rede do container',()=>{
 const local=envSchema.parse(required);assert.equal(local.HOST,'127.0.0.1');assert.equal(local.TRUST_PROXY,'loopback');
 const docker=envSchema.parse({...required,HOST:'0.0.0.0',TRUST_PROXY:'loopback,uniquelocal'});assert.equal(docker.HOST,'0.0.0.0');assert.equal(docker.TRUST_PROXY,'loopback,uniquelocal');
});
test('configuração não permite host arbitrário ou confiar em todo proxy público',()=>{
 for(const values of [{HOST:'public.example.com'},{TRUST_PROXY:'true'},{TRUST_PROXY:'0.0.0.0/0'}])assert.equal(envSchema.safeParse({...required,...values}).success,false);
});


test('produção exige origens públicas HTTPS explícitas e rejeita caminhos/credenciais',()=>{
 const production={...required,NODE_ENV:'production',APP_ORIGIN:'https://app.example.com',EXTENSION_BACKEND_URL:'https://app.example.com'};
 assert.equal(envSchema.safeParse(production).success,true);
 for(const field of ['APP_ORIGIN','EXTENSION_BACKEND_URL']){
  for(const value of ['http://app.example.com','http://localhost:3000','https://127.0.0.1','https://[::1]','https://app.local','https://app.example.com:8443','https://user:pass@app.example.com','https://app.example.com/path','https://app.example.com?x=1','https://app.example.com#x'])assert.equal(envSchema.safeParse({...production,[field]:value}).success,false,field+' '+value);
  const missing={...production};delete missing[field];assert.equal(envSchema.safeParse(missing).success,false,field+' ausente');
 }
 for(const field of ['APP_ORIGIN','EXTENSION_BACKEND_URL'])assert.equal(envSchema.safeParse({...required,[field]:'http://localhost:4200/path'}).success,false);
});


test('origens canônicas mantêm comparação CSRF e URLs de conexão consistentes',()=>{
 const run=spawnSync(process.execPath,['--input-type=module','-e',"const {loadConfig}=await import('./dist/config.js');const c=loadConfig();console.log(JSON.stringify([c.APP_ORIGIN,c.EXTENSION_BACKEND_URL]));"],{cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_URL:'postgresql://test:dummy@postgres/test',NODE_ENV:'production',APP_ORIGIN:'https://APP.EXAMPLE.COM/',EXTENSION_BACKEND_URL:'https://APP.EXAMPLE.COM/'},encoding:'utf8',windowsHide:true});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),['https://app.example.com','https://app.example.com']);
});
