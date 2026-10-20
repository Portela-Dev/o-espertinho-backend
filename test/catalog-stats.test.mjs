import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {catalogFixture} from './catalog-helpers.mjs';
import {seedOffer} from './helpers.mjs';

test('marketplace counters match conversion/enrichment eligibility and successful 24h price checks',async t=>{
 const f=await catalogFixture(t);
 await f.db.query("UPDATE marketplaces SET scraping_enabled=true WHERE id IN ('amazon','mercadolivre')");
 const old=await seedOffer(f.db),fresh=await seedOffer(f.db),boundary=await seedOffer(f.db);
 await seedOffer(f.db,{marketplace:'mercadolivre'});await seedOffer(f.db,{status:'pending'});await seedOffer(f.db,{status:'expired'});
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '25 hours',refresh_status='pending',last_refresh_attempt_at=clock_timestamp() WHERE id=$1",[old]);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '23 hours' WHERE id=$1",[fresh]);
 await f.db.query("UPDATE offers SET data_updated_at=clock_timestamp()-interval '24 hours' WHERE id=$1",[boundary]);
 const insert=async({market='amazon',affiliate=null,status='pending',extraction='pending',offer=null}={})=>f.db.query('INSERT INTO discovery_links(id,marketplace_id,url,status,affiliate_url,extraction_status,published_offer_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),market,'https://www.amazon.com.br/product/'+randomUUID(),status,affiliate,extraction,offer]);
 await insert();await insert({affiliate:'https://link.amazon/pending'});await insert({affiliate:'https://link.amazon/failed',extraction:'failed'});await insert({affiliate:'https://link.amazon/complete',extraction:'completed'});await insert({affiliate:'https://link.amazon/published',extraction:'completed',offer:old});await insert({status:'archived'});await insert({market:'mercadolivre'});
 const result=await f.call('get','/catalog/stats?marketplaceId=amazon&retryFailed=false');assert.equal(result.status,200,JSON.stringify(result.body));
 assert.deepEqual(result.body.convert,{pending:1,completed:4,total:5});assert.deepEqual(result.body.enrich,{pending:1,completed:2,total:5});assert.deepEqual(result.body.prices,{pending:2,total:3});
 assert.equal(result.body.marketplaceId,'amazon');assert.ok(Date.parse(result.body.observedAt));
 const retry=await f.call('get','/catalog/stats?marketplaceId=amazon&retryFailed=true');assert.deepEqual(retry.body.enrich,{pending:2,completed:2,total:5});
 const other=await f.call('get','/catalog/stats?marketplaceId=mercadolivre');assert.deepEqual(other.body.convert,{pending:1,completed:0,total:1});assert.deepEqual(other.body.enrich,{pending:0,completed:0,total:1});assert.deepEqual(other.body.prices,{pending:0,total:1});
 assert.equal((await f.call('get','/catalog/stats?marketplaceId=missing')).status,404);
 assert.equal((await f.call('get','/catalog/stats?marketplaceId=amazon&retryFailed=garbage')).status,400);
 await f.db.query("UPDATE access_profiles SET permissions=ARRAY['affiliate_links'] WHERE id='admin'");
 const restricted=await f.call('get','/catalog/stats?marketplaceId=amazon');assert.equal(restricted.status,200);assert.equal(restricted.body.enrich,null);assert.equal(restricted.body.prices,null);
 await f.db.query('UPDATE users SET blocked=true WHERE id=$1',[f.auth.user.id]);assert.equal((await f.call('get','/catalog/stats?marketplaceId=amazon')).status,401);
});
