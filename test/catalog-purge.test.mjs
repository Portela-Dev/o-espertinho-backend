import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {testDatabase,testConfig,client,createApp,identity,seedOffer,seedProduct} from './helpers.mjs';
import {previewPurge,executePurge} from '../dist/catalog-purge.js';
const base='/api/admin/purge';
async function fixture(t){const {db}=await testDatabase();t.after(()=>db.end());const app=createApp(db,testConfig(),{verifyGoogle:async token=>identity(token)}),admin=client(app),user=client(app);await admin.login('admin');await user.login('alice');return {db,app,admin,user};}
async function ageOffer(db,id,kind='unavailable',days=31){
 if(kind==='failure'){await db.query("UPDATE offers SET refresh_status='pending',last_refresh_error='Falha técnica' WHERE id=$1",[id]);await db.query("UPDATE offers SET failure_since=clock_timestamp()-$2*interval '1 day' WHERE id=$1",[id,days]);}
 else{await db.query("UPDATE offers SET availability_status='unavailable' WHERE id=$1",[id]);await db.query("UPDATE offers SET unavailable_since=clock_timestamp()-$2*interval '1 day' WHERE id=$1",[id,days]);}
}
async function discovery(db,extra={}){const id=randomUUID(),data={title:'Produto descoberto',availability:'available',...extra};await db.query("INSERT INTO discovery_links(id,marketplace_id,url,enrichment_data,extraction_status) VALUES($1,'amazon',$2,$3,'completed')",[id,'https://www.amazon.com.br/p/'+id,JSON.stringify(data)]);return id;}
const view=(a,criteria={})=>a.mutate('post',base+'/preview',criteria);
const execute=(a,p)=>a.mutate('post',base+'/execute',{previewToken:p.previewToken,confirmed:true});
test('expurgo respeita reservas ativas da catalogação atual sem ficar bloqueado por reservas expiradas',async t=>{
 const f=await fixture(t),run=randomUUID();
 const userId=(await f.db.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0].id;
 await f.db.query("INSERT INTO catalog_resolver_runs(id,request_key,created_by,extension_session_id,marketplace_id,task,mode,settings_version) VALUES($1,$2,$3,$4,'amazon','product','active',1)",[run,randomUUID(),userId,randomUUID()]);
 await f.db.query("INSERT INTO catalog_resolver_items(id,run_id,status,lease_until) VALUES($1,$2,'leased',clock_timestamp()+interval '1 minute')",[randomUUID(),run]);
 assert.equal((await view(f.admin)).status,409);
 await f.db.query("UPDATE catalog_resolver_items SET lease_until=clock_timestamp()-interval '1 second' WHERE run_id=$1",[run]);
 assert.equal((await view(f.admin)).status,200);
});

test('duração contínua é preservada entre tentativas, sucesso reinicia e produto conta a partir da última oferta removida',async t=>{
 const f=await fixture(t),id=await seedOffer(f.db);await ageOffer(f.db,id,'failure');
 let row=(await f.db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0],since=row.failure_since;
 await f.db.query("UPDATE offers SET last_refresh_error='Outra falha',last_refresh_attempt_at=clock_timestamp() WHERE id=$1",[id]);row=(await f.db.query('SELECT * FROM offers WHERE id=$1',[id])).rows[0];assert.deepEqual(row.failure_since,since);
 await f.db.query("UPDATE offers SET refresh_status='updated',last_refresh_error=NULL WHERE id=$1",[id]);assert.equal((await f.db.query('SELECT failure_since FROM offers WHERE id=$1',[id])).rows[0].failure_since,null);
 await ageOffer(f.db,id);since=(await f.db.query('SELECT unavailable_since FROM offers WHERE id=$1',[id])).rows[0].unavailable_since;
 await f.db.query("UPDATE offers SET availability_status='unavailable',data_updated_at=clock_timestamp() WHERE id=$1",[id]);assert.deepEqual((await f.db.query('SELECT unavailable_since FROM offers WHERE id=$1',[id])).rows[0].unavailable_since,since);
 const productId=row.product_id;assert.equal((await f.db.query('SELECT no_offers_since FROM products WHERE id=$1',[productId])).rows[0].no_offers_since,null);
 await f.db.query('DELETE FROM offers WHERE id=$1',[id]);const empty=(await f.db.query('SELECT no_offers_since FROM products WHERE id=$1',[productId])).rows[0].no_offers_since;assert.ok(Date.now()-Date.parse(empty)<10000);
 const newOffer=await seedOffer(f.db,{productId});assert.equal((await f.db.query('SELECT no_offers_since FROM products WHERE id=$1',[productId])).rows[0].no_offers_since,null);
 const target=await seedProduct(f.db);await f.db.query('UPDATE offers SET product_id=$2 WHERE id=$1',[newOffer,target]);assert.ok((await f.db.query('SELECT no_offers_since FROM products WHERE id=$1',[productId])).rows[0].no_offers_since);assert.equal((await f.db.query('SELECT no_offers_since FROM products WHERE id=$1',[target])).rows[0].no_offers_since,null);
});

