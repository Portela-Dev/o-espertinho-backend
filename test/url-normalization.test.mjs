import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProductUrl,urlNormalizationRulesSchema} from '../dist/url-normalization.js';
const rules=[{type:'remove_path_suffix',marker:'/ref='}];
test('literal configured path suffixes are removed before stable product identity is persisted',()=>{
 const original='https://www.example.com/celular-c%C3%A2mera/product/123/ref=context/session?tracking=1#details';
 const expected='https://www.example.com/celular-c%C3%A2mera/product/123';
 assert.equal(normalizeProductUrl(original,rules),expected);
 assert.equal(normalizeProductUrl(expected,rules),expected);
 assert.equal(normalizeProductUrl(original),original.split('?')[0]);
 assert.equal(normalizeProductUrl('https://www.example.com/p/123?next=/ref=test#x',rules),'https://www.example.com/p/123');
 assert.equal(normalizeProductUrl('https://www.example.com/p/123/REF=context',rules),'https://www.example.com/p/123/REF=context');
 assert.equal(normalizeProductUrl('https://www.example.com/p/123/tracking/test/ref=x',[...rules,{type:'remove_path_suffix',marker:'/tracking/'}]),'https://www.example.com/p/123');
});
test('normalization rejects unsafe URLs, overlong results and invalid declarative rules',()=>{
 for(const url of ['http://www.example.com/p/1','https://user:secret@www.example.com/p/1','https://www.example.com:8443/p/1'])assert.throws(()=>normalizeProductUrl(url,rules));
 assert.throws(()=>normalizeProductUrl('https://www.example.com/ref=test',rules),/todo o caminho/);
 assert.throws(()=>normalizeProductUrl('https://www.example.com/'+ 'a'.repeat(4000)));
 for(const marker of ['ref=','/','/x?','/x#','/x\\','/x y','/'+ 'x'.repeat(120)])assert.equal(urlNormalizationRulesSchema.safeParse([{type:'remove_path_suffix',marker}]).success,false);
 assert.equal(urlNormalizationRulesSchema.safeParse([{type:'regex',marker:'/ref='}]).success,false);
 assert.equal(urlNormalizationRulesSchema.safeParse([{type:'remove_path_suffix',marker:'/ref=',code:'anything'}]).success,false);
 assert.equal(urlNormalizationRulesSchema.safeParse(Array.from({length:21},()=>rules[0])).success,false);
});
