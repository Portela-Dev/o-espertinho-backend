import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ManualOfferExtractor} from '../dist/manual-extractor.js';
import {manualProfile} from '../dist/manual-extractor-profile.js';
import {linkIdentity} from '../dist/link-identity.js';
const token='test-only-'.padEnd(64,'a');
const market={id:'loja-teste',name:'Loja de teste',allowed_hosts:['loja.example.com'],scraping_enabled:true};
const url='https://loja.example.com/item?affiliate=abc';
const profile={version:1,wait_timeout_ms:1000,validity_minutes:60,rules:[
 {field:'title',selectors:['h1'],mode:'text',attribute:'',required:true},
 {field:'price',selectors:['.price'],mode:'text',attribute:'',required:true},
 {field:'images',selectors:['img'],mode:'attribute',attribute:'data-a-dynamic-image',required:false},
 {field:'specifications',selectors:['tr'],mode:'pairs',attribute:'',required:false,nameSelector:'',valueSelector:''},
 {field:'externalId',selectors:['#vendorId'],mode:'attribute',attribute:'value',required:false},
]};
const data=()=>({title:'Produto',brand:'Marca',priceCents:32100,originalPriceCents:40000,description:'Descrição',category:'Categoria',conditions:'',externalId:'vendor-internal-id',productUrl:'https://loja.example.com/item',images:[],specifications:[],warnings:[],missing:[],evidence:[],availability:'available',collectedAt:new Date().toISOString()});
const remote=body=>new ManualOfferExtractor('http://localhost:3011',token,async()=>Response.json(body));
test('translates legacy selector profiles and posts only the new contract to the manual service',async()=>{
 const client=new ManualOfferExtractor('http://localhost:3011',token,async(endpoint,options)=>{
  assert.equal(endpoint,'http://localhost:3011/v1/extractions');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer '+token);assert.ok(options.signal);
  const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['url','profile']);assert.deepEqual(body.profile.allowedHosts,market.allowed_hosts);assert.equal(body.profile.timeoutMs,1000);assert.equal(body.profile.version,undefined);
  assert.equal(body.profile.rules[1].wholeSelector,'.a-price-whole,.andes-money-amount__fraction');assert.equal(body.profile.rules[2].wholeSelector,undefined);
  assert.equal(body.profile.rules[3].attribute,'src');assert.equal(body.profile.rules[4].nameSelector,'th');assert.equal(body.profile.rules[4].valueSelector,'td');
  assert.equal(body.profile.rules.some(rule=>rule.field==='externalId'),false);assert.equal(body.profile.rules[0].attribute,undefined);
  return Response.json({status:'available',data:data()});
 });
 const result=await client.extract(url,market,profile);
 assert.equal(result.priceCents,32100);assert.equal(result.externalId,linkIdentity(market.id,url));assert.notEqual(result.externalId,data().externalId);assert.ok(result.conditions);assert.equal(result.productUrl,data().productUrl);
});
test('link identity is technical, stable and independent from product or marketplace item identifiers',()=>{
 assert.equal(linkIdentity('loja',url+'#anchor'),linkIdentity('loja',url));
 assert.equal(linkIdentity('loja','https://loja.example.com/p?b=2&a=1'),linkIdentity('loja','https://loja.example.com/p?a=1&b=2'));
 assert.notEqual(linkIdentity('other',url),linkIdentity('loja',url));assert.notEqual(linkIdentity('loja',url+'/other'),linkIdentity('loja',url));
});
test('incomplete previews remain incomplete and explicit unavailability cannot be confirmed',async()=>{
 const incomplete=await remote({status:'technical_failure',reason:'incomplete',data:{...data(),priceCents:null,availability:'unknown',missing:['price']}}).extract(url,market,profile);
 assert.equal(incomplete.priceCents,null);assert.deepEqual(incomplete.missing,['price']);
 const unavailable=await remote({status:'unavailable',data:{...data(),availability:'unavailable',priceCents:null}}).extract(url,market,profile);
 assert.equal(unavailable.priceCents,null);assert.ok(unavailable.missing.includes('price'));
 const trimmed=await remote({status:'available',data:{...data(),category:'x'.repeat(200)}}).extract(url,market,profile);assert.equal(trimmed.category.length,80);
});
test('technical failures and service errors remain failures without exposing upstream secrets',async()=>{
 for(const [reason,status] of [['invalid_configuration',400],['unsafe_url',400],['timeout',504],['blocked',422],['http_error',422],['browser_error',502]]){
  await assert.rejects(()=>remote({status:'technical_failure',reason}).extract(url,market,profile),error=>error.status===status);
 }
 for(const status of [400,401,403,413,415,429,503,500]){
  const client=new ManualOfferExtractor('http://localhost:3011',token,async()=>Response.json({error:{message:'upstream-secret'}},{status}));
  await assert.rejects(()=>client.extract(url,market,profile),error=>!error.message.includes('upstream-secret')&&error.status===(status===429?429:status===503?503:[400,413,415].includes(status)?400:502));
 }
 for(const invalid of [{},{status:'technical_failure',reason:'incomplete'},{status:'technical_failure',reason:'incomplete',data:data()},{status:'unavailable',data:data()},{status:'available',data:{...data(),priceCents:null}},{status:'available',data:{...data(),missing:['images']}},{status:'available',data:{...data(),availability:'unknown'}},{status:'available',data:{...data(),productUrl:'https://evil.example.com/item'}}]){
  await assert.rejects(()=>remote(invalid).extract(url,market,profile));
 }
 const network=new ManualOfferExtractor('http://localhost:3011',token,async()=>{throw new Error('upstream-secret');});await assert.rejects(()=>network.extract(url,market,profile),error=>error.status===502&&!error.message.includes('upstream-secret'));
 const malformed=new ManualOfferExtractor('http://localhost:3011',token,async()=>new Response('{bad'));await assert.rejects(()=>malformed.extract(url,market,profile),error=>error.status===502);
});
test('rejects unsafe input, invalid configuration and oversized adapted profiles before HTTP',async()=>{
 let calls=0;const client=new ManualOfferExtractor('http://localhost:3011',token,async()=>{calls++;return Response.json({status:'available',data:data()});});
 await assert.rejects(()=>client.extract('https://other.example.com/',market,profile),error=>error.status===400);assert.equal(calls,0);
 for(const origin of ['file:///tmp/','http://user:pass@localhost:3011/','http://localhost:3011/path','http://localhost:3011/?x=1','http://localhost:3011/#hash']){assert.throws(()=>new ManualOfferExtractor(origin,token));}
 assert.throws(()=>new ManualOfferExtractor('http://localhost:3011','short'));
 assert.throws(()=>manualProfile(market,{...profile,rules:Array.from({length:40},()=>profile.rules[1])}),error=>error.status===400);
});
