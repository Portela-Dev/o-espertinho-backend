import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RemoteOfferExtractor} from '../dist/remote-extractor.js';
import {HttpError} from '../dist/security.js';
const token='test-only-'.padEnd(64,'a');
const market={id:'mercadolivre',name:'Mercado Livre',allowed_hosts:['meli.la','www.mercadolivre.com.br'],scraping_enabled:true};
const profile={rules:[{field:'title',selectors:['h1'],mode:'text',required:true},{field:'price',selectors:['.price'],mode:'text',required:true}],version:1,wait_timeout_ms:1000,validity_minutes:60};
const data={title:'Máquina de solda',priceCents:56690,originalPriceCents:null,description:'',category:'',conditions:'Confira a loja.',externalId:'MLB123',productUrl:'https://www.mercadolivre.com.br/p/MLB123',images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};

test('adapter remoto leva perfil e autenticação; resposta inválida não vira anúncio',async()=>{
 const remote=new RemoteOfferExtractor('http://localhost:3010',token,async(url,options)=>{
  assert.equal(url,'http://localhost:3010/extract');assert.equal(options.headers.authorization,'Bearer '+token);assert.equal(options.redirect,'error');const payload=JSON.parse(options.body);assert.deepEqual(payload.profile,profile);assert.deepEqual(payload.market,market);return Response.json(data);
 });
 assert.equal((await remote.extract('https://meli.la/test',market,profile)).priceCents,56690);
 for(const invalid of [{...data,priceCents:-1},{...data,productUrl:'https://evil.example/p'},{}]){
  const bad=new RemoteOfferExtractor('http://localhost:3010',token,async()=>Response.json(invalid));await assert.rejects(()=>bad.extract('https://meli.la/test',market,profile));
 }
 await assert.rejects(()=>new RemoteOfferExtractor('http://localhost:3010',token,async()=>{throw new Error('sensitive internal error');}).extract('https://meli.la/test',market,profile),/Não foi possível consultar/);
 for(const status of [401,429,422]){
  const remoteError=new RemoteOfferExtractor('http://localhost:3010',token,async()=>Response.json({error:'Página bloqueada.'},{status}));
  await assert.rejects(()=>remoteError.extract('https://meli.la/test',market,profile),error=>error instanceof HttpError&&error.status===(status===401?502:status));
 }
});

