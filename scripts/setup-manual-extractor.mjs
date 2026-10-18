import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const target = new URL('../.env', import.meta.url);
const source = new URL('../../o-espertinho-extractor/.env', import.meta.url);
const raw = readFileSync(target, 'utf8');
const backend = parseEnv(raw);
const extractor = parseEnv(readFileSync(source, 'utf8'));
const token = extractor.EXTRACTION_SERVICE_TOKEN ?? '';
const port = Number(extractor.EXTRACTION_PORT || 3011);
if (!/^[\w-]{32,256}$/.test(token) || token.startsWith('DUMMY_') || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Configure um segredo real e uma porta válida no .env do novo extrator.');
}
const url = `http://127.0.0.1:${port}`;
if (backend.MANUAL_EXTRACTOR_URL && new URL(backend.MANUAL_EXTRACTOR_URL).origin !== url) {
  throw new Error('MANUAL_EXTRACTOR_URL já aponta para outro serviço. Configuração preservada; ajuste manualmente se desejar usar o container local.');
}
if (backend.MANUAL_EXTRACTION_SERVICE_TOKEN && backend.MANUAL_EXTRACTION_SERVICE_TOKEN !== token) {
  throw new Error('Os segredos do extrator manual diferem. Valores existentes preservados; confira a configuração.');
}
let updated = raw;
for (const [key, value] of Object.entries({ MANUAL_EXTRACTOR_URL: url, MANUAL_EXTRACTION_SERVICE_TOKEN: token })) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  updated = pattern.test(updated) ? updated.replace(pattern, `${key}=${value}`) : updated.trimEnd() + `\n${key}=${value}\n`;
}
if (updated !== raw) { writeFileSync(target, updated, { mode: 0o600 }); }
console.log('Extrator manual local configurado. Segredos existentes do job e demais configurações foram preservados.');
