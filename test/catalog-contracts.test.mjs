import test from 'node:test';
import assert from 'node:assert/strict';
import { allowStep, startCatalogInput } from '../dist/catalog-contracts.js';
import { catalogFixture } from './catalog-helpers.mjs';
test('autenticação definitiva independe do flag da POC e permite revogação',async t=>{
  const f=await catalogFixture(t);
  assert.equal((await f.call('get','/session')).status,200);
  await f.db.query('UPDATE users SET blocked=true WHERE id=$1',[f.auth.user.id]);
  assert.equal((await f.call('get','/session')).status,401);
});
test('permissões de etapa e contratos recusam escalada e dados extras',()=>{
  assert.throws(()=>allowStep({permissions:['affiliate_links']},'prices'));
  allowStep({permissions:['affiliate_links','updates']},'prices');
  assert.equal(startCatalogInput.safeParse({marketplaceId:'any',step:'prices',requestKey:crypto.randomUUID(),cookie:'secret'}).success,false);
});