test('prévia usa 30 dias por padrão, distingue falha de mera pendência e não remove produtos recém-esvaziados',async t=>{
 const f=await fixture(t),old=await seedOffer(f.db),failed=await seedOffer(f.db),fresh=await seedOffer(f.db),healthy=await seedOffer(f.db),neverChecked=await seedOffer(f.db);
 await ageOffer(f.db,old);await ageOffer(f.db,failed,'failure');await ageOffer(f.db,fresh,'unavailable',10);
 const empty=await seedProduct(f.db),recent=await seedProduct(f.db);await f.db.query("UPDATE products SET no_offers_since=clock_timestamp()-interval '31 days' WHERE id=$1",[empty]);
 const d=await discovery(f.db);await f.db.query("UPDATE discovery_links SET extraction_status='failed' WHERE id=$1",[d]);await f.db.query("UPDATE discovery_links SET failure_since=clock_timestamp()-interval '31 days' WHERE id=$1",[d]);
 const response=await view(f.admin);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.criteria.linksDays,30);assert.equal(response.body.criteria.productsDays,30);assert.equal(response.body.counts.offers,2);assert.equal(response.body.counts.products,1);assert.equal(response.body.counts.discoveredLinks,1);
 const done=await execute(f.admin,response.body);assert.equal(done.status,200,JSON.stringify(done.body));assert.equal((await f.db.query('SELECT id FROM products WHERE id=$1',[empty])).rows.length,0);
 for(const id of [fresh,healthy,neverChecked])assert.equal((await f.db.query('SELECT id FROM offers WHERE id=$1',[id])).rows.length,1);
 assert.equal((await f.db.query('SELECT id FROM products WHERE id=$1',[recent])).rows.length,1);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM products WHERE no_offers_since IS NOT NULL')).rows[0].n,3);
 assert.equal((await execute(f.admin,response.body)).status,409);
});

test('períodos independentes e opções links/produtos não ampliam a seleção',async t=>{
 const f=await fixture(t),offer=await seedOffer(f.db),p=await seedProduct(f.db);await ageOffer(f.db,offer,'unavailable',10);await f.db.query("UPDATE products SET no_offers_since=clock_timestamp()-interval '20 days' WHERE id=$1",[p]);
 let r=await view(f.admin,{links:true,products:false,linksDays:7,productsDays:1});assert.equal(r.body.counts.offers,1);assert.equal(r.body.counts.products,0);
 r=await view(f.admin,{links:false,products:true,linksDays:1,productsDays:15});assert.equal(r.body.counts.offers,0);assert.equal(r.body.counts.products,1);
 for(const input of [{links:false,products:false},{linksDays:0},{productsDays:1.5},{linksDays:3651},{ids:[offer]}])assert.equal((await view(f.admin,input)).status,400);
});

