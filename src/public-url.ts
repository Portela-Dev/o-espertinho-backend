import {isIP} from 'node:net';
import {z} from 'zod';

/** Syntactic public-host policy; no DNS lookup or outbound request is performed. */
export function publicHostname(host:string){
 if(host!==host.toLowerCase()||isIP(host)||host.length>253||!host.includes('.')||/(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid)$/.test(host)||host==='home.arpa'||host.endsWith('.home.arpa'))return false;
 return host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
export function isPublicHttpsUrl(value:string){
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&publicHostname(url.hostname);}catch{return false;}
}
export const publicHttpsUrlSchema=z.url().max(2000).refine(isPublicHttpsUrl,'Use uma URL HTTPS de domínio público, sem credenciais ou porta personalizada.');
export function isHttpOrigin(value:string){
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash;}catch{return false;}
}
