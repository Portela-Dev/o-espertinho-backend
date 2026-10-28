import {seedProduct,finishManualFixture} from './helpers.mjs';
// Isolated integration-test server. Never imported by src/server.ts.
// No authentication bypass exists in the production application.
import express from 'express';
import {randomUUID} from 'node:crypto';
import {testDatabase,testConfig,identity,createApp} from './helpers.mjs';
if(process.env.E2E_TEST_SERVER!=='1')throw new Error('Use somente com E2E_TEST_SERVER=1.');
const {db}=await testDatabase(),config={...testConfig(),APP_ORIGIN:process.env.E2E_APP_ORIGIN||'http://localhost:4200',MELI_REDIRECT_URI:'https://callback.example/api/admin/mercadolivre/callback',MELI_OAUTH_PKCE:'false'};
const previews=[
  ['Monitor 27 polegadas QHD para trabalhar com mais espaço','amazon','Tecnologia',89990,119990,'monitor'],
  ['Fone sem fio com cancelamento de ruído','mercadolivre','Tecnologia',18990,29990,'headphones'],
  ['Cafeteira para começar bem todas as manhãs','mercadolivre','Casa',24990,34990,'coffee'],
  ['Luminária de mesa com luz ajustável','mercadolivre','Casa',7990,12990,'lamp'],
  ['Caixa de som portátil para acompanhar seus planos','amazon','Tecnologia',29990,39990,'speaker'],
  ['Mochila urbana com espaço para notebook','mercadolivre','Estilo',13990,19990,'bag']
];
const images={monitor:'<rect x="37" y="26" width="166" height="108" rx="7" fill="#344841"/><rect x="45" y="34" width="150" height="92" rx="3" fill="#9cb6a3"/><path d="M45 112L115 50l80 76H45" fill="#c0d3a8"/><path d="M105 134v20H78v7h84v-7h-27v-20" fill="#5d6f62"/>',headphones:'<path d="M64 105V84a56 56 0 01112 0v21" fill="none" stroke="#4e6554" stroke-width="21"/><rect x="48" y="87" width="37" height="69" rx="16" fill="#2b4035"/><rect x="155" y="87" width="37" height="69" rx="16" fill="#2b4035"/>',coffee:'<rect x="62" y="28" width="110" height="135" rx="13" fill="#657d69"/><rect x="73" y="44" width="86" height="30" rx="7" fill="#2e4637"/><path d="M83 91h65v42q0 22-32 22t-33-22z" fill="#e8e1cf"/><path d="M148 99h10q22 20-10 31" fill="none" stroke="#e8e1cf" stroke-width="8"/><circle cx="144" cy="59" r="5" fill="#c8f27a"/>',lamp:'<path d="M82 157h79M122 155V95l31-39" fill="none" stroke="#60775f" stroke-width="10" stroke-linecap="round"/><path d="M151 37q38 4 39 43l-65-12z" fill="#c5ae72"/><ellipse cx="158" cy="76" rx="32" ry="8" fill="#e9dca8"/>',speaker:'<rect x="63" y="28" width="113" height="140" rx="27" fill="#4b6657"/><circle cx="119" cy="110" r="35" fill="#354c3f"/><circle cx="119" cy="110" r="23" fill="#69846a"/><circle cx="119" cy="58" r="9" fill="#b9d099"/>',bag:'<path d="M99 41v-8q21-19 42 0v8" fill="none" stroke="#47634f" stroke-width="9"/><rect x="61" y="40" width="119" height="127" rx="28" fill="#a3b98c"/><rect x="75" y="95" width="91" height="56" rx="15" fill="#77936b"/><path d="M82 108h77" stroke="#52694b" stroke-width="4"/>'};
for(const [title,market,category,price,oldPrice,visual] of previews){const affiliateBase=market==='amazon'?'https://www.amazon.com.br/dp/B012345678?tag=test-20':'https://www.mercadolivre.com.br/sec/test';const affiliate=affiliateBase+'?fixture='+visual;const productId=await seedProduct(db,{name:title,category});await db.query(`INSERT INTO offers(id,marketplace_id,external_id,title,category,image_url,product_url,affiliate_url,price_cents,original_price_cents,status,source,conditions,expires_at,published_at,product_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'published','manual','Dados fictícios usados apenas em testes.', $10,now(),$11)`,[randomUUID(),market,randomUUID(),title,category,'/api/test-image/'+visual,affiliate,price,oldPrice,new Date(Date.now()+86400000),productId]);}
await db.query("INSERT INTO offers(id,marketplace_id,external_id,title,category,product_url,affiliate_url,price_cents,status,source,expires_at,product_id) VALUES($1,'mercadolivre','pending-test','Oferta pendente de revisão','Casa','https://www.mercadolivre.com.br/sec/test','https://www.mercadolivre.com.br/sec/test',9990,'pending','manual',$2,$3)",[randomUUID(),new Date(Date.now()+86400000),await seedProduct(db,{name:'Produto pendente',category:'Casa'})]);
await db.query("INSERT INTO offers(id,marketplace_id,external_id,title,category,product_url,affiliate_url,price_cents,status,source,expires_at,product_id) VALUES($1,'mercadolivre','expired-delete-test','Oferta encerrada para exclusão','Casa','https://www.mercadolivre.com.br/sec/test','https://www.mercadolivre.com.br/sec/test-expired',9990,'expired','scraped',$2,$3)",[randomUUID(),new Date(Date.now()-86400000),await seedProduct(db,{name:'Produto encerrado',category:'Casa'})]);
// Enriched discovery fixtures for real product-assignment browser tests only.
const reviewCategory=(await db.query("SELECT id FROM category_nodes WHERE path=ARRAY['Tecnologia']")).rows[0].id;
for(const [id,title] of [['6ef4f2a1-912f-463a-a6e8-43c505976781','Link para produto existente'],['6ef4f2a1-912f-463a-a6e8-43c505976782','Produto descoberto para criar']]){
 await db.query("INSERT INTO discovery_links(id,marketplace_id,url,extraction_status,enrichment_data,confirmed_category_id,category_confirmed_at) VALUES($1,'amazon',$2,'completed',$3,$4,now())",[id,'https://www.amazon.com.br/product/'+id,JSON.stringify({title,description:'Descrição extraída do produto',brand:'Marca extraída',images:['https://example.com/image.jpg']}),reviewCategory]);
}
// Product-first review fixtures: provisional identities never enter the public catalog.
const manualReviewData=(title)=>({title,description:'Descrição manual extraída',brand:'Marca manual',images:['https://example.com/image.jpg'],priceCents:32100,availability:'available',missing:[],specifications:[],conditions:''});
const manualDraft='6ef4f2a1-912f-463a-a6e8-43c505976785';
await db.query("INSERT INTO review_ai_product_drafts(id,identity_key,name,description,brand) VALUES($1,'test-manual-draft','Rascunho existente para categorizar','Descrição do rascunho','Marca manual')",[manualDraft]);
for(const [id,title,draft] of [['6ef4f2a1-912f-463a-a6e8-43c505976783','Cadastro manual sem categoria',null],['6ef4f2a1-912f-463a-a6e8-43c505976784','Rascunho existente para categorizar',manualDraft]]){
 const url='https://www.amazon.com.br/product/'+id;
 await db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,extracted_at,product_draft_id) VALUES($1,'amazon',$2,$3,'completed',$4,now(),$5)",[id,url,url+'?tag=test-20',JSON.stringify(manualReviewData(title)),draft]);
}
// Daily observations are fictitious and exist only in this isolated test database.
await db.query(`INSERT INTO offer_price_history(offer_id,product_id,day,price_cents,observed_at)
 SELECT o.id,o.product_id,dates.day,o.price_cents+((g%9)-4)*100,(dates.day+time '15:00') AT TIME ZONE 'UTC'
 FROM offers o CROSS JOIN generate_series(0,364) g CROSS JOIN LATERAL (SELECT (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date-g AS day) dates WHERE o.status='published'`);