test('expurgo remove dependências físicas e preserva configurações, coleções e registros não relacionados',async t=>{
 const f=await fixture(t),offer=await seedOffer(f.db),keep=await seedOffer(f.db);await ageOffer(f.db,offer);const o=(await f.db.query('SELECT * FROM offers WHERE id=$1',[offer])).rows[0];
 const adminId=(await f.admin.init()).body.user.id,collection=randomUUID(),preview=randomUUID(),run=randomUUID(),item=randomUUID(),draft=randomUUID(),link=await discovery(f.db);
 await f.db.query("INSERT INTO collections(id,user_id,name) VALUES($1,$2,'Coleção preservada')",[collection,adminId]);
 await f.db.query('INSERT INTO favorites(user_id,offer_id) VALUES($1,$2)',[adminId,offer]);await f.db.query('INSERT INTO collection_items(collection_id,offer_id) VALUES($1,$2)',[collection,offer]);
 await f.db.query("INSERT INTO click_events(id,offer_id,marketplace_id,placement) VALUES($1,$2,'amazon','test')",[randomUUID(),offer]);
 await f.db.query("INSERT INTO offer_price_history(offer_id,product_id,day,price_cents,observed_at) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date,999,clock_timestamp())",[offer,o.product_id]);
 await f.db.query("INSERT INTO review_ai_product_drafts(id,identity_key,name,created_by) VALUES($1,$2,'Rascunho',$3)",[draft,randomUUID(),adminId]);
 await f.db.query('UPDATE discovery_links SET confirmed_category_id=(SELECT category_ids[cardinality(category_ids)] FROM products WHERE id=$2) WHERE id=$1',[link,o.product_id]);
 await f.db.query('UPDATE discovery_links SET published_offer_id=$2,product_id=$3,product_draft_id=$4 WHERE id=$1',[link,offer,o.product_id,draft]);
 await f.db.query("INSERT INTO review_ai_suggestions(link_id,task,request_id,link_version,settings_version,created_by,request_context,suggestion) VALUES($1,'product',$2,1,1,$3,'{}','{}')",[link,randomUUID(),adminId]);
 await f.db.query("INSERT INTO offer_import_previews(id,user_id,marketplace_id,affiliate_url,source_url,result,profile_version,expires_at,offer_id,product_id,product_updated_at) VALUES($1,$2,'amazon',$3,$3,'{}',1,clock_timestamp()+interval '1 day',$4,$5,clock_timestamp())",[preview,adminId,o.affiliate_url,offer,o.product_id]);
 await f.db.query("INSERT INTO extension_catalog_runs(id,marketplace_id,created_by,step,status,snapshot,request_key,expires_at) VALUES($1,'amazon',$2,'prices','completed','{}',$3,clock_timestamp()+interval '1 day')",[run,adminId,randomUUID()]);
 await f.db.query("INSERT INTO extension_catalog_items(id,run_id,target_id,payload,status) VALUES($1,$2,$3,'{}','completed')",[item,run,offer]);
 await f.db.query("INSERT INTO audit_logs(id,user_id,action,entity_id) VALUES($1,$2,'offer.updated',$3)",[randomUUID(),adminId,offer]);
 const legacyPrice=randomUUID(),legacyItem=randomUUID(),legacyEnrich=randomUUID();
 await f.db.query("INSERT INTO offer_refresh_runs(id,trigger,status) VALUES($1,'manual','completed')",[legacyPrice]);
 await f.db.query("INSERT INTO offer_refresh_items(id,run_id,offer_id,marketplace_id,expected_updated_at,status) VALUES($1,$2,$3,'amazon',clock_timestamp(),'done')",[legacyItem,legacyPrice,offer]);
 await f.db.query("INSERT INTO enrichment_runs(id,marketplace_id,status,snapshot,total,current_link_id) VALUES($1,'amazon','completed','{}',1,$2)",[legacyEnrich,link]);
 await f.db.query("INSERT INTO enrichment_items(run_id,link_id,status) VALUES($1,$2,'completed')",[legacyEnrich,link]);
 const p=await view(f.admin,{products:false});assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.body.counts.favorites,1);assert.equal(p.body.counts.discoveredLinks,1);
 const r=await execute(f.admin,p.body);assert.equal(r.status,200,JSON.stringify(r.body));
 for(const [table,column,id] of [['offers','id',offer],['discovery_links','id',link],['review_ai_product_drafts','id',draft],['review_ai_suggestions','link_id',link],['offer_import_previews','id',preview],['extension_catalog_items','id',item],['extension_catalog_runs','id',run],['favorites','offer_id',offer],['collection_items','offer_id',offer],['click_events','offer_id',offer],['offer_price_history','offer_id',offer],['audit_logs','entity_id',offer]])assert.equal((await f.db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`,[id])).rows.length,0,table);
 for(const [table,id] of [['offers',keep],['collections',collection],['products',o.product_id]])assert.equal((await f.db.query(`SELECT id FROM ${table} WHERE id=$1`,[id])).rows.length,1,table);
 for(const [table,id] of [['offer_refresh_items',legacyItem],['offer_refresh_runs',legacyPrice],['enrichment_runs',legacyEnrich]])assert.equal((await f.db.query(`SELECT id FROM ${table} WHERE id=$1`,[id])).rows.length,0,table);
 assert.equal((await f.db.query('SELECT 1 FROM enrichment_items WHERE link_id=$1',[link])).rows.length,0);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_logs WHERE action='catalog.purged'")).rows[0].n,1);
});

test('produto vazio remove revisões e prévias dependentes sem excluir ofertas de outro produto',async t=>{
 const f=await fixture(t),p=await seedProduct(f.db),l=await discovery(f.db),adminId=(await f.admin.init()).body.user.id;
 await f.db.query('UPDATE discovery_links SET confirmed_category_id=(SELECT category_ids[cardinality(category_ids)] FROM products WHERE id=$2) WHERE id=$1',[l,p]);
 await f.db.query('UPDATE discovery_links SET product_id=$2 WHERE id=$1',[l,p]);await f.db.query("UPDATE products SET no_offers_since=clock_timestamp()-interval '31 days' WHERE id=$1",[p]);
 const r=await view(f.admin,{links:false});assert.equal(r.body.counts.products,1);assert.equal(r.body.counts.discoveredLinks,1);assert.equal((await execute(f.admin,r.body)).status,200);assert.equal((await f.db.query('SELECT id FROM discovery_links WHERE id=$1',[l])).rows.length,0);assert.equal((await f.db.query('SELECT id FROM products WHERE id=$1',[p])).rows.length,0);assert.ok(adminId);
});

test('confirmação exige sessão, XSRF, permissão dedicada, reautenticação e prévia imutável',async t=>{
 const f=await fixture(t),id=await seedOffer(f.db);await ageOffer(f.db,id);const anon=client(f.app);await anon.init();assert.equal((await view(anon)).status,401);assert.equal((await view(f.user)).status,403);
 const user=(await f.user.init()).body.user;await f.db.query("UPDATE users SET access_profile_id='editor' WHERE id=$1",[user.id]);assert.equal((await view(f.user)).status,403);
 const r=await view(f.admin);assert.equal((await f.admin.mutate('post',base+'/execute',{previewToken:r.body.previewToken})).status,400);
 assert.equal((await f.admin.agent.post(base+'/execute').set('Origin','http://localhost:4200').send({previewToken:r.body.previewToken,confirmed:true})).status,403);
 assert.equal((await execute(f.admin,{previewToken:r.body.previewToken+'tampered'})).status,409);
 await f.db.query("UPDATE offers SET availability_status='available' WHERE id=$1",[id]);assert.equal((await execute(f.admin,r.body)).status,409);assert.equal((await f.db.query('SELECT id FROM offers WHERE id=$1',[id])).rows.length,1);
 await f.db.query("UPDATE sessions SET admin_verified_at=clock_timestamp()-interval '1 hour' WHERE user_id=(SELECT id FROM users WHERE role='admin' LIMIT 1)");assert.equal((await view(f.admin)).body.code,'ADMIN_REAUTH_REQUIRED');
});

test('reserva ativa impede expurgo e falha ao concluir auditoria desfaz exclusões',async t=>{
 const f=await fixture(t),id=await seedOffer(f.db);await ageOffer(f.db,id);const userId=(await f.admin.init()).body.user.id;
 const r=await view(f.admin),run=randomUUID();await f.db.query("INSERT INTO extension_catalog_runs(id,marketplace_id,created_by,step,snapshot,request_key,expires_at) VALUES($1,'amazon',$2,'prices','{}',$3,clock_timestamp()+interval '1 hour')",[run,userId,randomUUID()]);
 assert.equal((await execute(f.admin,r.body)).status,409);await f.db.query("UPDATE extension_catalog_runs SET status='cancelled' WHERE id=$1",[run]);
 const p=await view(f.admin);const real=f.db.query.bind(f.db);const faulty={...f.db,connect:async()=>{const c=await f.db.connect();return {...c,query:async(sql,args)=>{if(sql.startsWith('INSERT INTO audit_logs'))throw Error('Audit failure');return c.query(sql,args)}}}};
 const key=randomBytes(32).toString('base64'),preview=await previewPurge(f.db,key,userId,{});await assert.rejects(()=>executePurge(faulty,key,userId,{previewToken:preview.previewToken,confirmed:true}),/Audit failure/);assert.equal((await real('SELECT id FROM offers WHERE id=$1',[id])).rows.length,1);assert.equal(p.status,200);
});
