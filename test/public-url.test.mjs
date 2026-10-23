import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublicHttpsUrl,publicHostname,publicHttpsUrlSchema} from '../dist/public-url.js';
import {scrapedDataSchema} from '../dist/extraction-data.js';
import {testDatabase,testConfig,createApp,client,identity} from './helpers.mjs';
const unsafe=[
 'http://cdn.example.com/p.png','javascript:alert(1)','data:image/svg+xml,<svg/>',
 'https://127.0.0.1/p.png','https://127.1/p.png','https://2130706433/p.png','https://0x7f000001/p.png',
 'https://10.0.0.1/p.png','https://[::1]/p.png','https://localhost/p.png','https://router.local/p.png',
 'https://router.lan/p.png','https://home.arpa/p.png','https://router.home.arpa/p.png',
 'https://metadata.google.internal/p.png','https://user:secret@cdn.example.com/p.png','https://cdn.example.com:8443/p.png'
];
test('URLs públicas bloqueiam IPs, hosts locais, credenciais, portas e protocolos alternativos',()=>{
 for(const value of unsafe){assert.equal(isPublicHttpsUrl(value),false,value);assert.equal(publicHttpsUrlSchema.safeParse(value).success,false,value);}
 for(const value of ['https://cdn.example.com/p.png?size=large','https://down-br.img.susercontent.com/file/x','https://m.media-amazon.com/images/I/photo.jpg','https://cdn.example.com:443/p.png'])assert.equal(isPublicHttpsUrl(value),true,value);
 for(const host of ['-invalid.example.com','bad..example.com','example.com.','UPPER.example.com'])assert.equal(publicHostname(host),false,host);
});
test('contrato de extração recusa imagens inseguras antes de persistir resultados',()=>{
 const data={title:'Produto',priceCents:1000,originalPriceCents:null,description:'',category:'',conditions:'',externalId:'',productUrl:'https://shop.example.com/p',images:[],specifications:[],warnings:[],missing:[],evidence:[],collectedAt:new Date().toISOString()};
 assert.equal(scrapedDataSchema.safeParse({...data,images:['https://cdn.example.com/p.png']}).success,true);
 for(const value of unsafe)assert.equal(scrapedDataSchema.safeParse({...data,images:[value]}).success,false,value);
});
test('cadastro de produto e compartilhamento usam a mesma política de URL pública',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:identity}),admin=client(app);await admin.login('admin');
 const settings=(await admin.get('/api/admin/sharing')).body;
 for(const imageUrl of unsafe){
  assert.equal((await admin.mutate('post','/api/admin/products',{name:'Produto',category:'Tecnologia',imageUrl})).status,400,imageUrl);
  assert.equal((await admin.mutate('put','/api/admin/sharing',{...settings,channels:[{...settings.channels[0],logoUrl:imageUrl}]})).status,400,imageUrl);
 }
 const privateShare={...settings,channels:[{...settings.channels[0],urlTemplate:'https://127.0.0.1/share?text={texto}'}]};
 assert.equal((await admin.mutate('put','/api/admin/sharing',privateShare)).status,400);
 assert.equal((await admin.mutate('put','/api/admin/sharing',settings)).status,200);
 assert.equal((await admin.mutate('post','/api/admin/products',{name:'Produto seguro',category:'Tecnologia',imageUrl:'https://cdn.example.com/photo.png'})).status,201);
});
