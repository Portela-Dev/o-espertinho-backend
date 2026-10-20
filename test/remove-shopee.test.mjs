import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {testDatabase,seedOffer,testConfig,client,createApp} from './helpers.mjs';

test('migration remove marketplace retirado e dependências, preserva outras lojas, produtos e fila mista',async t=>{
 const {db,pg}=await testDatabase({through:'011_offer_refresh_milliseconds.sql'});t.after(()=>db.end());
 const retired=await seedOffer(db,{marketplace:'shopee',affiliate:'https://shopee.com.br/product/1/2'}),kept=await seedOffer(db,{source:'scraped'}),admin='8b149af0-1050-4d83-8c88-bf4a64a54fbf';
 const product=(await db.query('SELECT product_id FROM offers WHERE id=$1',[retired])).rows[0].product_id;
 await db.query("UPDATE marketplaces SET credentials_encrypted='preserved-secret',configuration='{\"other\":true}' WHERE id='amazon'");
 const col=randomUUID();await db.query("INSERT INTO collections(id,user_id,name) VALUES($1,$2,'Coleção')",[col,admin]);
 for(const id of [retired,kept]){await db.query('INSERT INTO favorites(user_id,offer_id) VALUES($1,$2)',[admin,id]);await db.query('INSERT INTO collection_items(collection_id,offer_id) VALUES($1,$2)',[col,id]);}
 await db.query("INSERT INTO click_events(id,offer_id,marketplace_id,placement) VALUES($1,$2,'shopee','detail')",[randomUUID(),retired]);
 await db.query("INSERT INTO saved_filters(id,user_id,name,filters) VALUES($1,$2,'Filtro','{\"marketplace\":\"shopee\"}')",[randomUUID(),admin]);
 await db.query("INSERT INTO audit_logs(id,action,entity_id) VALUES($1,'offer.created',$2)",[randomUUID(),retired]);
 const run={id:randomUUID()};await db.query("INSERT INTO offer_refresh_runs(id,trigger,created_by,total) VALUES($1,'manual',$2,2)",[run.id,admin]);for(const id of [retired,kept])await db.query('INSERT INTO offer_refresh_items(id,run_id,offer_id,marketplace_id,expected_updated_at) SELECT $1,$2,id,marketplace_id,updated_at FROM offers WHERE id=$3',[randomUUID(),run.id,id]);await db.query("UPDATE offer_refresh_items SET status='done',outcome='updated' WHERE offer_id=$1",[retired]);
 await pg.exec(await readFile(new URL('../migrations/012_remove_shopee.sql',import.meta.url),'utf8'));
 assert.equal((await db.query("SELECT count(*)::int n FROM marketplaces WHERE id='shopee'")).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM offers')).rows[0].n,1);assert.equal((await db.query('SELECT id FROM offers')).rows[0].id,kept);
 for(const table of ['favorites','collection_items','offer_refresh_items'])assert.equal((await db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,1);
 for(const table of ['click_events','saved_filters'])assert.equal((await db.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1',[retired])).rows[0].n,0);
 assert.equal((await db.query('SELECT id FROM products WHERE id=$1',[product])).rows.length,1);
 const remaining=(await db.query('SELECT * FROM offer_refresh_runs WHERE id=$1',[run.id])).rows[0];assert.equal(remaining.total,1);assert.equal(remaining.processed,0);assert.equal(remaining.updated,0);assert.equal(remaining.status,'queued');
 const market=(await db.query("SELECT * FROM marketplaces WHERE id='amazon'")).rows[0];assert.equal(market.credentials_encrypted,'preserved-secret');assert.deepEqual(market.configuration,{other:true});
});

test('API pública omite marketplace retirado; rotas dos conversores não existem mais',async t=>{
 const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig()),visitor=client(app);
 assert.deepEqual((await visitor.get('/api/marketplaces')).body.map(m=>m.id).sort(),['amazon','mercadolivre']);
 const spec=(await visitor.get('/api/openapi.json')).body;assert.ok(!Object.keys(spec.paths).some(p=>p.includes('link-converters')));
});
