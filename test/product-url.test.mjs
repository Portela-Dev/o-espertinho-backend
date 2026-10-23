import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {productUrl} from '../dist/product-url.js';
import {randomUUID} from 'node:crypto';
import {testDatabase,seedOffer,client,createApp,testConfig,identity} from './helpers.mjs';
test('product destination strips every query and fragment and preserves the path',()=>{
 assert.equal(productUrl('https://loja.example.com/p?item=123&tag=abc#details'),'https://loja.example.com/p');
 assert.equal(productUrl('https://loja.example.com/p'),'https://loja.example.com/p');
 assert.throws(()=>productUrl('invalid'));
});
test('migration cleans existing destinations, new writes and updates without altering affiliate links',async t=>{
 const {db,pg}=await testDatabase({through:'020z'});t.after(()=>db.end());
 const id=await seedOffer(db);const before=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];
 const admin=client(createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)}));await admin.login('admin');
 const user=(await db.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0];
 const preview=randomUUID(),source='https://www.amazon.com.br/product?any=value#part';
 await db.query('INSERT INTO offer_import_previews(id,user_id,marketplace_id,affiliate_url,source_url,result,profile_version,expires_at,product_id,product_updated_at) VALUES($1,$2,$3,$4,$5,$6,1,now(),$7,now())',[preview,user.id,'amazon',before.affiliate_url,source,JSON.stringify({productUrl:source,title:'Product'}),before.product_id]);
 await pg.exec(await readFile(new URL('../migrations/021_product_urls_without_query.sql',import.meta.url),'utf8'));
 let saved=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];
 assert.equal(saved.product_url,productUrl(before.product_url));assert.equal(saved.affiliate_url,before.affiliate_url);assert.equal(saved.updated_at.getTime(),before.updated_at.getTime());
 await db.query('UPDATE offers SET product_url=$2 WHERE id=$1',[id,'https://www.amazon.com.br/product?anything=value#part']);
 saved=(await db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];assert.equal(saved.product_url,'https://www.amazon.com.br/product');assert.equal(saved.affiliate_url,before.affiliate_url);
 let p=(await db.query('SELECT * FROM offer_import_previews WHERE id=$1',[preview])).rows[0];assert.equal(p.source_url,productUrl(source));assert.equal(p.result.productUrl,productUrl(source));assert.equal(p.affiliate_url,before.affiliate_url);assert.equal(p.result.title,'Product');
 await db.query('UPDATE offer_import_previews SET source_url=$2,result=$3 WHERE id=$1',[preview,source,JSON.stringify({productUrl:source})]);
 p=(await db.query('SELECT * FROM offer_import_previews WHERE id=$1',[preview])).rows[0];assert.equal(p.source_url,productUrl(source));assert.equal(p.result.productUrl,productUrl(source));
 const next=await seedOffer(db);saved=(await db.query('SELECT * FROM offers WHERE id=$1',[next])).rows[0];assert.equal(saved.product_url,productUrl(saved.affiliate_url));assert.ok(saved.affiliate_url.includes('?'));
});
