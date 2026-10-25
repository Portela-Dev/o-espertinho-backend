import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedOffer,client} from './helpers.mjs';

test('visão geral agrega cliques do período e publicadas atuais sem multiplicar contagens nem omitir zeros',async t=>{
 const f=await catalogFixture(t);
 await f.db.query("INSERT INTO marketplaces(id,name,website_url,allowed_hosts,logo_url) VALUES('loja_zero','Loja sem movimento','https://example.com',ARRAY['example.com'],'https://example.com/logo.png')");
 const a=await seedOffer(f.db),b=await seedOffer(f.db,{availability:'unavailable'}),m=await seedOffer(f.db,{marketplace:'mercadolivre'});
 for(const status of ['pending','expired','rejected'])await seedOffer(f.db,{status});
 await f.db.query("UPDATE offers SET published_at=clock_timestamp()-interval '100 days' WHERE id=ANY($1::uuid[])",[[a,b,m]]);
 const click=async(id,market,age)=>f.db.query("INSERT INTO click_events(id,offer_id,marketplace_id,placement,created_at) VALUES($1,$2,$3,'detail',clock_timestamp()-$4::int*interval '1 day')",[randomUUID(),id,market,age]);
 await click(a,'amazon',1);await click(a,'amazon',2);await click(b,'amazon',15);await click(m,'mercadolivre',1);await click(m,'mercadolivre',50);
 const seven=await f.browser.get('/api/admin/stats?days=7&paginate=true&pageSize=1');assert.equal(seven.status,200,JSON.stringify(seven.body));
 const markets=new Map(seven.body.marketplaces.map(row=>[row.id,row]));
 assert.equal(seven.body.totalClicks,3);assert.equal(markets.get('amazon').clicks,2);assert.equal(markets.get('amazon').publishedOffers,2);assert.equal(markets.get('mercadolivre').clicks,1);assert.equal(markets.get('mercadolivre').publishedOffers,1);
 assert.equal(markets.get('loja_zero').clicks,0);assert.equal(markets.get('loja_zero').publishedOffers,0);assert.equal(markets.get('loja_zero').logo_url,'https://example.com/logo.png');
 assert.equal(seven.body.marketplaces.reduce((sum,row)=>sum+row.publishedOffers,0),seven.body.offers.find(row=>row.status==='published').count);
 const thirty=await f.browser.get('/api/admin/stats?days=30');assert.equal(thirty.body.totalClicks,4);assert.equal(thirty.body.marketplaces.find(row=>row.id==='amazon').publishedOffers,2);
 assert.equal(thirty.body.marketplaces.find(row=>row.id==='amazon').clicks,3);
 const user=client(f.app);await user.login('alice');assert.equal((await user.get('/api/admin/stats')).status,403);
});
