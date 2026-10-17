# Backend Espertinho

Node.js + TypeScript + Express, PostgreSQL, migrations SQL versionadas e worker de ofertas.

Este é o repositório `o-espertinho-backend`. Projetos relacionados: [frontend](https://github.com/arnaldoportela/o-espertinho-frontend) e [extrator](https://github.com/arnaldoportela/o-espertinho-jobs).

## Primeiro uso

Requisitos: Node.js 22.12+ (preferencialmente 24), npm e Docker com Compose para o PostgreSQL.

```powershell
npm ci
npm run setup:env
```

Configure `GOOGLE_CLIENT_ID` no `.env`. O script gera a senha do PostgreSQL e as chaves locais apenas quando o arquivo não existe. Preserve `ENCRYPTION_KEY` para continuar lendo as configurações criptografadas do banco.

```powershell
npm run db:up
npm run db:migrate
npm run dev
```

Aguarde o PostgreSQL ficar saudável antes de executar as migrations. A API escuta em `127.0.0.1:3000`, o banco em `127.0.0.1:5432`, e `APP_ORIGIN` deve corresponder à origem do frontend (por padrão `http://localhost:4200`). O frontend encaminha `/api` para a API. O login Google usa ID token e não exige client secret.

Para extração, execute separadamente o projeto `o-espertinho-jobs`, configure `SCRAPER_SERVICE_URL` e use o mesmo `EXTRACTION_SERVICE_TOKEN` nos dois serviços. O backend não inicia o extrator. O worker de atualização roda com o backend quando `RUN_WORKER=true`.

Swagger: `http://localhost:3000/api/docs/`. Para operações autenticadas de escrita, faça login no frontend e abra `http://localhost:4200/api/docs/`, preservando sessão, origem e XSRF.

Os arquivos `.env.example`, `docker-compose.yml` e as migrations estão incluídos; dados e credenciais locais não são versionados. Para parar o banco sem apagar o volume, execute `npm run db:down`.

Comandos: `npm run setup:env`, `npm run db:up`, `npm run db:migrate`, `npm run dev`, `npm run build`, `npm start`, `npm test`.

O admin inicial é reservado pela migration para `arnaldorolimportela@gmail.com`; a identidade só é vinculada após validar login Google. Chaves dos marketplaces são configuradas em Admin → Marketplaces. O Client ID do login Google precisa estar no `.env` antes do primeiro acesso.

Nunca versione `.env` nem descarte o volume do PostgreSQL em uma parada rotineira.
