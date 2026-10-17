import {z} from 'zod';
import {HttpError} from './security.js';
import {marketUrl,type OfferExtractor,type ScrapingMarket,type ScrapingProfile} from './scraping.js';

const dataSchema=z.object({title:z.string().max(300),priceCents:z.number().int().positive().max(100000000).nullable(),originalPriceCents:z.number().int().positive().max(100000000).nullable(),description:z.string().max(4000),category:z.string().max(80),conditions:z.string().max(1500),externalId:z.string().max(100),productUrl:z.url().max(10000),images:z.array(z.url()).max(12),specifications:z.array(z.object({name:z.string().max(150),value:z.string().max(600)})).max(80),warnings:z.array(z.string()).max(1000),missing:z.array(z.string()).max(40),evidence:z.array(z.object({field:z.string(),selector:z.string().max(600)})).max(600),collectedAt:z.iso.datetime()});

export class RemoteOfferExtractor implements OfferExtractor {
 private endpoint:string;
 constructor(url:string,private token:string,private transport:typeof fetch=fetch){
  const base=new URL(url);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('SCRAPER_SERVICE_URL deve ser uma origem HTTP(S), sem caminho, usuário ou senha.');
  if(token.length<32)throw new Error('Configure EXTRACTION_SERVICE_TOKEN para usar a extração remota.');this.endpoint=new URL('/extract',base).href;
 }
 async extract(url:string,market:ScrapingMarket,profile:ScrapingProfile){
  marketUrl(url,market.allowed_hosts);
  try{
   const response=await this.transport(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+this.token},body:JSON.stringify({url,market,profile}),signal:AbortSignal.timeout(115000),redirect:'error'});
   if(!response.ok){
    if(response.status===401||response.status===403)throw new HttpError(502,'O serviço de extração recusou a autenticação. Confira EXTRACTION_SERVICE_TOKEN.');
    const body=await response.json().catch(()=>null) as {error?:unknown}|null;
    if([400,422,429,502,504].includes(response.status)&&typeof body?.error==='string')throw new HttpError(response.status,body.error.slice(0,600));
    throw new HttpError(502,'Serviço de extração indisponível. Confira o container.');
   }
   const parsed=dataSchema.safeParse(await response.json());if(!parsed.success)throw new HttpError(502,'O serviço de extração retornou dados inválidos.');
   marketUrl(parsed.data.productUrl,market.allowed_hosts);return parsed.data;
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'Não foi possível consultar o serviço de extração. Confira o container, a URL e a conexão.');}
 }
}
