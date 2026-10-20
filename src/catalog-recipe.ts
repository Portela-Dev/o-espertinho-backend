import {z} from 'zod';
import {HttpError} from './security.js';
import {marketUrl} from './scraping.js';
const id=z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),headers=z.record(z.string().max(80),z.string().max(1000));
const step=z.discriminatedUnion('type',[
 z.strictObject({type:z.literal('extract'),name:z.string().regex(/^[a-zA-Z]\w{0,40}$/),source:z.enum(['dom','localStorage','sessionStorage','cookie','requestHeader']),selector:z.string().max(600).optional(),attribute:z.string().max(80).optional(),key:z.string().max(100).optional(),sourceUrl:z.url().max(2000).optional()}),
 z.strictObject({type:z.literal('request'),url:z.url().max(4000),method:z.enum(['GET','POST']),headers:headers.optional(),body:headers.optional(),bodyEncoding:z.enum(['json','form']).optional(),responsePath:z.string().regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/).max(200)}),
 z.strictObject({type:z.literal('fill'),selector:z.string().min(1).max(600),value:z.string().max(4000)}),
 z.strictObject({type:z.literal('click'),selector:z.string().min(1).max(600)})
]);
export const affiliateRecipe=z.strictObject({id,name:z.string().min(1).max(100),loginUrl:z.url(),allowedOrigins:z.array(z.url()).min(1).max(10),affiliateOrigins:z.array(z.url()).min(1).max(10),batchSize:z.number().int().min(1).max(10),intervalMs:z.number().int().min(100).max(600000),steps:z.array(step).min(1).max(15)});
type Recipe=z.infer<typeof affiliateRecipe>;
export function validateRecipe(recipe:Recipe,market:{id:string;allowed_hosts:string[]}){
 if(recipe.id!==market.id)throw new HttpError(400,'A receita deve pertencer ao marketplace selecionado.');
 for(const origin of [...recipe.allowedOrigins,...recipe.affiliateOrigins]){marketUrl(origin,market.allowed_hosts);if(new URL(origin).origin!==origin)throw new HttpError(400,'Cadastre somente origens HTTPS, sem caminho.');}
 marketUrl(recipe.loginUrl,market.allowed_hosts);if(!recipe.allowedOrigins.includes(new URL(recipe.loginUrl).origin))throw new HttpError(400,'Página de sessão fora das origens configuradas.');
 for(const s of recipe.steps){
  if(s.type==='extract'){
   if(['originalUrl','__proto__','constructor','prototype'].includes(s.name))throw new HttpError(400,'Nome de variável reservado.');
   if(s.source==='dom'&&!s.selector||s.source!=='dom'&&!s.key)throw new HttpError(400,'Configure a origem da variável.');
   if(s.source==='requestHeader'){
    if(!s.sourceUrl||!/^x-[\w-]+$/i.test(s.key!))throw new HttpError(400,'Configure somente um header X- e a URL exata da chamada de origem.');
    marketUrl(s.sourceUrl,market.allowed_hosts);if(!recipe.allowedOrigins.includes(new URL(s.sourceUrl).origin))throw new HttpError(400,'Origem do header não autorizada.');
   }
  }
  if(s.type==='request'){
   marketUrl(s.url,market.allowed_hosts);if(!recipe.allowedOrigins.includes(new URL(s.url).origin))throw new HttpError(400,'Destino de conversão não autorizado.');
   for(const [key,value] of Object.entries(s.headers??{})){if(/^(cookie|authorization|host|origin|referer|proxy-|sec-)/i.test(key))throw new HttpError(400,'Header reservado.');if(/^x-/i.test(key)&&!/^\{\{[a-zA-Z]\w*\}\}$/.test(value))throw new HttpError(400,'Headers de sessão devem usar variáveis locais, nunca valores fixos.');}
  }
 }
}
