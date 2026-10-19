import {z} from 'zod';
const selector=z.string().trim().max(600).default('');
const attribute=z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/).max(80);
const action=z.enum(['stop_section','skip_page','skip_item','pause_source']);
const failure=z.strictObject({action,retries:z.number().int().min(0).max(5),delayMs:z.number().int().min(100).max(3600000),backoffMultiplier:z.number().min(1).max(4)});
export const discoveryConfigSchema=z.strictObject({
 schemaVersion:z.literal(1),
 rendering:z.strictObject({waitUntil:z.enum(['domcontentloaded','load','networkidle']),readySelector:selector,frameSelector:selector,timeoutMs:z.number().int().min(1000).max(120000),settleDelayMs:z.number().int().min(0).max(30000)}),
 extraction:z.strictObject({itemSelector:selector,linkSelector:selector,linkAttribute:attribute,titleSelector:selector,priceSelector:selector,imageSelector:selector,imageAttribute:attribute,brandSelector:selector,descriptionSelector:selector,categorySelector:selector,categoryScope:z.enum(['page','item']),categorySeparator:z.string().min(1).max(10)}),
 pagination:z.strictObject({mode:z.enum(['single','next','url','load_more','scroll']),nextSelector:selector,previousSelector:selector,currentPageSelector:selector,totalPagesSelector:selector,disabledSelector:selector,endSelector:selector,urlTemplate:z.string().trim().max(4000),startPage:z.number().int().min(0).max(100000),pageStep:z.number().int().min(1).max(10000),scrollContainerSelector:selector,scrollStepPx:z.number().int().min(100).max(10000),waitAfterMs:z.number().int().min(100).max(60000),noProgressLimit:z.number().int().min(1).max(20),missingNextAction:z.enum(['finish','failure'])}),
 limits:z.strictObject({maxPages:z.number().int().min(1).max(1000),maxItems:z.number().int().min(1).max(100000),maxDurationSeconds:z.number().int().min(60).max(86400),requestIntervalMs:z.number().int().min(100).max(600000),deduplicate:z.literal(true),stopOnRepeatedPage:z.literal(true)}),
 failures:z.strictObject({navigation:failure,timeout:failure,blocked:failure,emptyPage:failure,invalidItem:failure,pagination:failure,limitReached:z.enum(['finish','pause_source'])})
}).superRefine((v,ctx)=>{
 const issue=(path:(string|number)[],message:string)=>ctx.addIssue({code:'custom',path,message});
 if(!v.extraction.itemSelector)issue(['extraction','itemSelector'],'Informe o seletor dos itens da listagem.');
 if(!v.extraction.linkSelector)issue(['extraction','linkSelector'],'Informe o seletor do link dentro de cada item.');
 if(['next','load_more'].includes(v.pagination.mode)&&!v.pagination.nextSelector)issue(['pagination','nextSelector'],'Informe o seletor do botão ou link de avanço.');
 if(v.pagination.mode==='url'&&!v.pagination.urlTemplate.includes('{page}'))issue(['pagination','urlTemplate'],'A URL deve conter {page}.');
 for(const [key,rule] of Object.entries(v.failures)){
  if(typeof rule==='string')continue;
  if(rule.action==='skip_page'&&v.pagination.mode!=='url')issue(['failures',key,'action'],'Pular página exige paginação por URL para avançar sem depender da página atual.');
  if(rule.action==='skip_item'&&key!=='invalidItem')issue(['failures',key,'action'],'Pular item é permitido apenas para itens inválidos.');
 }
});
export type DiscoveryConfig=z.infer<typeof discoveryConfigSchema>;
export function defaultDiscoveryConfig():DiscoveryConfig{
 const failure=(action:'stop_section'|'skip_item'|'pause_source',retries=0)=>({action,retries,delayMs:5000,backoffMultiplier:2});
 return {schemaVersion:1,rendering:{waitUntil:'domcontentloaded',readySelector:'',frameSelector:'',timeoutMs:30000,settleDelayMs:1000},extraction:{itemSelector:'',linkSelector:'a[href]',linkAttribute:'href',titleSelector:'',priceSelector:'',imageSelector:'img',imageAttribute:'src',brandSelector:'',descriptionSelector:'',categorySelector:'',categoryScope:'page',categorySeparator:'>'},pagination:{mode:'single',nextSelector:'',previousSelector:'',currentPageSelector:'',totalPagesSelector:'',disabledSelector:'',endSelector:'',urlTemplate:'',startPage:1,pageStep:1,scrollContainerSelector:'',scrollStepPx:800,waitAfterMs:1500,noProgressLimit:2,missingNextAction:'finish'},limits:{maxPages:100,maxItems:10000,maxDurationSeconds:3600,requestIntervalMs:2000,deduplicate:true,stopOnRepeatedPage:true},failures:{navigation:failure('stop_section',2),timeout:failure('stop_section',2),blocked:failure('pause_source'),emptyPage:failure('stop_section'),invalidItem:failure('skip_item'),pagination:failure('stop_section',1),limitReached:'finish'}};
}
export const discoveryProfileInput=z.strictObject({marketplaceId:z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),name:z.string().trim().min(1).max(120),config:discoveryConfigSchema});
export const discoverySourceInput=z.strictObject({marketplaceId:z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/),profileId:z.uuid(),name:z.string().trim().min(1).max(120),url:z.string().trim().max(4000),sourceCategoryPath:z.array(z.string().trim().min(1).max(120)).max(30).default([]),enabled:z.boolean().default(false),intervalHours:z.number().int().min(1).max(168).default(24),notes:z.string().trim().max(2000).default('')});
