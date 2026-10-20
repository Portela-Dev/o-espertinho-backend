import 'dotenv/config';
import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.enum(['127.0.0.1','0.0.0.0']).default('127.0.0.1'),
  TRUST_PROXY: z.enum(['loopback','loopback,uniquelocal']).default('loopback'),
  APP_ORIGIN: z.url().default('http://localhost:4200'),
  DATABASE_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().default(''), RUN_WORKER: z.string().default('true'),
  EXTENSION_BACKEND_URL: z.url().default('http://localhost:3000'),
  WORKER_INTERVAL_SECONDS: z.coerce.number().min(30).default(60)
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(): Config {
  const config = envSchema.parse(process.env);
  const extensionURL=new URL(config.EXTENSION_BACKEND_URL);
  if(!['http:','https:'].includes(extensionURL.protocol)||extensionURL.username||extensionURL.password||extensionURL.pathname!=='/'||extensionURL.search||extensionURL.hash)throw new Error('EXTENSION_BACKEND_URL deve ser uma origem HTTP(S).');
  if (config.NODE_ENV === 'production' && !config.APP_ORIGIN.startsWith('https://')) throw new Error('APP_ORIGIN deve usar HTTPS em produção.');
  return config;
}
