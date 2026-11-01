import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function setup(f) {
  await f.db.query("UPDATE catalog_resolver_settings SET mode='active'");
  await f.db.query("UPDATE review_ai_settings SET product_enabled=true,category_enabled=true");
}
export async function link(f,data,extra={}) {
  const id=randomUUID();
  await f.db.query("INSERT INTO discovery_links(id,marketplace_id,url,affiliate_url,extraction_status,enrichment_data,source_category_path) VALUES($1,'amazon',$2,$2,$3,$4,$5)",
    [id,'https://www.amazon.com.br/Produto-'+id,extra.status??'completed',JSON.stringify(data),extra.path??[]]);
  return id;
}
export async function drive(f,task,decision) {
  const start=await f.call('post','/catalog/resolver/start',{marketplaceId:'amazon',task,limit:100,requestKey:randomUUID()});
  assert.equal(start.status,200,JSON.stringify(start.body));
  let steps=0;
  while(steps++<100) {
    const response=await f.call('post','/catalog/resolver/claim',{runId:start.body.id});
    assert.equal(response.status,200,JSON.stringify(response.body));
    if(response.body.run.status==='completed') return response.body.run;
    const item=response.body.item;
    if(!item) continue;
    const payload={runId:start.body.id,itemId:item.id,leaseId:item.leaseId,...decision(item)};
    const complete=await f.call('post','/catalog/resolver/complete',payload);
    assert.equal(complete.status,200,JSON.stringify(complete.body));
    const replay=await f.call('post','/catalog/resolver/complete',payload);
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.deepEqual(replay.body,complete.body);
  }
  assert.fail('A fila não concluiu dentro do número esperado de etapas');
}
