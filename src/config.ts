import 'dotenv/config';
import { z } from 'zod';
import {isHttpOrigin,isPublicHttpsUrl} from './public-url.js';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.enum(['127.0.0.1','0.0.0.0']).default('127.0.0.1'),
  TRUST_PROXY: z.enum(['loopback','loopback,uniquelocal']).default('loopback'),
  APP_ORIGIN: z.url().max(2000).refine(isHttpOrigin,'APP_ORIGIN deve ser uma origem HTTP(S), sem caminho, credenciais, query ou fragmento.').default('http://localhost:4200'),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().default(''), RUN_WORKER: z.string().default('true'),
  EXTENSION_BACKEND_URL: z.url().max(2000).refine(isHttpOrigin,'EXTENSION_BACKEND_URL deve ser uma origem HTTP(S), sem caminho, credenciais, query ou fragmento.').default('http://localhost:3000'),
  WORKER_INTERVAL_SECONDS: z.coerce.number().min(30).default(60)
}).superRefine((config,ctx)=>{
 if(config.NODE_ENV!=='production')return;
 for(const field of ['APP_ORIGIN','EXTENSION_BACKEND_URL'] as const){
  if(!isPublicHttpsUrl(config[field]))ctx.addIssue({code:'custom',path:[field],message:field+' deve ser configurada explicitamente como origem HTTPS de domínio público em produção.'});
 }
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(): Config {
  const config = envSchema.parse(process.env);
  return {...config,APP_ORIGIN:new URL(config.APP_ORIGIN).origin,EXTENSION_BACKEND_URL:new URL(config.EXTENSION_BACKEND_URL).origin};
}
