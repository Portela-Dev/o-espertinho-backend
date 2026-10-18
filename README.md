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


## Extensão Chrome: autenticação real e API demonstrativa

A migration `019_extension_access.sql` adiciona `affiliate_links` aos perfis e cria `extension_sessions`, armazenando apenas hashes dos tokens. O perfil Administrador recebe a nova permissão; outros perfis podem recebê-la na gestão de perfis existente. A autorização da extensão verifica a permissão exata, não apenas o papel de administrador.

Em desenvolvimento, `EXTENSION_MOCK_ENABLED=true` e `EXTENSION_BACKEND_URL=http://localhost:3000` habilitam `/api/extension`. Em produção essas rotas ficam desativadas independentemente da flag. A extensão precisa da mesma origem base; use localhost no frontend e no backend para compartilhar o cookie na aba de aprovação.

O login usa pareamento de cinco minutos com prova SHA-256: `/auth/start` fornece a URL de autorização; `/auth/connect` abre a página, `/auth/approve` exige sessão real, origem correta e XSRF; `/auth/poll` troca uma autorização de uso único pelos tokens. Não existe usuário fake nem login que ignore a validação Google em runtime. O token de acesso dura 15 minutos; `/auth/refresh` gira os tokens, com limite de sete dias para a renovação. A sessão depende da sessão web original. Logout web, bloqueio ou remoção da permissão impedem o acesso; `/auth/logout` revoga a sessão da extensão.

As demais rotas exigem Bearer token e o header `X-Espertinho-Extension-Id`, vinculado à sessão:

| Rota sob `/api/extension` | Método | Finalidade |
| --- | --- | --- |
| `/session` | GET | Conta e permissões atuais |
| `/config` | GET | Receita declarativa da loja demonstrativa |
| `/queue` | GET | Cinco itens de teste, separados por usuário |
| `/batches/claim` | POST | `{ "marketplaceId": "demo" }`, reserva de dois itens por 120 segundos |
| `/batches/results` | POST | `{ "leaseId": "...", "results": [{ "id": "...", "affiliateUrl": "..." }] }` ou erro por item |
| `/queue/reset` | POST | Recriar apenas a fila demonstrativa do usuário |

A receita define domínios, página de sessão, intervalo, seletores, headers com variáveis locais e caminho JSON do link retornado. A página `/demo/store` e o endpoint `/demo/convert` simulam o marketplace sem usar credenciais reais. Os resultados só alteram a fila em memória: não criam produtos, categorias ou ofertas e não publicam conteúdo. A fila reinicia com o processo; a autenticação da extensão é persistida no PostgreSQL. Respostas são no-store e as rotas têm limite de chamadas.

Consulte a seção **Extensão Chrome** no Swagger para os contratos. A configuração administrativa das receitas, discovery e publicação reais ainda não foram implementados; este escopo entrega o consumidor genérico e os endpoints mockados.
