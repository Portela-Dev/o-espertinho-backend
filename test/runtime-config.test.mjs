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
