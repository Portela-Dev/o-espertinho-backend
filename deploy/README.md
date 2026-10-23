# CI/CD para VPS Linux — Docker Compose via SSH

Para inicializar um banco novo com as configurações atuais do admin, consulte [SEED-ADMIN.md](../docs/SEED-ADMIN.md). O serviço opcional `seed-admin` é manual e separado das migrations e do deploy; não inclui catálogo, árvores de categorias ou credenciais.

O workflow `.github/workflows/ci-vps.yml` adapta as etapas do Quest Crush: validação, testes, cobertura, SonarQube com Quality Gate, compilação do artefato e distribuição. Não contém etapas Android/Firebase e não depende de Coolify. Funciona em VPS HostGator ou Hostinger com Docker Engine, Compose v2 atualizado, Bash, OpenSSH e `flock` (util-linux).

## Execuções

- PRs e pushes em develop, staging e main executam CI, sem deploy por branch.
- workflow_dispatch executa somente CI/Sonar; a opção de deploy manual foi removida.
- Apenas o push de criação de uma tag staging-vMAJOR.MINOR.PATCH, como staging-v0.1.0, pode fazer deploy automático. A tag deve apontar exatamente para o HEAD remoto atual de staging. Tags leves e anotadas são aceitas; versões antigas, movimentações e exclusões são recusadas.
- A política é verificada antes da validação e novamente imediatamente antes de usar SSH. Se staging avançar durante o pipeline, a release antiga é recusada.
- A release depende de validação, Quality Gate do mesmo commit e imagem aprovada. Desenvolvimentos e tags não autorizadas nunca entram no job de deploy.
- A extensão Chrome continua sem deploy ou publicação na Web Store.

Consulte [RELEASE-STAGING.md](../docs/RELEASE-STAGING.md) para promoção de branches e criação das tags. A branch staging precisa receber estas alterações antes da primeira tag. Nenhuma tag é criada automaticamente pelo CI. VPS_AUTO_DEPLOY não é mais consultada.

O environment continua chamado production para reutilizar as variáveis/secrets já cadastrados. Ele representa a VPS atual; não foi criado outro ambiente ou servidor. Restrinja o environment a tags staging-v*, sem permitir branches.

Relatórios e pacotes têm retenção de um dia. O arquivo de imagem para deploy só é gerado/publicado em releases autorizadas; PRs e pushes de branch fazem build/smoke test sem guardar esse arquivo grande. Os nomes incluem run_id; reruns reutilizam os artefatos do mesmo build.

Cada repositório implanta apenas seu serviço. A exclusão mútua no GitHub e na VPS é preservada, sem cancelar um deploy em andamento. A mesma imagem Linux compilada no runner hospedado é verificada por SHA-256 e transferida por SSH com chave do host validada. Não há recompilação na VPS.

## GitHub: configurações em cada repositório

Em Settings → Secrets and variables → Actions:

| Tipo | Nome | Valor |
|---|---|---|
| Repository secret | `SONAR_TOKEN` | Token de análise do projeto correspondente, com permissão Execute Analysis |
| Repository variable | `SONAR_HOST_URL` | URL alcançável a partir do runner de análise; exemplo `http://127.0.0.1:9000` apenas quando SonarQube está no mesmo PC |

Em Settings → Environments, crie **production** e cadastre:

| Tipo no environment production | Nome | Valor |
|---|---|---|
| Variable | `VPS_HOST` | IPv4 público ou hostname SSH da VPS, sem protocolo |
| Variable | `VPS_USER` | Usuário SSH com acesso ao Docker e à pasta do serviço |
| Variable opcional | `VPS_PORT` | Porta SSH; padrão `22` |
| Secret | `VPS_SSH_PRIVATE_KEY` | Chave privada OpenSSH da automação, dedicada a esse acesso |
| Secret | `VPS_KNOWN_HOSTS` | Linha(s) de known_hosts do servidor, com hostname/porta correspondentes |

No environment production, permita somente tags staging-v* em Selected branches and tags; não inclua regras de branch. Os dados de runtime da aplicação ficam na VPS; não há segredo de banco embutido na imagem nem enviado como artefato.

## SonarQube e runner

Crie o projeto com a chave **o-espertinho-backend** e nome **O Espertinho - Backend**. Use `develop` como branch principal do projeto no SonarQube. A configuração não envia parâmetros de análise de PR ou múltiplas branches, seguindo a restrição da edição Community. O Quality Gate não é ignorado nem tem sua política alterada pelo pipeline.

