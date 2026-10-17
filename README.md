# Backend Espertinho

Node.js + TypeScript + Express, PostgreSQL, migrations SQL versionadas e worker de ofertas.

Este Ã© o repositÃ³rio `o-espertinho-backend`. Projetos relacionados: [frontend](https://github.com/Portela-Dev/o-espertinho-frontend) e [extrator](https://github.com/Portela-Dev/o-espertinho-jobs).

## Primeiro uso

Requisitos: Node.js 22.12+ (preferencialmente 24), npm e Docker com Compose para o PostgreSQL.

```powershell
npm ci
npm run setup:env
```

Configure `GOOGLE_CLIENT_ID` no `.env`. O script gera a senha do PostgreSQL e as chaves locais apenas quando o arquivo nÃ£o existe. Preserve `ENCRYPTION_KEY` para continuar lendo as configuraÃ§Ãµes criptografadas do banco.

```powershell
npm run db:up
npm run db:migrate
npm run dev
```

Aguarde o PostgreSQL ficar saudÃ¡vel antes de executar as migrations. A API escuta em `127.0.0.1:3000`, o banco em `127.0.0.1:5432`, e `APP_ORIGIN` deve corresponder Ã  origem do frontend (por padrÃ£o `http://localhost:4200`). O frontend encaminha `/api` para a API. O login Google usa ID token e nÃ£o exige client secret.

Para extraÃ§Ã£o, execute separadamente o projeto `o-espertinho-jobs`, configure `SCRAPER_SERVICE_URL` e use o mesmo `EXTRACTION_SERVICE_TOKEN` nos dois serviÃ§os. O backend nÃ£o inicia o extrator. O worker de atualizaÃ§Ã£o roda com o backend quando `RUN_WORKER=true`.

Swagger: `http://localhost:3000/api/docs/`. Para operaÃ§Ãµes autenticadas de escrita, faÃ§a login no frontend e abra `http://localhost:4200/api/docs/`, preservando sessÃ£o, origem e XSRF.

Os arquivos `.env.example`, `docker-compose.yml` e as migrations estÃ£o incluÃ­dos; dados e credenciais locais nÃ£o sÃ£o versionados. Para parar o banco sem apagar o volume, execute `npm run db:down`.

Comandos: `npm run setup:env`, `npm run db:up`, `npm run db:migrate`, `npm run dev`, `npm run build`, `npm start`, `npm test`.

O admin inicial Ã© reservado pela migration para `arnaldorolimportela@gmail.com`; a identidade sÃ³ Ã© vinculada apÃ³s validar login Google. Chaves dos marketplaces sÃ£o configuradas em Admin â†’ Marketplaces. O Client ID do login Google precisa estar no `.env` antes do primeiro acesso.

Nunca versione `.env` nem descarte o volume do PostgreSQL em uma parada rotineira.

## CI/CD e deploy em VPS

O workflow de GitHub Actions valida o projeto, gera cobertura para SonarQube e prepara deploy independente com Docker Compose via SSH. Consulte [o guia de CI/CD](deploy/README.md) para secrets/variables, projeto SonarQube, preparação da VPS, runtime e recuperação. O deploy automático começa desativado.
