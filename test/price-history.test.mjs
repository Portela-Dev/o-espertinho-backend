import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {testDatabase,testConfig,identity,client,seedOffer,seedProduct,createApp} from './helpers.mjs';
import {recordDailyPrice,sampleHistory,historyInterval} from '../dist/price-history.js';
import {workerTick} from '../dist/offers.js';
let db,admin,visitor,config;
before(async()=>{({db}=await testDatabase());config=testConfig();const app=createApp(db,config,{verifyGoogle:async t=>identity(t)});admin=client(app);visitor=client(app);await admin.login('admin');await visitor.init();});
after(async()=>db.end());
const today=async()=> (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day")).rows[0].day;
const offset=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const observe=async(id,product,date,price)=>recordDailyPrice(db,id,product,price,date+'T15:00:00Z');

test('um registro por link/dia de Brasília: sobrescreve mesmo preço, respeita meia-noite e ignora observação atrasada',async()=>{
 const p=await seedProduct(db),id=await seedOffer(db,{productId:p});
 await db.query("SET TIME ZONE 'Asia/Tokyo'");
 await recordDailyPrice(db,id,p,10000,'2026-10-01T02:59:59Z');await recordDailyPrice(db,id,p,11000,'2026-10-01T03:00:00Z');await recordDailyPrice(db,id,p,12000,'2026-10-01T10:00:00Z');await recordDailyPrice(db,id,p,12000,'2026-10-01T11:00:00Z');await recordDailyPrice(db,id,p,5000,'2026-10-01T09:00:00Z');
 const rows=(await db.query("SELECT to_char(day,'YYYY-MM-DD') AS day,price_cents,observed_at FROM offer_price_history WHERE offer_id=$1 ORDER BY day",[id])).rows;
 assert.deepEqual(rows.map(r=>[r.day,r.price_cents]),[['2026-09-30',10000],['2026-10-01',12000]]);assert.equal(rows[1].observed_at.toISOString(),'2026-10-01T11:00:00.000Z');
 await assert.rejects(()=>recordDailyPrice(db,id,p,0,'2026-10-01T12:00:00Z'));await db.query("SET TIME ZONE 'UTC'");
});

test('amostragem de 90 dias tem nove pontos de dez dias; intervalos adaptam sem preencher lacunas',()=>{
 const points=sampleHistory([{date:'2026-01-02',priceCents:200},{date:'2026-01-09',priceCents:300},{date:'2026-03-31',priceCents:null}],'2026-01-01','2026-03-31',10);
 assert.equal(points.length,9);assert.deepEqual(points[0],{date:'2026-01-10',observedDate:'2026-01-09',priceCents:300});assert.deepEqual(points[1],{date:'2026-01-20',observedDate:null,priceCents:null});assert.equal(points.at(-1).observedDate,'2026-03-31');assert.equal(points.at(-1).priceCents,null);
 assert.deepEqual([7,30,60,90,180,365].map(historyInterval),[1,1,5,10,15,30]);assert.equal(sampleHistory([],'2026-01-01','2026-12-31',30).length,13);
});

test('API calcula mínimo diário por produto e respeita preço individual, períodos e privacidade de links',async()=>{
 const now=await today(),p=await seedProduct(db),a=await seedOffer(db,{productId:p}),b=await seedOffer(db,{productId:p,marketplace:'mercadolivre'}),first=offset(now,-89),latest=offset(first,8),second=offset(first,18);
 await observe(a,p,first,50000);await observe(b,p,first,20000);await observe(a,p,latest,45000);await observe(b,p,latest,35000);await observe(a,p,second,null);await observe(b,p,second,37000);await observe(a,p,now,null);await observe(b,p,now,null);
 const response=await visitor.get('/api/price-history?kind=product&ids='+p+'&details=true');assert.equal(response.status,200);const h=response.body,s=h.series[0];assert.equal(h.intervalDays,10);assert.equal(h.timeZone,'America/Sao_Paulo');assert.equal(s.points.length,9);assert.equal(s.lowestPriceCents,20000);assert.equal(s.points[0].priceCents,35000);assert.equal(s.points[0].observedDate,latest);assert.equal(s.points[1].priceCents,37000);assert.equal(s.points[2].priceCents,null);assert.equal(s.points.at(-1).priceCents,null);assert.deepEqual(s.daily.map(d=>d.priceCents),[20000,35000,37000,null]);
 const offer=(await visitor.get('/api/price-history?kind=offer&ids='+a)).body;assert.equal(offer.series[0].lowestPriceCents,45000);assert.equal(offer.series[0].points[0].priceCents,45000);assert.equal('daily' in offer.series[0],false);
 assert.equal((await visitor.get('/api/price-history?kind=product&ids='+p+'&days=365')).body.intervalDays,30);
 const custom=(await visitor.get('/api/price-history?kind=product&ids='+p+'&from='+latest+'&to='+second)).body;assert.equal(custom.intervalDays,1);assert.equal(custom.series[0].points.length,11);
 const pending=await seedOffer(db,{status:'pending'});assert.deepEqual((await visitor.get('/api/price-history?kind=offer&ids='+pending)).body.series,[]);
 for(const suffix of ['&days=366','&days=0','&from='+now,'&from='+now+'&to='+first,'&from='+now+'&to='+offset(now,1),'&from='+offset(now,-365)+'&to='+now])assert.equal((await visitor.get('/api/price-history?kind=product&ids='+p+suffix)).status,400);
 assert.equal((await visitor.get('/api/price-history?kind=product&ids=invalid')).status,400);assert.equal((await visitor.get('/api/price-history?kind=product&ids='+Array(49).fill(p).join(','))).status,400);
});

test('reassociação não move o histórico antigo para outro produto; exclusão do link remove suas observações',async()=>{
 const p=await seedProduct(db),other=await seedProduct(db),a=await seedOffer(db,{productId:p}),now=await today(),yesterday=offset(now,-1);
 await observe(a,p,yesterday,10000);await db.query('UPDATE offers SET product_id=$2 WHERE id=$1',[a,other]);await observe(a,other,now,20000);
 const history=async id=>(await visitor.get('/api/price-history?kind=product&ids='+id+'&details=true')).body.series[0].daily;
 assert.deepEqual(await history(p),[{date:yesterday,priceCents:10000}]);assert.deepEqual(await history(other),[{date:now,priceCents:20000}]);
 await db.query('DELETE FROM offers WHERE id=$1',[a]);assert.equal((await db.query('SELECT * FROM offer_price_history WHERE offer_id=$1',[a])).rows.length,0);
});

test('migration usa somente a última observação; manutenção atual retém 365 dias',async()=>{
 const {db:old,pg}=await testDatabase({through:'015_zz'});try{const id=await seedOffer(old),pending=await seedOffer(old,{status:'pending'});await pg.exec(await readFile(new URL('../migrations/016_daily_price_history.sql',import.meta.url),'utf8'));assert.equal((await old.query('SELECT * FROM offer_price_history WHERE offer_id=$1',[id])).rows.length,1);assert.equal((await old.query('SELECT * FROM offer_price_history WHERE offer_id=$1',[pending])).rows.length,0);
 const p=(await old.query('SELECT product_id FROM offers WHERE id=$1',[id])).rows[0].product_id,now=(await old.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day")).rows[0].day;
 await recordDailyPrice(old,id,p,10000,offset(now,-365)+'T15:00:00Z');await recordDailyPrice(old,id,p,11000,offset(now,-364)+'T15:00:00Z');assert.equal((await old.query('SELECT * FROM offer_price_history WHERE offer_id=$1',[id])).rows.length,3);
 // Maintenance runs against the current schema, after all migrations, never the historical fixture.
 const current=await seedOffer(db),product=(await db.query('SELECT product_id FROM offers WHERE id=$1',[current])).rows[0].product_id;
 await recordDailyPrice(db,current,product,10000,offset(now,-365)+'T15:00:00Z');await recordDailyPrice(db,current,product,11000,offset(now,-364)+'T15:00:00Z');await workerTick(db,config,{});
 const retained=(await db.query('SELECT price_cents FROM offer_price_history WHERE offer_id=$1',[current])).rows;assert.deepEqual(retained.map(r=>r.price_cents),[11000]);
 }finally{await old.end();}
});


test('tarja de link considera o menor preço atual entre ofertas públicas disponíveis do mesmo produto',async()=>{
 const p=await seedProduct(db),cheap=await seedOffer(db,{productId:p,price:20000}),expensive=await seedOffer(db,{productId:p,price:30000});await seedOffer(db,{productId:p,price:10000,status:'pending'});await seedOffer(db,{productId:p,price:12000,status:'expired'});await seedOffer(db,{productId:p,price:13000,availability:'unavailable'});
 const read=async()=>(await visitor.get('/api/price-history?kind=offer&ids='+cheap+','+expensive)).body.series;
 let series=await read();assert.equal(series.find(s=>s.id===cheap).isCheapestOffer,true);assert.equal(series.find(s=>s.id===expensive).isCheapestOffer,false);
 await db.query('UPDATE offers SET price_cents=20000 WHERE id=$1',[expensive]);series=await read();assert.equal(series.every(s=>s.isCheapestOffer),true);
 await db.query("UPDATE offers SET availability_status='unavailable' WHERE id=$1",[cheap]);series=await read();assert.equal(series.find(s=>s.id===cheap).isCheapestOffer,false);assert.equal(series.find(s=>s.id===expensive).isCheapestOffer,true);
});


test('tarja compara histórico global de 90 dias mesmo quando o link está no próprio mínimo e é o mais barato agora',async()=>{
 const p=await seedProduct(db),a=await seedOffer(db,{productId:p,price:25000}),b=await seedOffer(db,{productId:p,price:30000}),past=await seedOffer(db,{productId:p,price:20000,status:'expired'}),now=await today();
 await observe(a,p,offset(now,-1),30000);await observe(b,p,offset(now,-1),35000);await observe(past,p,offset(now,-30),20000);await observe(past,p,offset(now,-90),10000);
 let response=(await visitor.get('/api/price-history?kind=offer&ids='+a+','+b)).body;let offer=response.series.find(s=>s.id===a);assert.equal(offer.isCheapestOffer,true);assert.equal(offer.lowestPriceCents,30000);assert.equal(offer.productLowestPriceCents90d,20000);assert.ok(25000<=offer.lowestPriceCents&&25000>offer.productLowestPriceCents90d);
 const product=(await visitor.get('/api/price-history?kind=product&ids='+p)).body.series[0];assert.equal(product.productLowestPriceCents90d,20000);
 // Expanding to a year changes the chart, but never the ribbon's 90-day reference.
 response=(await visitor.get('/api/price-history?kind=offer&ids='+past+'&days=365')).body;assert.equal(response.series[0].lowestPriceCents,10000);assert.equal(response.series[0].productLowestPriceCents90d,20000);
 await db.query('UPDATE offers SET price_cents=20000 WHERE id=$1',[a]);offer=(await visitor.get('/api/price-history?kind=offer&ids='+a)).body.series[0];assert.equal(offer.isCheapestOffer,true);assert.equal(offer.productLowestPriceCents90d,20000);
 const empty=await seedProduct(db),noHistory=await seedOffer(db,{productId:empty});assert.equal((await visitor.get('/api/price-history?kind=offer&ids='+noHistory)).body.series[0].productLowestPriceCents90d,null);
});
