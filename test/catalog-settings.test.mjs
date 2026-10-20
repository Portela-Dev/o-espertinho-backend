import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogFixture} from './catalog-helpers.mjs';
import {catalogSettings} from '../dist/catalog-settings.js';
test('regras declarativas limitadas e configurações com versão e XSRF',async t=>{
 const f=await catalogFixture(t),path='/api/admin/extension-catalog/settings/amazon';
 const initial=await f.browser.get(path);assert.equal(initial.status,200);
 const config=catalogSettings.parse({});config.blockRules=[{kind:'challenge',match:'selector',value:'.human-check'}];
 const input={version:0,executor:'extension',config};
 assert.equal((await f.browser.mutate('put',path,input)).status,200);
 assert.equal((await f.browser.mutate('put',path,input)).status,409);
 assert.equal(catalogSettings.safeParse({...config,cookie:'private'}).success,false);
 assert.equal(catalogSettings.safeParse({...config,blockRules:[{kind:'challenge',match:'javascript',value:'eval()'}]}).success,false);
});
