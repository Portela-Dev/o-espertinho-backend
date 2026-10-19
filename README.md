# Backend Espertinho

Node.js + TypeScript + Express, PostgreSQL, migrations SQL versionadas e worker de ofertas.

Este Ã© o repositÃ³rio `o-espertinho-backend`. Projetos relacionados: [frontend](https://github.com/Portela-Dev/o-espertinho-frontend) e [extrator](https://github.com/Portela-Dev/o-espertinho-extractor).

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

Para testes de seletores e prévias de cadastro de links, execute o novo projeto `o-espertinho-extractor` e configure `MANUAL_EXTRACTOR_URL` e `MANUAL_EXTRACTION_SERVICE_TOKEN`. No workspace local, execute `npm run setup:manual-extractor` para copiar apenas o segredo do `.env` desse serviço e configurar `http://127.0.0.1:3011`; valores conflitantes existentes são preservados e exigem ajuste explícito.


O novo cliente chama `POST /v1/extractions` com Bearer token, converte os perfis salvos para o contrato da biblioteca e valida o resultado. Falhas técnicas não são tratadas como produto indisponível; prévias incompletas e indisponíveis não podem ser confirmadas. Autenticação, permissões administrativas e XSRF permanecem exigidos nas rotas existentes.

O administrador continua escolhendo o produto antes de cadastrar o link. O identificador técnico do novo link é um hash da URL e do marketplace, com prefixo `url-v1:`; não identifica o produto do catálogo e não usa identificadores de produto do marketplace. O job independente confere o destino dos links sem derivar identificadores do marketplace.

Perfis existentes são adaptados somente em memória: atributos vazios são omitidos, características usam seus seletores de pares e regras de preço recebem fallback de partes inteiro/centavos antes da leitura do texto completo. A regra de identificador externo não é enviada ao novo serviço. O atributo proprietário de galeria JSON é substituído por `src`; regras de URL direta já cadastradas mantêm sua prioridade. O limite do serviço é 40 regras após adaptação; perfis que excederem esse limite retornam orientação para reduzir as regras. Nenhum seletor salvo é alterado automaticamente.

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

O processamento agendado e o consumo da fila de atualização de preços pertencem exclusivamente a `Portela-Dev/o-espertinho-job-update-price`. O backend mantém os endpoints administrativos de configuração, disparo e acompanhamento. `RUN_WORKER` controla apenas a manutenção interna da API. Nenhum extrator HTTP legado na porta 3010 é necessário.


Admin → Atualizações permite cancelar uma rodada, preservando preços já atualizados e ignorando respostas de tentativas invalidadas. A pausa de proteção após falha técnica aparece explicitamente na tela. O backend oferece `POST /api/admin/offer-refresh/runs/:id/cancel`, com autorização de atualizações, XSRF e confirmação administrativa recente. A migration `020_offer_refresh_cancellation.sql` registra o cancelamento sem apagar execuções, links ou histórico. O job existente já confere o token da tentativa antes de gravar; seu advisory lock continua impedindo extrações simultâneas. Uma nova rodada pode ser enfileirada e aguarda o intervalo de proteção e o término de uma consulta anterior.

## Paginação das coleções

As consultas de listas pessoais e administrativas aceitam `paginate=true`, `page` (a partir de 1) e `pageSize` (20 por padrão; máximo 50). O resultado inclui `total`, `page` e `pageSize`; a lista é retornada em `items`, ou em `offers`, `runs`, `profiles` e `errors` nos detalhes correspondentes. Produtos retornam `offer_count`; ocorrências de execução retornam `errorTotal`. As faixas de preço consideram todas as ofertas, independentemente da página. Páginas além do fim são ajustadas à última disponível. Os contratos sem `paginate` permanecem compatíveis para consultas de seleção e clientes existentes. Não há migration nesta alteração.

A lista de usuários também aceita `pageSize` de 1 a 50, mantendo 25 como padrão para clientes existentes. A interface oferece quantidades de 5, 10, 15, 20, 25 e 50 nas listas paginadas.

### Configuração da descoberta de seções

A área **Admin → Exploração** permite cadastrar perfis reutilizáveis por marketplace e páginas de seção vinculadas a esses perfis. Os endpoints ficam em `/api/admin/discovery` e estão descritos no Swagger. Exigem login, a permissão `discovery` (ou papel admin), XSRF nas escritas e confirmação recente de conta Google. A migration `022_discovery_configuration.sql` cria as tabelas sem alterar produtos, categorias, ofertas ou histórico existentes. Instalações com conta de banco restrita devem executar o provisionamento de permissões após a migration, conforme o procedimento de deploy existente.

**Esta entrega apenas persiste configurações.** Não acessa marketplaces, não testa seletores no navegador, não agenda tarefas e não modifica os jobs existentes. A opção habilitada e o intervalo em horas são preferências para uma integração futura. A flag `executionAvailable: false` em `/defaults` explicita esse contrato. Os perfis são versionados; edições/exclusões desatualizadas retornam 409. Perfis vinculados a seções não podem ser excluídos ou transferidos para outro marketplace.

Contrato de exploração a ser consumido futuramente:

- `rendering`: evento de carregamento, seletor de prontidão, iframe opcional, timeout e espera extra para hidratação. Seletores são CSS, sem scripts ou acesso a cookies/headers.
- `extraction`: contêiner de cada item; link e atributo; seletores opcionais de título, preço, imagem/atributo, marca, descrição e categoria de origem. Dados de produto são relativos ao item. Categoria pode vir do documento ou do item, em ordem de DOM; o separador permite interpretar um caminho em um único texto. A categoria alternativa da seção é usada quando nenhuma categoria for extraída. Não há mapeamento para categorias internas nesta entrega.
- `pagination.mode`: `single` (uma página), `next` (clicar no próximo), `url` (template HTTPS com `{page}`, início e incremento, incluindo offsets), `load_more` (clicar e aguardar novos itens), `scroll` (rolar janela ou contêiner). Configura seletores de anterior/atual/total, avanço desativado e fim, espera após avanço e limite sem progresso. Anterior é metadado opcional; a exploração avança a partir da página inicial. O seletor de avanço é relativo ao documento do perfil. Os números atual/total devem produzir inteiros legíveis; títulos/localizações diferentes podem exigir ajuste futuro no consumidor. Em scroll/load_more, cada avanço conta como uma página para os limites.
- Fim normal: seletor de fim encontrado, botão desativado, página atual atingindo total, página repetida, limite de tentativas sem progresso ou ausência de próximo configurada como `finish`. Ausência de próximo configurada como `failure` usa a política de paginação. Uma página sem itens usa a política `emptyPage`. Uma página repetida encerra, nunca cria loop.
- `limits`: páginas/avanços, itens, duração da seção e intervalo mínimo entre requisições (100 ms a 10 minutos). Deduplicação de links e parada em páginas repetidas são obrigatórias. O limite global de duração prevalece sobre esperas e tentativas. O intervalo não autoriza concorrência de requisições de um mesmo marketplace.
- `failures`: regras separadas para navegação/HTTP, timeout, bloqueio/CAPTCHA, página vazia, item inválido e paginação. `retries` conta novas tentativas além da original (0–5); a espera inicial é multiplicada por `backoffMultiplier` a cada nova tentativa, limitada pela duração restante da seção. Depois: `stop_section` encerra apenas o ciclo atual; `pause_source` impede ciclos seguintes até revisão; `skip_item` é exclusivo de item inválido; `skip_page` exige paginação por URL. Ao atingir os limites, `finish` conclui com o coletado ou `pause_source` exige revisão. Bloqueios não serão contornados; o padrão é pausar sem repetir. Nenhuma dessas ações é executada nesta etapa.

URLs de seção e templates preservam query strings necessárias à pesquisa/paginação. Fragmentos das URLs de seção são removidos; URLs usam somente HTTPS e hosts registrados no marketplace. Isso é distinto da regra existente para URLs finais de **produtos**, que continuam sem parâmetros. O crawler futuro deverá revalidar hosts e destino de cada redirect/iframe/link resolvido, verificar IPs públicos e permissões de navegação; o CRUD atual não realiza nenhuma requisição externa e não prova que a página ou o seletor existe. Estruturas arbitrárias, shadow DOM fechado, CAPTCHA, autenticação e formatos de paginação não convencionais não têm compatibilidade universal garantida.

O cadastro administrativo de ofertas usa o fluxo genérico de links, produto vinculado e seletores configurados por marketplace. A revisão oferece o atalho para esse cadastro, sem formulários de importação por identificadores próprios de uma loja. Novas integrações de cadastro/exploração devem ser declarativas e reutilizáveis entre marketplaces.
