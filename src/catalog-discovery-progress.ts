import type {Database} from './db.js';
import type {ResultValue} from './catalog-results.js';
import {hash,HttpError} from './security.js';
import {marketUrl} from './scraping.js';
import {normalizeProductUrl} from './url-normalization.js';

export async function discoveryProgress(c:Pick<Database,'query'>,item:any,market:any,v:ResultValue){
 const config=item.payload.config,previous=item.payload.checkpoint;
 const entries=new Map<string,string>();
 for(const raw of v.links!){const url=normalizeProductUrl(marketUrl(raw,market.allowed_hosts),market.url_normalization_rules??[]);entries.set(hash(url),url);}
 const keys=[...entries.keys()];
 const known=new Set<string>((await c.query('SELECT url_key FROM extension_catalog_discovery_seen WHERE item_id=$1 AND url_key=ANY($2::text[])',[item.id,keys])).rows.map(r=>r.url_key));
 const count=Number((await c.query('SELECT count(*) AS total FROM extension_catalog_discovery_seen WHERE item_id=$1',[item.id])).rows[0].total);
 const fresh=keys.filter(key=>!known.has(key)).slice(0,Math.max(0,config.limits.maxItems-count));
 await c.query('INSERT INTO extension_catalog_discovery_seen(item_id,url_key) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',[item.id,fresh]);
 const accepted=new Set([...known,...fresh]),found=count+fresh.length;
 v.links=keys.filter(key=>accepted.has(key)).map(key=>entries.get(key)!);
 const checkpoint:NonNullable<ResultValue['checkpoint']>=v.checkpoint??{url:item.payload.url,page:1,seen:[],found:0,noProgress:0};
 let stable=fresh.length===0;
 if(config.pagination.mode==='scroll'){
  const scroll=checkpoint.scroll;
  if(config.pagination.scrollStrategy==='bottom'&&!scroll)throw new HttpError(400,'Informe a posição de rolagem da página.');
  stable=stable&&!!scroll&&scroll.viewport>0&&scroll.position+scroll.viewport>=scroll.height-2&&previous?.scroll?.height===scroll.height;
 }
 const noProgress=stable?(previous?.noProgress??0)+1:0;
 v.checkpoint={...checkpoint,found,noProgress};
 v.done=v.done||checkpoint.page>=config.limits.maxPages||found>=config.limits.maxItems||noProgress>=config.pagination.noProgressLimit;
}
