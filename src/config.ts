import 'dotenv/config';
import { z } from 'zod';
export const envSchema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url().default('http://localhost:4200'),
  DATABASE_URL: z.string().min(1), ENCRYPTION_KEY: z.string().refine(v => Buffer.from(v,'base64').length === 32, 'Use uma chave base64 de 32 bytes'),
  MELI_REDIRECT_URI: z.string().default(''), MELI_OAUTH_PKCE: z.enum(['true','false']).default('false'),
  SCRAPER_SERVICE_URL: z.string().default(''), EXTRACTION_SERVICE_TOKEN: z.string().default(''),
  GOOGLE_CLIENT_ID: z.string().default(''), RUN_WORKER: z.string().default('true'),
  WORKER_INTERVAL_SECONDS: z.coerce.number().min(30).default(60)
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(): Config {
  const config = envSchema.parse(process.env);
  if (config.NODE_ENV === 'production' && !config.APP_ORIGIN.startsWith('https://')) throw new Error('APP_ORIGIN deve usar HTTPS em produção.');
  if(config.SCRAPER_SERVICE_URL){const url=new URL(config.SCRAPER_SERVICE_URL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('SCRAPER_SERVICE_URL deve ser uma origem HTTP(S).');if(config.EXTRACTION_SERVICE_TOKEN.length<32)throw new Error('Configure EXTRACTION_SERVICE_TOKEN com ao menos 32 caracteres.');}
  return config;
}
