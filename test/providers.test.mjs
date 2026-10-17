import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ProviderService} from '../dist/providers.js';
import {encrypt,decrypt,marketplaceURL} from '../dist/security.js';
const response=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
test('Amazon autentica no endpoint oficial, preserva link retornado e reutiliza token',async()=>{
  const calls=[],link='https://www.amazon.com.br/dp/B012345678?tag=minhatag-20&linkCode=ogi&th=1';
  const provider=new ProviderService(async(url,options)=>{calls.push({url,options});return url.includes('/auth/o2/')?response({access_token:'test-token',expires_in:3600}):response({searchResult:{items:[{asin:'B012345678',detailPageURL:link,itemInfo:{title:{displayValue:'Monitor'}},images:{primary:{medium:{url:'https://m.media-amazon.com/images/test.jpg'}}},offersV2:{listings:[{price:{money:{amount:999.9},savings:{money:{amount:100}}}}]}}]}});});
  const credentials={clientId:'test',clientSecret:'secret',partnerTag:'minhatag-20',version:'3.1'};
  const result=await provider.search('amazon',credentials,{keywords:'monitor',maxPriceCents:100000,minDiscount:5});assert.equal(result[0].affiliateUrl,link);assert.equal(result[0].priceCents,99990);
  await provider.search('amazon',credentials,{keywords:'monitor'});assert.equal(calls.filter(c=>c.url.includes('/auth/o2/')).length,1);const payload=JSON.parse(calls[1].options.body);assert.equal(payload.partnerTag,'minhatag-20');assert.equal(payload.marketplace,'www.amazon.com.br');assert.equal(payload.minSavingPercent,5);
});

test('erros externos não vazam credenciais e Mercado Livre exige acesso oficial',async()=>{
  const p=new ProviderService(async()=>new Response(JSON.stringify({error:'secret-leaked'}),{status:401}));await assert.rejects(()=>p.search('amazon',{clientId:'test',clientSecret:'secret-leaked',version:'3.1',partnerTag:'tag'},{keywords:'monitor'}),e=>e.status===502&&!e.message.includes('secret-leaked'));
  await assert.rejects(()=>p.search('mercadolivre',{clientId:'x',clientSecret:'x',refreshToken:'x'},{keywords:'monitor'}),e=>e.status===409);
});
test('links maliciosos são rejeitados e criptografia detecta adulteração',()=>{
  for(const url of ['javascript:alert(1)','https://amazon.com.br.evil.test/x','https://amazon.com.br@evil.test/x','http://amazon.com.br/x','https://amazon.com.br:8443/x'])assert.throws(()=>marketplaceURL(url,'amazon'));
  const key=Buffer.alloc(32,9).toString('base64'),encoded=encrypt({secret:'private'},key);assert.equal(decrypt(encoded,key).secret,'private');const parts=encoded.split('.');parts[2]=Buffer.from('tampered').toString('base64');assert.throws(()=>decrypt(parts.join('.'),key));
});
test('Mercado Livre consulta somente API oficial e preserva refresh token rotacionado mesmo quando o item falha',async()=>{
  const c={clientId:'id',clientSecret:'secret',refreshToken:'old-token'};const calls=[];
  const p=new ProviderService(async(url,o)=>{calls.push(url);if(url.endsWith('/oauth/token'))return response({access_token:'access',refresh_token:'rotated-token',expires_in:21600});if(url.endsWith('/users/me'))return response({id:123});return new Response('{}',{status:403});});
  assert.equal(await p.check('mercadolivre',c),'catalog_only');assert.equal(c.refreshToken,'rotated-token');
  await assert.rejects(()=>p.refresh('mercadolivre',c,'MLB12345'),e=>e.status===502);assert.equal(calls.filter(url=>url.endsWith('/oauth/token')).length,1);assert.ok(calls.every(url=>url.startsWith('https://api.mercadolibre.com/')));
});
