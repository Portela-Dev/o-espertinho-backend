import{test}from'node:test';
import assert from'node:assert/strict';
import{createServer}from'node:http';
import{testDatabase,testConfig,identity,client,seedProduct,seedOffer,createApp}from'./helpers.mjs';
import{startOfferRefresh,tickOfferRefresh}from'../dist/offer-refresh.js';
import{linkIdentity}from'../dist/link-identity.js';
const token='test-only-secret-with-at-least-32-characters';
const rules=[{field:'title',selectors:['h1'],mode:'text',required:true},{field:'price',selectors:['.price'],mode:'text',required:true}];
const data={title:'Produto extraído',brand:'Marca',priceCents:15000,originalPriceCents:null,description:'',category:'',conditions:'',externalId:'vendor-id',productUrl:'https://www.amazon.com.br/product',images:[],specifications:[],warnings:[],missing:[],evidence:[],availability:'available',collectedAt:new Date().toISOString()};
async function httpService(t,handle){const server=createServer(handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return `http://127.0.0.1:${server.address().port}`;}
test('selector tests and link previews use only the manual service; product binding remains admin-defined',async t=>{
 let calls=0,legacy=0;
 const manual=await httpService(t,async(req,res)=>{assert.equal(req.url,'/v1/extractions');assert.equal(req.headers.authorization,'Bearer '+token);let raw='';for await(const part of req){raw+=part;}const body=JSON.parse(raw);assert.ok(body.profile.allowedHosts.includes('www.amazon.com.br'));assert.equal(body.market,undefined);calls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'available',data}));});
 const old=await httpService(t,(_req,res)=>{legacy++;res.end('{}');});
 const {db}=await testDatabase();t.after(()=>db.end());await db.query("UPDATE marketplaces SET scraping_enabled=true WHERE id='amazon'");
 await db.query("UPDATE scraping_profiles SET rules=$1,wait_timeout_ms=1000,validity_minutes=60 WHERE marketplace_id='amazon'",[JSON.stringify(rules)]);
 const product=await seedProduct(db);const app=createApp(db,{...testConfig(),MANUAL_EXTRACTOR_URL:manual,MANUAL_EXTRACTION_SERVICE_TOKEN:token,SCRAPER_SERVICE_URL:old,EXTRACTION_SERVICE_TOKEN:'different-legacy-secret-at-least-32-characters'},{verifyGoogle:async value=>identity(value)});
 const admin=client(app);await admin.login('admin');
 const tested=await admin.mutate('post','/api/admin/selectors/amazon/test',{url:data.productUrl,profile:{version:1,rules,waitTimeoutMs:1000,validityMinutes:60}});assert.equal(tested.status,200);assert.equal(tested.body.data.priceCents,15000);
 const preview=await admin.mutate('post','/api/admin/link-imports/preview',{marketplaceId:'amazon',productId:product,url:data.productUrl});assert.equal(preview.status,200);assert.equal(preview.body.canConfirm,true);assert.equal(preview.body.product.id,product);
 const confirmed=await admin.mutate('post','/api/admin/link-imports/confirm',{previewId:preview.body.previewId,authorizedContent:true});assert.equal(confirmed.status,201);
 const row=(await db.query('SELECT * FROM offers WHERE id=$1',[confirmed.body.offerId])).rows[0];assert.equal(row.product_id,product);assert.equal(row.external_id,linkIdentity('amazon',data.productUrl));assert.equal(calls,2);assert.equal(legacy,0);
});
test('price job keeps its legacy endpoint and safely refreshes URL-identified manual links',async t=>{
 let legacyCalls=0,manualCalls=0;let destination=data.productUrl;
 const old=await httpService(t,(req,res)=>{assert.equal(req.url,'/extract');assert.equal(req.headers.authorization,'Bearer '+token);legacyCalls++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...data,productUrl:destination,externalId:'unrelated-vendor-id'}));});
 const manual=await httpService(t,(_req,res)=>{manualCalls++;res.end('{}');});
 const {db}=await testDatabase();t.after(()=>db.end());await db.query("UPDATE marketplaces SET scraping_enabled=true WHERE id='amazon'");await db.query("UPDATE scraping_profiles SET rules=$1,wait_timeout_ms=1000,validity_minutes=60 WHERE marketplace_id='amazon'",[JSON.stringify(rules)]);
 const offer=await seedOffer(db,{source:'scraped',affiliate:data.productUrl,externalId:linkIdentity('amazon',data.productUrl),price:20000});
 const config={...testConfig(),SCRAPER_SERVICE_URL:old,EXTRACTION_SERVICE_TOKEN:token,MANUAL_EXTRACTOR_URL:manual,MANUAL_EXTRACTION_SERVICE_TOKEN:'different-manual-secret-at-least-32-characters'};
 const admin=(await db.query("SELECT id FROM users WHERE email='arnaldorolimportela@gmail.com'")).rows[0].id;
 await startOfferRefresh(db,admin);await tickOfferRefresh(db,config,{});let row=(await db.query('SELECT * FROM offers WHERE id=$1',[offer])).rows[0];assert.equal(row.price_cents,15000);assert.equal(row.refresh_status,'updated');assert.equal(legacyCalls,1);assert.equal(manualCalls,0);
 destination='https://www.amazon.com.br/other-product';await startOfferRefresh(db,admin);await db.query("UPDATE offer_refresh_runs SET next_item_at=now()-interval '1 minute' WHERE status='queued'");await tickOfferRefresh(db,config,{});row=(await db.query('SELECT * FROM offers WHERE id=$1',[offer])).rows[0];assert.equal(row.price_cents,15000);assert.equal(row.refresh_status,'pending');
});
