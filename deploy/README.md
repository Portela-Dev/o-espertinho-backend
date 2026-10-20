# CI/CD para VPS Linux — Docker Compose via SSH

O workflow `.github/workflows/ci-vps.yml` adapta as etapas do Quest Crush: validação, testes, cobertura, SonarQube com Quality Gate, compilação do artefato e distribuição. Não contém etapas Android/Firebase e não depende de Coolify. Funciona em VPS HostGator ou Hostinger com Docker Engine, Compose v2 atualizado, Bash, OpenSSH e `flock` (util-linux).

## Execuções

- PRs para `develop` ou `main`: validação, testes e construção/smoke test da imagem, sem secrets de deploy e sem executar código de PR no runner próprio. Arquivos grandes de imagem não são publicados em PRs.
- Push na `develop`: mesmas verificações e análise no SonarQube. O deploy automático vem desativado.
- Push na `main`: validação e imagem. Não analisa outra branch no mesmo projeto Community e não implanta.
- Actions → CI e deploy VPS → Run workflow → branch `develop` → marcar `deploy`: deploy manual, condicionado a todas as validações e ao Quality Gate.
- Para habilitar deploy em cada push na `develop`, configure a variable de repositório `VPS_AUTO_DEPLOY=true`. Não é necessário para deploy manual.

O botão **Run workflow** da interface exige que este workflow também exista na branch padrão do GitHub (atualmente main). Após aprovar estas PRs na develop, promova o workflow à main pelo fluxo de revisão normal, ou selecione develop como branch padrão nas configurações. Não alteramos a main nem a branch padrão automaticamente. Depois de o workflow ter sido registrado por uma execução, também é possível dispará-lo pela CLI: `gh workflow run ci-vps.yml --repo Portela-Dev/o-espertinho-backend --ref develop -f deploy=true`. Referência: [execuções manuais](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).

Os nomes dos artefatos usam o identificador da execução (`run_id`), sem o número da tentativa. Assim, **Re-run failed jobs** reutiliza a cobertura e a imagem já publicadas pelo mesmo build. Quando os jobs produtores são reexecutados, seus artefatos são substituídos.

Cada repositório implanta somente seu serviço. Há exclusão mútua no GitHub e na VPS; um deploy em andamento não é cancelado por outro. O CI constrói uma imagem Linux no runner ubuntu-latest do GitHub e usa a mesma imagem no smoke test e na VPS, sem recompilar remotamente. O pacote contém tag do commit, manifesto e hashes SHA-256. A transferência SSH valida a chave do host, sem `StrictHostKeyChecking=no` nem descoberta automática de host confiável. Não é preciso registry ou PAT do Docker/GitHub Packages.

## GitHub: configurações em cada repositório

Em Settings → Secrets and variables → Actions:

| Tipo | Nome | Valor |
|---|---|---|
| Repository secret | `SONAR_TOKEN` | Token de análise do projeto correspondente, com permissão Execute Analysis |
| Repository variable | `SONAR_HOST_URL` | URL alcançável a partir do runner de análise; exemplo `http://127.0.0.1:9000` apenas quando SonarQube está no mesmo PC |
| Repository variable opcional | `VPS_AUTO_DEPLOY` | `true` habilita deploy após push validado na develop; ausente/false mantém manual |

Em Settings → Environments, crie **production** e cadastre:

| Tipo no environment production | Nome | Valor |
|---|---|---|
| Variable | `VPS_HOST` | IPv4 público ou hostname SSH da VPS, sem protocolo |
| Variable | `VPS_USER` | Usuário SSH com acesso ao Docker e à pasta do serviço |
| Variable opcional | `VPS_PORT` | Porta SSH; padrão `22` |
| Secret | `VPS_SSH_PRIVATE_KEY` | Chave privada OpenSSH da automação, dedicada a esse acesso |
| Secret | `VPS_KNOWN_HOSTS` | Linha(s) de known_hosts do servidor, com hostname/porta correspondentes |

Configure regras de aprovação e restrição à branch `develop` no environment se desejar revisão antes do deploy. Os dados de runtime da aplicação ficam na VPS; não há segredo de banco embutido na imagem nem enviado como artefato.

## SonarQube e runner

Crie o projeto com a chave **o-espertinho-backend** e nome **O Espertinho - Backend**. Use `develop` como branch principal do projeto no SonarQube. A configuração não envia parâmetros de análise de PR ou múltiplas branches, seguindo a restrição da edição Community. O Quality Gate não é ignorado nem tem sua política alterada pelo pipeline.

Validação, testes, build Docker e deploy por SSH executam em runners hospedados pelo GitHub (`ubuntu-latest`). Apenas o job de SonarQube usa o runner da organização `Portela-Dev`, com os labels `[self-hosted, Windows, X64, windows-portela-dev]`. Esse runner precisa de Git for Windows com GPG e dirmngr, acesso ao servidor SonarQube e versão atualizada para as actions com runtime Node 24. Ele não precisa de Docker. ShellCheck e Playwright/Chromium executam no Linux hospedado pelo GitHub.

Em **Organization Settings > Actions > Runner groups**, libere estes três repositórios no grupo do runner e habilite o acesso a repositórios públicos. PRs executam validações nos runners hospedados do GitHub. A análise Sonar no runner próprio só ocorre na develop em push ou execução manual. `SONAR_HOST_URL` deve ser alcançável pela conta do runner; loopback só funciona quando o Sonar está no mesmo computador.

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

O workflow não provisiona a VPS, DNS, certificados, runners ou projetos SonarQube e não recebe credenciais de produção nos jobs de validação. O deploy só é executado depois que você configurar o environment e acioná-lo/habilitá-lo.

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
