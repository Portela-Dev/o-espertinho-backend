import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) { console.log('.env já existe; nenhum segredo foi alterado.'); process.exit(0); }
const password = randomBytes(24).toString('hex');
const template = readFileSync('.env.example', 'utf8').replaceAll('replace-with-a-random-password', password).replace('ENCRYPTION_KEY=\n', `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
writeFileSync('.env', template, { flag: 'wx', mode: 0o600 });
console.log('.env local criado. Configure GOOGLE_CLIENT_ID antes de usar o login.');
