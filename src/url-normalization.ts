import {z} from 'zod';
export const urlNormalizationRulesSchema=z.array(z.strictObject({
 type:z.literal('remove_path_suffix'),
 marker:z.string().trim().min(2).max(120).refine(value=>value.startsWith('/')&&!/[\s?#\\]/u.test(value),'Informe um trecho literal do caminho, começando por /, sem query, fragmento ou espaços.')
})).max(20);
export type UrlNormalizationRule=z.infer<typeof urlNormalizationRulesSchema>[number];
/** Applies only to product destinations, never to affiliate or listing URLs. */
export function normalizeProductUrl(value:string,rules:UrlNormalizationRule[]=[]){
 const parsed=urlNormalizationRulesSchema.parse(rules),url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('Use uma URL HTTPS pública sem credenciais ou porta personalizada.');
 url.search='';url.hash='';
 for(const rule of parsed){
  const index=url.pathname.indexOf(rule.marker);
  if(index===0)throw new Error('A regra removeria todo o caminho do produto. Use um marcador mais específico.');
  if(index>0)url.pathname=url.pathname.slice(0,index);
 }
 if(url.href.length>4000)throw new Error('URL do produto muito longa.');
 return url.href;
}
