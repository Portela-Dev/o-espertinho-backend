import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import request from 'supertest';
import {createApp} from '../dist/app.js';
export async function testDatabase({through='999'}={}) {
  const pg=new PGlite();
  for(const file of (await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')&&f<=through).sort())await pg.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const query=async(sql,args=[])=>{const r=await pg.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};};
  const db={query,connect:async()=>({query,release(){}}),end:()=>pg.close()};
  return {db,pg};
}
export const testConfig=()=>({NODE_ENV:'test',PORT:3000,APP_ORIGIN:'http://localhost:4200',DATABASE_URL:'unused-test-adapter',ENCRYPTION_KEY:randomBytes(32).toString('base64'),GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',RUN_WORKER:'false',WORKER_INTERVAL_SECONDS:60});
export function identity(token){if(token==='invalid')throw new Error('Invalid token');return {sub:'google-'+token,email:token==='admin'?'arnaldorolimportela@gmail.com':token+'@gmail.com',emailVerified:token!=='unverified',authoritative:true,name:'Pessoa '+token};}
export function client(app){
  const agent=request.agent(app);let csrf='';
  const update=(res)=>{for(const c of res.headers['set-cookie']??[])if(c.startsWith('XSRF-TOKEN='))csrf=decodeURIComponent(c.split(';')[0].split('=').slice(1).join('='));return res;};
  return {
    agent,get csrf(){return csrf;},
    async init(){return update(await agent.get('/api/auth/session'));},
    async login(token){await this.init();return update(await this.mutate('post','/api/auth/google',{credential:token}));},
    async mutate(method,url,body={}){return update(await agent[method](url).set('Origin','http://localhost:4200').set('X-XSRF-TOKEN',csrf).send(body));},
    async get(url){return agent.get(url);}
  };
}
export async function seedOffer(db,changes={}) {
  const id=randomUUID(),o={marketplace:'amazon',externalId:randomUUID(),title:'Monitor para escritório',price:99990,status:'published',source:'manual',availability:'available',affiliate:'https://www.amazon.com.br/dp/B012345678?tag=test-20&test='+randomUUID(),expires:new Date(Date.now()+3600000),...changes};
  const productId=o.productId??await seedProduct(db,{name:o.title});
  await db.query(`INSERT INTO offers(id,marketplace_id,external_id,title,product_url,affiliate_url,price_cents,original_price_cents,status,source,expires_at,published_at,category,product_id,availability_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),'Tecnologia',$12,$13)`,[id,o.marketplace,o.externalId,o.title,o.affiliate,o.affiliate,o.price,o.price+20000,o.status,o.source,o.expires,productId,o.availability]);return id;
}
export {createApp};

export async function seedProduct(db,changes={}){const id=randomUUID(),p={name:'Produto de teste',category:'Tecnologia',subcategory:'',...changes};await db.query('INSERT INTO products(id,name,category,subcategory) VALUES($1,$2,$3,$4)',[id,p.name,p.category,p.subcategory]);return id;}

export async function finishManualFixture(db,runId,data){
 const [{default:express},{registerCatalogRuns},{registerCatalogResults},{default:request}]=await Promise.all([import('express'),import('../dist/catalog-runs.js'),import('../dist/catalog-results.js'),import('supertest')]);
 const run=(await db.query('SELECT created_by FROM extension_catalog_runs WHERE id=$1',[runId])).rows[0];
 const actor={id:run.created_by,extension_id:'a'.repeat(32),permissions:['affiliate_links','catalog','selectors','discovery','updates']};
 const router=express();router.use(express.json());registerCatalogRuns(router,db,async()=>actor);registerCatalogResults(router,db,async()=>actor);
 router.use((err,_req,res,_next)=>res.status(err.status??400).json({error:err.message}));
 const item=(await request(router).post('/catalog/runs/'+runId+'/claim').send({})).body.item;
 return request(router).post('/catalog/runs/'+runId+'/results').send({itemId:item.id,leaseToken:item.lease_token,outcome:'success',data});
}