const app=express();app.get('/api/test-image/:name',(req,res)=>res.type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="190" viewBox="0 0 240 190">${images[req.params.name]||images.monitor}</svg>`));
app.use(createApp(db,config,{verifyGoogle:async t=>identity(t)}));
let fixtureBusy=false;
const fixtureTimer=setInterval(async()=>{if(fixtureBusy)return;fixtureBusy=true;try{const runs=(await db.query("SELECT r.id,r.marketplace_id,m.name AS marketplace_name,i.payload FROM extension_catalog_runs r JOIN marketplaces m ON m.id=r.marketplace_id JOIN extension_catalog_items i ON i.run_id=r.id WHERE r.status='queued' AND r.step IN ('preview','selector_test')")).rows;for(const run of runs){const data={title:'Oferta de teste '+run.marketplace_name,priceCents:Number(/faixa-e2e-(\d+)/.exec(run.payload.url)?.[1]??32100),originalPriceCents:44750,description:'Descrição extraída em ambiente de teste.',category:'Tecnologia',conditions:'Confira as condições da oferta de teste.',externalId:'extracted-'+run.marketplace_id,productUrl:run.payload.url,images:[],specifications:[{name:'Cor',value:'Preto'}],warnings:['Dados fictícios usados somente em testes.'],missing:[],evidence:[{field:'title',selector:'#productTitle'}],collectedAt:new Date().toISOString()};await finishManualFixture(db,run.id,data);}}finally{fixtureBusy=false;}},250);
const server=app.listen(Number(process.env.E2E_PORT||3000),'127.0.0.1',(error)=>{if(error){console.error('E2E server failed to bind');process.exit(1);}console.log('E2E_TEST_SERVER_READY');});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(fixtureTimer);server.close(async()=>{await db.end();process.exit();});});
