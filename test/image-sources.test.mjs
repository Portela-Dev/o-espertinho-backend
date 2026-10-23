import test from 'node:test';import assert from 'node:assert/strict';
import {testDatabase} from './helpers.mjs';import {profileSchema,selectorRuleSchema} from '../dist/scraping.js';
test('migrations mantêm configuração genérica de galeria e todas as outras regras',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const rows=(await db.query('SELECT marketplace_id,rules,version,wait_timeout_ms,validity_minutes FROM scraping_profiles')).rows;
 for(const row of rows){const parsed=profileSchema.safeParse({version:row.version,rules:row.rules,waitTimeoutMs:row.wait_timeout_ms,validityMinutes:row.validity_minutes});assert.equal(parsed.success,true,JSON.stringify(parsed.error));}
 const amazon=rows.find(r=>r.marketplace_id==='amazon');assert.ok(amazon.rules.some(r=>r.field==='rating'));assert.ok(amazon.rules.some(r=>r.field==='price'));const images=amazon.rules.filter(r=>r.field==='images');assert.equal(images[0].mode,'json');assert.deepEqual(images[0].imageProperties,['hiRes','large']);assert.equal(images.at(-1).imageSource,'fallback');assert.ok(images.some(r=>r.selectors.includes('#altImages .imageThumbnail img')));
 assert.equal(selectorRuleSchema.safeParse({field:'title',selectors:['h1'],mode:'json'}).success,false);
 assert.equal(selectorRuleSchema.safeParse({field:'images',selectors:['img'],mode:'attribute',attribute:'src',attributes:['bad attribute']}).success,false);
 assert.equal(selectorRuleSchema.safeParse({field:'images',selectors:['script'],mode:'json',jsonPath:'a[0]'}).success,false);
});
