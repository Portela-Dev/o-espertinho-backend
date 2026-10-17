import type {Express} from 'express';
import {z} from 'zod';
import type {Database} from './db.js';
import {HttpError} from './security.js';
type Queryable=Pick<Database,'query'>;
export const PRICE_HISTORY_ZONE='America/Sao_Paulo';
const dayMs=86400000;
export const dayString=(date:Date)=>date.toISOString().slice(0,10);
const epoch=(day:string)=>Date.parse(day+'T00:00:00Z');
export function historyInterval(days:number){return days<=31?1:days<=60?5:days<=120?10:days<=180?15:30;}
// Called in the same transaction that updates the offer. NULL means confirmed unavailability.
export async function recordDailyPrice(db:Queryable,offerId:string,productId:string,price:number|null,observedAt?:string){
 await db.query(`INSERT INTO offer_price_history(offer_id,product_id,day,price_cents,observed_at)
 SELECT $1,$2,(stamp AT TIME ZONE 'America/Sao_Paulo')::date,$3,stamp FROM (SELECT COALESCE($4::timestamptz,clock_timestamp()) AS stamp) t
 ON CONFLICT(offer_id,day) DO UPDATE SET product_id=EXCLUDED.product_id,price_cents=EXCLUDED.price_cents,observed_at=EXCLUDED.observed_at
 WHERE offer_price_history.observed_at<=EXCLUDED.observed_at`,[offerId,productId,price,observedAt??null]);
}
export interface DailyPrice {date:string;priceCents:number|null}
export interface HistoryPoint extends DailyPrice {observedDate:string|null}
// Pick the latest observed day in each interval, after finding the daily minimum across links.
// Empty intervals and confirmed unavailability remain gaps; neither zero nor stale carry-forward prices.
export function sampleHistory(daily:DailyPrice[],start:string,end:string,step:number):HistoryPoint[]{
 const points:HistoryPoint[]=[];const startMs=epoch(start),endMs=epoch(end);
 for(let at=startMs;at<=endMs;at+=step*dayMs){
  const until=Math.min(at+(step-1)*dayMs,endMs),date=dayString(new Date(until));
  const records=daily.filter(p=>epoch(p.date)>=at&&epoch(p.date)<=until);const last=records.at(-1);
  points.push({date,observedDate:last?.date??null,priceCents:last?.priceCents??null});
 }
 return points;
}
const querySchema=z.object({kind:z.enum(['product','offer']),ids:z.string().max(1800).transform(s=>s.split(',')).pipe(z.array(z.uuid()).min(1).max(48)),days:z.coerce.number().int().min(1).max(365).default(90),from:z.iso.date().optional(),to:z.iso.date().optional(),details:z.enum(['true','false']).default('false')}).refine(q=>!!q.from===!!q.to,{message:'Informe início e fim do período.'});
export function registerPriceHistory(app:Express,db:Database){
 app.get('/api/price-history',async(req,res)=>{
  const q=querySchema.parse(req.query);
  const today=(await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS day")).rows[0].day;
  const end=q.to??today,start=q.from??dayString(new Date(epoch(end)-(q.days-1)*dayMs));
  const days=Math.round((epoch(end)-epoch(start))/dayMs)+1;
  if(days<1||days>365||end>today)throw new HttpError(400,'Escolha um período de até 365 dias, sem datas futuras.');
  const ids=[...new Set(q.ids)],intervalDays=historyInterval(days);
  const visible=q.kind==='product'
   ?(await db.query('SELECT id,id AS product_id FROM products WHERE id=ANY($1::uuid[])',[ids])).rows
   :(await db.query("SELECT o.id,o.product_id,(o.status='published' AND o.availability_status='available' AND o.price_cents=(SELECT min(other.price_cents) FROM offers other WHERE other.product_id=o.product_id AND other.status='published' AND other.availability_status='available' AND other.affiliate_url IS NOT NULL)) AS \"isCheapestOffer\" FROM offers o WHERE o.id=ANY($1::uuid[]) AND o.status IN ('published','expired') AND o.affiliate_url IS NOT NULL",[ids])).rows;
  const allowed=visible.map(r=>r.id);
  // The ribbon always compares the product across all monitored links over the last 90 days,
  // independent of the chart's chosen period and the individual link's own minimum.
  const productIds=[...new Set(visible.map(r=>r.product_id))];
  const productLows=productIds.length?(await db.query(`SELECT product_id,min(price_cents)::int AS price FROM offer_price_history WHERE product_id=ANY($1::uuid[]) AND day BETWEEN $2::date-89 AND $2::date GROUP BY product_id`,[productIds,today])).rows:[];
  // Both identifiers below come from an internal enum, never from user SQL.
  const key=q.kind==='product'?'product_id':'offer_id';
  const rows=allowed.length?(await db.query(`SELECT ${key} AS id,to_char(day,'YYYY-MM-DD') AS date,min(price_cents)::int AS "priceCents" FROM offer_price_history WHERE ${key}=ANY($1::uuid[]) AND day BETWEEN $2::date AND $3::date GROUP BY ${key},day ORDER BY day`,[allowed,start,end])).rows:[];
  const series=allowed.map(id=>{const daily:DailyPrice[]=rows.filter(r=>r.id===id).map(r=>({date:r.date,priceCents:r.priceCents}));const prices=daily.filter(p=>p.priceCents!==null).map(p=>p.priceCents!);return {id,productLowestPriceCents90d:productLows.find(r=>r.product_id===visible.find(v=>v.id===id)?.product_id)?.price??null,...(q.kind==='offer'?{isCheapestOffer:visible.find(r=>r.id===id)?.isCheapestOffer===true}:{}),lowestPriceCents:prices.length?Math.min(...prices):null,points:sampleHistory(daily,start,end,intervalDays),...(q.details==='true'?{daily}:{})};});
  res.set('Cache-Control','no-store').json({startDate:start,endDate:end,intervalDays,timeZone:PRICE_HISTORY_ZONE,aggregation:q.kind==='product'?'daily_minimum':'link_price',series});
 });
}