Validação, testes, build Docker e deploy por SSH executam em runners hospedados pelo GitHub (`ubuntu-latest`). Apenas o job de SonarQube usa o runner da organização `Portela-Dev`, com os labels `[self-hosted, Windows, X64, windows-portela-dev]`. Esse runner precisa de Git for Windows com GPG e dirmngr, acesso ao servidor SonarQube e versão atualizada para as actions com runtime Node 24. Ele não precisa de Docker. ShellCheck e Playwright/Chromium executam no Linux hospedado pelo GitHub.

Em **Organization Settings > Actions > Runner groups**, libere estes três repositórios no grupo do runner e habilite o acesso a repositórios públicos. PRs executam validações nos runners hospedados do GitHub. A análise Sonar no runner próprio ocorre na develop, em execução manual autorizada ou em release staging validada. `SONAR_HOST_URL` deve ser alcançável pela conta do runner; loopback só funciona quando o Sonar está no mesmo computador.

O relatório LCOV vem dos testes reais do mesmo commit, via artefato do job validate, com sourcemaps para o TypeScript. Testes E2E não são contabilizados como cobertura unitária. Especialmente no frontend, a cobertura unitária ainda é inicial e o Quality Gate poderá exigir novos testes; o workflow preserva essa avaliação.

## Preparação da VPS, uma vez

1. Instale Docker Engine, Compose v2 com suporte a `up --wait`, Bash, OpenSSH e util-linux; use Linux amd64, pois as imagens são construídas em runner x64.
2. Prepare `/opt/o-espertinho/backend` para o usuário de deploy. O acesso ao Docker é necessário. Não execute o runner GitHub dentro da VPS pública para este fluxo.
3. Copie `deploy/runtime.env.example` para **`/opt/o-espertinho/backend/.env`**, preencha os valores reais e aplique permissão `600`. Não recrie esse arquivo a cada deploy.
4. Instale a chave pública correspondente em `~/.ssh/authorized_keys` do usuário da VPS. Cadastre sua chave privada no secret do GitHub.
5. Obtenha a chave pública SSH do host e confira a impressão digital pelo console da VPS (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Só depois cadastre a linha trusted em `VPS_KNOWN_HOSTS`. Em porta diferente de 22, o nome é `[host]:porta`. `ssh-keyscan` sozinho não autentica o host.
6. Libere acesso SSH para o runner, aponte o DNS e configure Nginx/HTTPS para o frontend. Há exemplo de Nginx no repositório do frontend. As portas do banco, backend e extrator não são publicadas.



O site usa um único domínio: Nginx encaminha ao frontend em `127.0.0.1:4200`; o frontend encaminha `/api` internamente preservando o caminho e a origem. Configure o domínio em `APP_ORIGIN`, `ALLOWED_HOSTS` e nas origens JavaScript do login Google. O proxy Nginx do exemplo sobrescreve os cabeçalhos encaminhados; o backend só confia em loopback e redes privadas na configuração de produção.

## Atualizações, persistência e recuperação

Cada versão fica em `/opt/o-espertinho/backend/releases/<sha>-<run>-<attempt>`. `current` aponta para o último deploy saudável. A aplicação é recriada com healthcheck e pode haver breve indisponibilidade durante a troca. Não é um deploy de alta disponibilidade.

O Compose inicia PostgreSQL em rede privada e conserva os dados no volume `o-espertinho-postgres-data`. Antes de cada migration, o script grava um `pg_dump` em `backups/pre-<release>.dump`, com permissão 600; só depois executa `node dist/migrate.js` e substitui o backend. Um backup local não substitui cópias externas e testes de restauração. Nunca use `docker compose down -v` na operação normal.


Se a troca do container falhar, o script tenta reiniciar a imagem anterior e o job continua marcado como falha. Rollback de imagem **não desfaz migrations SQL**. O arquivo de runtime permanece fora das releases, e as imagens anteriores ficam disponíveis para recuperação. O arquivo de imagem transferido é removido depois do sucesso; agende manutenção de imagens antigas, backups e metadados conforme o espaço da VPS. Os artefatos de imagem no GitHub têm retenção de 3 dias; relatórios, 7 dias.

O workflow não provisiona a VPS, DNS, certificados, runners ou projetos SonarQube e não recebe credenciais de produção nos jobs de validação. O deploy só é executado após configurar o environment, habilitar o workflow e criar uma tag staging válida.

## Segurança

O CI executa `npm audit --omit=dev --audit-level=high`: vulnerabilidades altas/críticas em dependências de produção e falhas da consulta bloqueiam a validação. Alertas devem ser investigados; o pipeline não aplica downgrade nem ignora findings automaticamente. A análise de dependências não substitui atualizações do sistema, navegador e imagens base.

### Transição de banco existente, preservando o volume

1. Mantenha `POSTGRES_USER`, `POSTGRES_PASSWORD` e `POSTGRES_DB` atuais. Não recrie o volume nem altere a conta que já é dona dos objetos.
2. Defina `MIGRATION_DATABASE_URL` com a conexão administrativa anterior. Defina `DATABASE_URL` com uma conta NOVA exclusiva (por exemplo `espertinho_app`) e outra senha aleatória de ao menos 24 caracteres; use o mesmo host e banco, codificando caracteres especiais na URL.
3. O deploy verifica as variáveis antes de alterar serviços, faz o backup existente e executa o serviço `migrate`. Ele aplica as migrations e cria/atualiza a conta restrita, concedendo somente DML nas tabelas da aplicação e uso de sequências. Não transfere propriedade nem apaga dados.
4. O backend recebe somente as variáveis de runtime, sem a conexão administrativa ou a senha do superusuário. Na inicialização em produção, recusa contas com superuser, criação de roles/bancos, bypass de RLS, memberships, propriedade de objetos ou CREATE no schema público.

Para preparar manualmente, use o mesmo Compose e variáveis documentados no deploy: `docker compose --env-file /opt/o-espertinho/backend/.env -f /caminho/compose.production.yml run --rm migrate`. A imagem validada precisa estar definida em `APP_IMAGE`. Não use `db:migrate` com a conta restrita; esse comando local continua destinado à conta de migrations.

A migration `018_admin_reauthentication.sql` apenas adiciona campos às sessões. Sessões antigas e logins automáticos continuam servindo à navegação pessoal, mas operações sensíveis de usuários/perfis, marketplaces, seletores, atualizações e OAuth exigem confirmação da conta Google nos últimos 15 minutos. O desafio é vinculado à sessão, expira em cinco minutos e é consumido uma única vez. Não equivale a exigir MFA do Google. Sessões pessoais continuam com validade de 30 dias.

Em produção (`NODE_ENV=production`), Swagger, assets e `/api/openapi.json` exigem sessão de administrador. Faça login pelo site antes de abrir `/api/docs/`.



## Operação atual

Somente backend/PostgreSQL e frontend são implantados na VPS. O navegador roda na extensão do administrador; não há extrator, job, porta de navegador ou segredo de serviço. RUN_WORKER controla somente manutenção interna sem navegador. Configure DATABASE_URL restrita e MIGRATION_DATABASE_URL separada; o provisionamento retira acesso às credenciais arquivadas. Prévia e teste de seletores aguardam solicitação processada pela extensão. Faça backup antes da migration 031; o arquivo histórico é preservado e nenhuma exclusão de dados é exigida.


## Origens e URLs públicas em produção

Defina `APP_ORIGIN=https://seu-dominio.example` e `EXTENSION_BACKEND_URL=https://seu-dominio.example` no `.env` do backend antes de iniciar o Compose. O Compose exige a variável da extensão explicitamente; não usa fallback para localhost. No modelo de domínio único, ambas apontam para o site público servido pelo frontend/Nginx, que encaminha `/api` ao backend. Isso preserva a sessão usada para autorizar a extensão.

O backend recusa inicialização de produção com HTTP, IPs literais, hosts locais, credenciais, portas personalizadas, caminhos, query ou fragmento nessas origens. A barra final e a capitalização do hostname são normalizadas antes da validação de Origin/CSRF. Desenvolvimento continua aceitando os endereços HTTP locais com suas portas.

Imagens de produtos (cadastro, revisão e resultados de extração), logos e destinos de compartilhamento usam a política comum de URL HTTPS com hostname público, sem credenciais e sem porta personalizada. Os logos locais de compartilhamento em `/brand/social/*.svg` continuam permitidos. A validação não resolve DNS nem faz requisições aos destinos; não é uma garantia contra mudanças posteriores de DNS/redirecionamento. A origem interna `API_BASE_URL=http://espertinho-backend:3000` permanece restrita à rede Docker e não segue a política das URLs públicas.
