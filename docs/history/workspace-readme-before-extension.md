# Espertinho

## Evolução planejada do catálogo

O [plano faseado de migração para a extensão do Chrome](PLANO-MIGRACAO-CATALOGO-EXTENSAO.md) documenta os quatro passos manuais, revisão/publicação, substituição da prévia, segurança e retirada das POCs e serviços de navegador. É um plano de execução: os serviços atuais continuam existentes até o aceite das respectivas fases. Há informações históricas neste README que serão reconciliadas durante o inventário e a migração.

Portal web de ofertas com Angular 22, SSR nas páginas públicas, API Node.js/Express 5 em TypeScript e PostgreSQL 17. Aplicativo mobile fora do escopo.

- `1-backend`: API, autenticação, banco e cliente HTTP do extrator.
- `2-frontend`: aplicação Angular.
- `o-espertinho-job-update-price`: worker independente de atualização de preços, disponibilidade e histórico diário.
- `o-espertinho-extractor`: novo extrator manual na porta 3011, usando a biblioteca privada; atende testes de seletores e prévias do backend.

## Primeiro uso no PC confirmado

Abra o terminal em `F:\OneDrive\Repos\espertinho`.

Inicie o Docker Desktop no modo Linux e execute:

```powershell
npm run setup
```

O comando verifica o Docker, instala as dependências dos três projetos pelos lockfiles e cria os arquivos `.env` quando ainda não existem. A senha PostgreSQL, a chave de criptografia e o segredo de comunicação são gerados no primeiro setup; configurações e segredos existentes são preservados. A conexão manual e a conta exclusiva de banco do job são configuradas sem exibir segredos.

Na etapa final, o setup inicia o PostgreSQL com `docker compose up -d --wait`, aguarda sua disponibilidade, aplica as migrations e provisiona as permissões da conta do job e inicia o job de preços. Depois inicia o extrator manual pelo script próprio, com detach e espera pelo healthcheck. O terminal é liberado após os healthchecks; os containers continuam executando depois que ele for fechado. Não abre janelas adicionais nem inicia frontend/backend. Falhas em qualquer etapa encerram o comando com erro; não é necessário apagar volumes ou repetir manualmente as migrations.

O novo extrator usa uma imagem local já disponível (`o-espertinho-extractor:local`) ou constrói a imagem com `NODE_AUTH_TOKEN` autorizado a ler o pacote privado no GitHub Packages. A instalação das dependências dele ocorre no build Docker; o setup não exige uma instalação Node adicional desse projeto no host. Consulte `o-espertinho-extractor/README.md` para importar a imagem pronta do CI ou configurar a credencial de build.

Comandos independentes do novo extrator, na raiz:

```powershell
npm run extractor:up
npm run extractor:logs
npm run extractor:down
```

Ele responde em `http://127.0.0.1:3011/health/ready`. O setup prepara seu `.env` e executa `setup:manual-extractor` no backend antes das migrations, configurando `MANUAL_EXTRACTOR_URL` e copiando somente o segredo manual, sem sobrescrever valores conflitantes. O job de preços possui comandos próprios `price-job:up`, `price-job:down` e `price-job:logs`; não expõe HTTP nem usa a porta 3010.

Utilize Node 22.12+ ou Node 24 LTS; o script prefere o npm incluído na instalação do Node. Configure `GOOGLE_CLIENT_ID` em `1-backend/.env` conforme a seção seguinte.

Em um terminal na raiz, inicie apenas a API:

```powershell
npm run dev:backend
```

Em outro terminal na raiz, inicie apenas o Angular:

```powershell
npm run dev:frontend
```

Acesse **http://localhost:4200**. A API usa `127.0.0.1:3000`; o PostgreSQL usa `127.0.0.1:5432`. O PostgreSQL e o serviço de extração usam Docker; backend e frontend executam no host. O frontend encaminha `/api` para o backend, mantendo a mesma origem. Use `localhost` no navegador para corresponder a `APP_ORIGIN`.

Para encerrar o banco sem remover seus dados:

```powershell
npm run db:down
```

## Login Google e administrador

No Google Cloud Console, configure a tela de consentimento e crie uma credencial OAuth do tipo **Aplicativo da Web**. Cadastre `http://localhost:4200` como origem JavaScript autorizada. Adicione sua conta aos usuários de teste se o projeto estiver em modo de teste. O login usa Google Identity Services com callback JavaScript; não requer um redirect URI próprio para esse fluxo.

Defina `GOOGLE_CLIENT_ID` no `.env` do backend e reinicie a API. A migration já reserva `arnaldorolimportela@gmail.com` como administrador. O papel é concedido pelo registro no banco após validação do token Google, e-mail verificado e identidade Gmail/Workspace. Informar um e-mail no navegador não concede acesso. Não existe login local, senha padrão nem endpoint de bypass na aplicação de produção.

Primeiro acesso: entrar com esse Google → **Admin** → **Marketplaces** → configurar seletores → **Produtos** → cadastrar produto → **Cadastro de links** → conferir prévia → **Revisão de ofertas** → conferir → publicar. A vitrine começa vazia, sem dados comerciais inventados.

## Integrações

### Amazon

Conector Creators API Brasil, credenciais versão **3.1**: Credential ID, Credential Secret e PartnerTag. O backend obtém e reutiliza token OAuth, consulta `searchItems`/`getItems`, normaliza preço e imagem e preserva integralmente `detailPageURL`. Requer conta aprovada e elegível para API; ter conta de associado não basta. Consulte os requisitos atuais no portal oficial, incluindo vendas qualificadas.

Buscas por palavra-chave, limite de preço e desconto mínimo; importação individual por ASIN. Candidatos ficam pendentes. Publicação revalida os dados; mudança de preço, condições ou título exige nova revisão. Links são diretos para a Amazon com `rel="sponsored noopener"`. O evento de clique é enviado separadamente e não bloqueia a abertura da loja. Não há identificação de comprador, cashback, pontos por compra, histórico ou alerta de preços. A atualização periódica usa a fila descrita abaixo. Falhas técnicas mantêm o último preço conhecido com atualização pendente; ausência confirmada de preço torna a oferta indisponível.

Referências: https://associados.amazon.com.br/creatorsapi/docs/en-us/get-started/using-curl e https://associados.amazon.com.br/help/operating/policies/

### Mercado Livre

**Não foi confirmada uma API pública oficial de afiliados para descobrir ofertas e gerar links automaticamente.** O sistema não transforma um link comum em link comissionado inventando parâmetros, nem usa cookies de navegador ou endpoints privados.

Há cadastro manual completo de ofertas com link de afiliado obtido nas ferramentas oficiais. É preciso confirmar autorização sobre textos/imagens. As credenciais da API geral existentes continuam no backend. Os endpoints administrativos documentados no Swagger permitem configurá-las e testá-las. Em Revisão de ofertas, a opção **Importar dados do Mercado Livre pela API geral** consulta um item conhecido, exige link de afiliado autorizado fornecido por você e envia os dados para revisão. A rotação de refresh token é persistida, inclusive quando a consulta subsequente falha. Itens importados pela API podem ser revalidados. Isso não fornece descoberta ou conversão de links de afiliados; o status distingue **Somente API geral**. Regras automáticas para Mercado Livre são bloqueadas com explicação. Uma integração de parceiros futura exige documentação oficial e adequação do conector.

Referências: https://www.mercadolivre.com.br/l/afiliados-gere-seus-links e https://developers.mercadolivre.com.br/en_us/items-and-searches

## Telas e fluxos

- Vitrine responsiva: busca, categorias, marketplace, preço máximo, ordenação, paginação, detalhes e link para loja.
- Login Google opcional; favoritos; filtros salvos; catálogos privados com criação, edição, inclusão/remoção de ofertas e exclusão.
- Conta: saída e exclusão para usuários comuns. Admin precisa transferir a administração antes de excluir a conta.
- Admin: métricas, produtos, marketplaces, seletores, cadastro de links com prévia, revisão, atualizações periódicas, importação por API, edição, publicação/rejeição/encerramento e auditoria.
- Páginas de privacidade, termos, informações do serviço e estados de carregamento, erro, ausência de dados e oferta indisponível.

Não são apresentados ganhos ou conversões presumidos a partir de cliques. O relatório é de cliques registrados, não de pessoas únicas, vendas ou tráfego comprovadamente humano. Comissões devem ser conferidas no portal oficial.

## Segurança

Sessões opacas e persistidas como hash no PostgreSQL; expiração de 12 horas; cookie de sessão HttpOnly; cookies Secure em produção e SameSite=Lax. Login regenera a sessão e logout a invalida.

**XSRF:** token aleatório exclusivo associado à sessão no servidor, cookie `XSRF-TOKEN` e header `X-XSRF-TOKEN`. Angular envia o header em chamadas mutáveis da mesma origem. O backend verifica o hash do token com comparação de tempo constante e exige `Origin` igual a `APP_ORIGIN`. Tokens ausentes, falsos ou de outra sessão são recusados. Proteção também no login e em ações administrativas. Leitura por GET não publica, exclui nem altera dados de negócio. As consultas servidor-servidor aos marketplaces usam suas próprias credenciais.

Credenciais dos marketplaces cifradas com AES-256-GCM, retornos administrativos sem segredos, consultas SQL parametrizadas, validação Zod, controle de propriedade dos recursos, rate limits, destinos HTTPS com allowlist e chamadas externas com timeout e sem seguir redirects. Cliques não armazenam usuário, sessão ou IP. Logs de cliques, auditoria e sincronizações são removidos após 365 dias pelo worker. Faça backup do banco **e da ENCRYPTION_KEY**; perder essa chave impede recuperar credenciais salvas.

O backend usa Helmet. Em produção configure também HTTPS e cabeçalhos do site no proxy reverso, CSP compatível com Google Identity e origens de imagens, e backups automáticos do PostgreSQL. O proxy deve preservar a origem enviada pelo navegador; não substitua o cabeçalho Origin de requisições recebidas.

## Worker e publicação

O worker do backend (`RUN_WORKER=true`) limpa sessões e dados antigos da API. Ele não consulta preços nem consome a fila de atualização.

O projeto `o-espertinho-job-update-price` é responsável pelo agendamento e processamento da fila de preços no PostgreSQL. O backend mantém os controles administrativos. O job usa seu próprio navegador, não expõe HTTP e preserva as pausas, o bloqueio entre consumidores e a retomada de tarefas interrompidas.

## Build e produção

```powershell
npm run typecheck
npm test
npm run build
```

Depois do build, execute `npm start` em cada subpasta. O servidor SSR do frontend usa porta 4200 (ou variável `PORT`) e a API usa a porta do `.env` (3000). Encaminhe o domínio público ao frontend. No backend defina `NODE_ENV=production`, `APP_ORIGIN=https://seu-dominio` e a credencial Google desse domínio. No frontend configure `ALLOWED_HOSTS=seu-dominio` no ambiente do processo SSR. Serviços escutam apenas loopback; o proxy externo termina HTTPS. O domínio também precisa constar nos sites declarados aos programas de afiliados.

O pacote esbuild está fixado em 0.25.12 nos overrides por incompatibilidade do executável nativo 0.28.2 neste PC. Os lockfiles tornam a instalação reproduzível. Reavalie o override antes de atualizar o Angular e execute os testes novamente.

## Testes de interface isolados

Os testes usam um servidor de teste com PostgreSQL embarcado em memória, dados fictícios e validação de identidade simulada **somente dentro de `test/preview-server.mjs`**. Esse módulo não faz parte do build de produção. Não o use para dados ou contas reais.

Terminal 1, em `1-backend`:

```powershell
npm run build
$env:E2E_TEST_SERVER='1'
node test/preview-server.mjs
```

Terminal 2, em `2-frontend`:

```powershell
npm run build
npm start
```

Terminal 3, em `2-frontend`:

```powershell
npm run test:e2e
```

O Playwright usa o Edge já instalado (`channel: msedge`). Backend de teste e API real não podem ocupar a porta 3000 ao mesmo tempo. Encerre o servidor de teste ao concluir.

## Limites de validação desta entrega

O Docker Desktop estava parado e nenhuma credencial real Google/marketplace foi fornecida. O Compose foi validado sem iniciar containers. A migration e os fluxos SQL foram testados em PGlite (PostgreSQL embarcado), não no seu volume Docker. Testes das integrações usam respostas simuladas; testes de login usam identidade simulada no servidor isolado. Login e ofertas reais requerem a configuração das contas e teste autenticado. Não considerar esta entrega homologada comercialmente antes dessas verificações.


### Conectar a conta do Mercado Livre

Na raiz do projeto, execute `npm run db:migrate` para aplicar `002_marketplace_oauth.sql` e reinicie o backend e o frontend.

1. Pelo Swagger, use `PUT /api/admin/marketplaces/mercadolivre` para salvar Client ID e Client Secret. Não é necessário informar refresh token.
2. Configure `MELI_REDIRECT_URI` no `.env` do backend e reinicie-o. O endereço deve ser HTTPS, sem query/fragmento, com caminho `/api/admin/mercadolivre/callback`. Em produção, pode ser o próprio domínio do site.
3. Para desenvolvimento, use um túnel HTTPS de sua escolha apontando para **127.0.0.1:3000** (backend). Exemplo de formato: `https://seu-tunel.example/api/admin/mercadolivre/callback`. O domínio é apenas ilustrativo: use o endereço real fornecido pelo túnel. Mantenha `APP_ORIGIN=http://localhost:4200` se esse for o endereço em que você abriu o site. O callback público redireciona para essa origem fixa e conclui a autorização na sua sessão local; não exige mudar o login Google para o domínio do túnel.
4. Cadastre exatamente a mesma URI no DevCenter. Habilite Authorization Code e Refresh Token. PKCE fica desmarcado por padrão; para habilitá-lo, marque no DevCenter e defina `MELI_OAUTH_PKCE=true` no backend. Client Credentials não é utilizado.
5. Use `POST /api/admin/mercadolivre/oauth/start` e abra a URL retornada para autorizar a conta. O servidor salva os tokens criptografados e retorna à visão geral do admin.

O início da conexão exige sessão admin, origem válida e XSRF. O retorno exige state aleatório de uso único, com validade de dez minutos, vinculado à mesma sessão e às credenciais usadas no início. A ponte HTTPS não troca tokens. Cancelamentos e falhas retornam uma mensagem ao admin; reconectar não apaga a autorização anterior até uma nova troca bem-sucedida. Alterar Client ID ou Client Secret remove os tokens anteriores e exige nova conexão. Se o túnel mudar de domínio, atualize o `.env` e o DevCenter.

O access token é reutilizado até próximo do vencimento. Na próxima consulta que exigir renovação, o backend utiliza o refresh token e persiste sua substituição. Não há renovação sem uso da API. Revogação ou expiração da autorização pode exigir reconectar. Esta conexão não implementa descoberta por rankings nem geração de links de afiliado.



### Cadastro de ofertas por seletores e prévia

O admin possui a aba **Produtos** (`/admin/products`) e as abas de extração: **Marketplaces** (`/admin/marketplaces`) para nome, site, domínios e ativação da extração; **Seletores** (`/admin/selectors`) para regras CSS por campo; e **Cadastro de links** (`/admin/links`) para extrair uma oferta, conferir a prévia e confirmar o cadastro. Nenhuma chave de API é necessária para a extração por seletores.

A migration `005_scraping_catalog.sql` prepara exemplos para Amazon e Mercado Livre. São pontos de partida editáveis, não garantia de compatibilidade com todas as páginas. No editor, informe um seletor CSS por linha e escolha texto, atributo HTML ou pares de característica/valor. Regras do mesmo campo podem ser repetidas para alternativas de extração. Nome e preço são sempre obrigatórios; imagens e características combinam resultados sem repetir URLs/pares idênticos. Para preços, a extração trata números brasileiros e os componentes de reais/centavos usados pela Amazon e pelo Mercado Livre, sem converter texto de parcelamento em preço.

Use **Testar extração** para executar as regras atuais sem salvar ofertas e sem precisar salvar as alterações do editor. Na aba de links, informe o link de afiliado já gerado: ele é preservado integralmente. O navegador de extração executa JavaScript e aguarda os campos necessários pelo tempo configurado. A prévia mostra os dados encontrados, imagens, características, condições, campos ausentes e seletores utilizados. A prévia expira em 15 minutos, pertence ao administrador que a gerou e só pode ser confirmada uma vez. Alterar as regras ou desativar o marketplace invalida a confirmação. A oferta só entra no banco após confirmação e fica **pendente** até sua publicação na revisão. Duplicatas do mesmo link de afiliado no mesmo marketplace são bloqueadas. Identificadores externos podem se repetir em ofertas de vendedores diferentes.

O navegador usado nos cadastros e testes manuais pertence a `o-espertinho-extractor`. O backend chama `POST /v1/extractions` na porta 3011, usando `MANUAL_EXTRACTOR_URL` e `MANUAL_EXTRACTION_SERVICE_TOKEN`. O extrator manual não acessa o banco. Seus comandos na raiz são `extractor:up`, `extractor:logs` e `extractor:down`.

O job de preços possui navegador próprio e usa a mesma biblioteca privada. Ele extrai preço e referência e usa título e URL de destino para conferir a página. Não altera o produto escolhido pelo administrador nem deriva identificadores de marketplace. O identificador técnico do link cadastrado é um hash de sua URL e do marketplace.

Os dois containers executam Chromium/Xvfb sem abrir janelas no computador do usuário. A extração valida HTTPS, domínios e IPs públicos, bloqueando destinos privados. O job possui conta PostgreSQL exclusiva e nenhum endpoint HTTP. Falhas de acesso ou dados incompletos preservam o último preço e histórico conhecidos e marcam atualização pendente.

### Job independente de preços

Na raiz:

```powershell
npm run price-job:up
npm run price-job:logs
npm run price-job:down
```

No primeiro uso, execute o setup da raiz ou, na pasta `o-espertinho-job-update-price`, `npm run setup:env` e `npm run db:provision`. As migrations pertencem ao backend e precisam estar aplicadas. O provisionamento cria somente a conta e suas permissões, sem alterar dados do catálogo.

O `.env` do job contém `DATABASE_URL` da conta restrita e opções do navegador. A conta de migrations é usada apenas durante o provisionamento, nunca pelo container. A biblioteca privada exige `NODE_AUTH_TOKEN` com `read:packages` na instalação/build; uma imagem validada no CI pode ser reutilizada sem o token no runtime. Consulte o README do job para os detalhes.

Os antigos comandos `extraction:*` e o diagnóstico gráfico foram removidos. Para testar um link manualmente, use o teste de seletores e a prévia no admin, atendidos pelo novo extrator.

### Portas locais no Windows

A API e os proxies do Angular/SSR usam 3000; o PostgreSQL usa 5432 no host e no container; o extrator manual usa 3011 e o frontend 4200; o job não publica portas. As portas 3000 e 5432 precisam estar livres antes de iniciar o Espertinho. Ao alterar o mapeamento, `npm run db:up` recria o container do banco mantendo o volume `espertinho_postgres_data`.


### Comandos independentes de desenvolvimento

Execute os comandos na raiz. Cada processo tem seu próprio ciclo de execução:

| Parte | Iniciar | Encerrar | Endereço local |
|---|---|---|---|
| Frontend Angular | `npm run dev:frontend` | Ctrl+C no mesmo terminal | http://localhost:4200 |
| Backend Node | `npm run dev:backend` | Ctrl+C no mesmo terminal | http://127.0.0.1:3000 |
| Extrator manual | `npm run extractor:up` | `npm run extractor:down` | http://127.0.0.1:3011 |
| Job de preços | `npm run price-job:up` | `npm run price-job:down` | Sem porta HTTP |
| PostgreSQL | `npm run db:up` | `npm run db:down` | 127.0.0.1:5432 |

`npm run dev` é somente um atalho para o frontend. Frontend e backend executam no terminal em que o comando foi chamado, usando os comandos nativos de Angular e tsx. Não há supervisor, grupos destacados ou execução conjunta. Os comandos de banco indicam explicitamente o serviço postgres; parar o banco não para o extrator e preserva o volume de dados.

O backend precisa do PostgreSQL disponível para iniciar; o frontend precisa da API em 3000 para carregar dados. O extrator é necessário para testar seletores e obter previews por links. Ter os containers ativos não inicia a API Node. Se o frontend mostrar ECONNREFUSED em 3000, confira o terminal de `dev:backend`: a inicialização bem-sucedida mostra `API: http://localhost:3000/api`. A configuração de porta é a mesma com containers ligados ou desligados.


### Excluir ofertas encerradas

Em Admin → Revisão de ofertas → Exibir: Encerradas, use **Excluir**. O mesmo botão aparece para links encerrados em Admin → Cadastro de links. A confirmação informa a exclusão permanente da oferta e seus favoritos, itens de catálogos e histórico de cliques. Os catálogos dos usuários continuam existindo; apenas a oferta é removida deles. A ação fica registrada na auditoria. Ofertas pendentes, publicadas e rejeitadas não podem ser excluídas por essa operação. Se a oferta for alterada ou reativada em outra sessão, a exclusão é bloqueada até atualizar a tela.

A migration `006_delete_expired_offers.sql` permite remover também as prévias de importação vinculadas, impedindo sua reutilização após a exclusão. `npm run setup` ou `npm run db:migrate` aplica a alteração. O produto pode ser cadastrado novamente depois de excluído, sujeito à revisão normal.


### Produtos e seus links

Em **Admin → Produtos**, cadastre nome, marca/modelo opcionais, categoria, subcategoria opcional, descrição e imagem opcional. O SKU é gerado automaticamente e permanece estável. Os campos de classificação oferecem sugestões existentes e permitem cadastrar novos nomes. Editar a classificação do produto atualiza seus links sem mudar o status comercial das ofertas.

Todo cadastro de link exige escolher um produto existente, inclusive importações pelas APIs e ofertas manuais. Na extração, a prévia guarda o vínculo escolhido; ele não pode ser trocado no pedido de confirmação. Alterações do produto após a prévia exigem nova extração. **Alterar produto** na lista de links permite corrigir um vínculo e devolve a oferta para revisão.

A vitrine mostra um card por produto com ofertas publicadas, disponíveis e com link de afiliado, incluindo as que têm atualização técnica pendente. O card apresenta o menor e o maior preço dessas ofertas; se forem iguais, mostra um único preço. Os preços são os cadastrados, sujeitos às condições de cada oferta, sem cálculo automático de frete. O filtro de loja seleciona produtos com ofertas naquela loja; a faixa continua considerando todas as ofertas disponíveis do produto.

A página `/produto/:id` exibe o produto e todos os seus links disponíveis, ordenados por preço. Sem ofertas disponíveis, continua acessível com **Indisponível**, mas o produto sai da vitrine. As páginas `/oferta/:id`, favoritos e catálogos continuam operando por oferta.

Buscas que gravavam resultados automaticamente como ofertas foram pausadas: a associação ao produto é responsabilidade do administrador. Os conectores continuam disponíveis para importação explícita, renovação de ofertas da API e autenticação.

A migration `008_products.sql` exige que ofertas e prévias antigas estejam vazias. Ela não apaga dados automaticamente. Na implantação inicial deste modelo, a limpeza autorizada de links, prévias e opções de categorias foi executada junto com a migration em uma transação no banco local `espertinho`; usuários, marketplaces, credenciais e seletores foram preservados. Não é necessário repetir a limpeza: `npm run db:migrate` permanece idempotente.

### Swagger / OpenAPI

A interface Swagger fica em `/api/docs/` e o documento OpenAPI 3.0.3 em `/api/openapi.json`. São documentadas as rotas públicas, autenticação, área pessoal e administração, incluindo produtos, ofertas, importações, seletores, integrações e métricas. Operações legadas indisponíveis aparecem como descontinuadas.

No desenvolvimento, abra **http://localhost:4200/api/docs/**, com frontend e backend em execução. Faça login Google no site com a conta apropriada antes de executar operações protegidas. O Swagger usa o cookie HttpOnly de sessão do navegador e preenche automaticamente `X-XSRF-TOKEN` a partir do cookie atual. Antes de cada escrita, consulta `/api/auth/session`, mantendo o token atualizado após login/logout. Não é preciso copiar cookies, tokens ou segredos para o botão Authorize.

O endereço **http://localhost:3000/api/docs/** também exibe a documentação e permite consultas GET. Para POST/PUT/PATCH/DELETE, use a documentação na origem de `APP_ORIGIN` (por padrão, porta 4200), porque a API continua exigindo essa origem. Em produção, publique `/api` e o frontend sob a mesma origem. CORS, validação de origem, autenticação e XSRF não foram flexibilizados para o Swagger.

O JSON pode ser importado em Postman ou ferramentas OpenAPI: **http://localhost:3000/api/openapi.json**. Os exemplos/esquemas não contêm credenciais reais. Valores monetários são em centavos de BRL. Operações de escrita no Swagger executam ações reais e exigem as mesmas permissões da aplicação.

Não há migration para esta funcionalidade. As novas dependências estão no `package-lock.json` do backend e são instaladas pelo setup normal. Os testes validam a especificação, a cobertura das rotas e a preservação das proteções.


### Atualização periódica de preço e disponibilidade

Em **Admin → Atualizações** (`/admin/updates`), configure a automação e acompanhe as rodadas. O padrão é **8 horas entre rodadas**, com **60 segundos de pausa entre consultas**. É possível configurar de 1 a 168 horas e de **100 a 3.600.000 milissegundos** entre consultas. O padrão de pausa é armazenado como 60.000 ms. Os horários agendados permanecem fixos: se uma rodada manual ou automática ainda estiver ativa, a janela é descartada e o job aguarda a próxima, sem acumular rodadas. Uma execução manual não altera a agenda automática. Desativar a automação não interrompe uma rodada em andamento. O botão **Atualizar links agora** funciona mesmo com o agendamento automático desativado, mas ainda exige o worker ativo.

O container `o-espertinho-job-update-price` processa a fila independentemente da API e da manutenção do backend. A pausa configurada é contada após cada consulta; quando ocioso, o job verifica novas rodadas a cada segundo. Uma chamada manual retorna HTTP 202 e o registro da execução; o job inicia o trabalho em segundo plano. O container usa detach e não abre uma janela de console.

Endpoints administrativos (sessão admin + XSRF), também documentados no Swagger:

- `GET /api/admin/offer-refresh`: configuração, execução ativa e últimas 20 rodadas.
- `PUT /api/admin/offer-refresh`: `{ enabled, intervalHours, requestIntervalMs, expectedUpdatedAt }`.
- `POST /api/admin/offer-refresh/run`: enfileira uma rodada manual; 409 se já houver uma ativa.
- `GET /api/admin/offer-refresh/runs/:id`: progresso e últimas 50 ocorrências.

Cada rodada inclui os links publicados, inclusive os marcados como indisponíveis para detectar recuperação. Links rejeitados, pendentes de aprovação ou encerrados manualmente não são republicados pelo job. A oferta só é atualizada se não tiver sido editada ou encerrada desde o início da rodada. Os produtos e links de afiliado originais são preservados.

Para ofertas de API, a consulta usa o conector e a renovação de credenciais já existentes. Para links manuais/extraídos, usa o link de afiliado, o marketplace e os seletores atuais, com o serviço de navegador no container. Identificação divergente, campos obrigatórios ausentes, CAPTCHA, timeout, domínio inválido e falhas HTTP são tratados como problemas técnicos. Uma página identificada corretamente, mas sem preço, marca a oferta como indisponível. Ausência de resultado confirmada pelo conector de API também a torna indisponível.

Sucesso atualiza preço, condições e `data_updated_at`, mesmo se o preço continuar igual, mantendo a aprovação. Erro técnico mantém o preço, a disponibilidade conhecida e a data de sucesso anterior, define `refresh_status=pending` e registra motivo/horário da tentativa. O card exibe **Atualização pendente** no lugar da data e o link continua na vitrine e nos catálogos. A validade antiga de `expires_at` não expira automaticamente uma oferta publicada; a disponibilidade passa a ser explícita. Validades de prévias, sessões e OAuth continuam sendo verificadas normalmente.

Um bloqueio de sessão no PostgreSQL impede consultas simultâneas mesmo entre processos e quando uma extração ultrapassa o prazo de retomada do item. Uma consulta automática ocorre por vez; a pausa é persistida e respeitada também entre rodadas manuais. Após falha técnica, a pausa é de pelo menos cinco minutos. Não há repetição imediata do link que falhou: ele será consultado na próxima rodada. Relógio do PostgreSQL governa agendamento, pausas e retomada. O painel mostra progresso, quantidades atualizadas/indisponíveis/pendentes/ignoradas e detalhes de erros.

A migration `010_offer_refresh.sql` adiciona os estados, configurações e fila sem apagar produtos ou links. O cadastro inicial recebe como data de atualização a data de verificação existente. A primeira execução automática é agendada para oito horas após a migration; use o disparo manual para antecipá-la. O volume de links e a pausa determinam a duração da rodada; o intervalo configurado não faz a fila sobrepor execuções.

A migration `011_offer_refresh_milliseconds.sql` converte a pausa existente para milissegundos sem alterar sua duração e mantém os dados do catálogo. Alterar apenas a pausa preserva a agenda; habilitar a automação ou mudar o intervalo em horas define uma nova agenda a partir do salvamento.

A migration `012_remove_shopee.sql` limpa o marketplace retirado, suas ofertas e dependências. Produtos são independentes das lojas e permanecem cadastrados. As credenciais das APIs Amazon/Mercado Livre continuam no backend para os links existentes; o fluxo principal de cadastro usa seletores e prévia.

Os logos das lojas são configurados em **Admin → Marketplaces → URL do logo oficial**. A vitrine lê as lojas e os logos do banco, incluindo marketplaces personalizados. Use URLs HTTPS de imagens oficiais, inclusive CDNs das próprias lojas; o navegador carrega a imagem diretamente, sem um serviço externo de favicons. Se ela falhar ou não for informada, a inicial e o nome da loja permanecem visíveis. A migration `013_marketplace_logos.sql` cadastra ícones oficiais para as lojas existentes.

O SKU interno do produto é exclusivo da administração: não é renderizado nas páginas públicas, não integra as respostas públicas de produtos e não é pesquisável na vitrine. A identificação técnica usada nas URLs permanece independente do SKU.

### Páginas institucionais e dados do responsável

Sobre, Privacidade e Termos usam `2-frontend/src/app/pages/legal.page.html`. Dados de identificação e contato ficam em `2-frontend/src/app/legal-information.ts`. A revisão textual de 16/10/2026 considerou LGPD, CDC, Marco Civil e orientações da ANPD e descreve as funcionalidades efetivamente presentes; não representa certificação de conformidade.

Antes da publicação, completar a identidade do controlador, eventual inscrição aplicável, endereço público de atendimento e informações reais de hospedagem/operadores/países e backups. Os campos ainda não confirmados permanecem vazios para não publicar informações inventadas. O e-mail foi mantido do contato que já existia no site.

A revisão jurídica e operacional deve confirmar o enquadramento no Decreto 7.962/2013, a eventual guarda de registros do art. 15 do Marco Civil (métricas de cliques não substituem registros de acesso), mecanismos de transferência internacional e a aplicação do ECA Digital. Não foram implementadas coleta de idade, retenção de IPs, aceite versionado ou contratos com fornecedores por meio desta alteração de textos. Atendimento de direitos e comunicação de incidentes exigem procedimentos efetivos do responsável, além de páginas informativas.

Referências oficiais: [LGPD](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm), [CDC](https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm), [Marco Civil](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2014/lei/l12965.htm), [Decreto 7.962/2013](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm), [ANPD: cookies](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-cookies-e-protecao-de-dados-pessoais.pdf), [transferências internacionais](https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados), [ECA Digital](https://www.gov.br/anpd/pt-br/assuntos/eca-digital/).

## Hierarquia de categorias

Produtos exigem uma categoria e aceitam até nove subníveis opcionais (10 níveis no total). Em Administração → Produtos, cada campo permite escolher uma opção da ramificação atual ou digitar uma nova. As opções são persistidas ao salvar o produto; alterar um nível limpa seus descendentes no formulário. A edição da classificação atualiza os links vinculados e invalida prévias antigas pelo controle de versão do produto.

A migration `015_category_hierarchy.sql` preserva produtos, links e opções anteriores. O banco valida profundidade, nomes e caminhos, reaproveitando a grafia cadastrada sem diferenciar maiúsculas/minúsculas dentro de cada ramificação. Categorias com nomes iguais em ramificações diferentes têm identidades próprias.

A API recebe `categoryPath: ["Informática", "Acessórios", "Áudio e vídeo", "Fones de ouvido"]` no cadastro/edição de produtos. As respostas incluem `category_path` e `category_ids`, alinhados por nível. `GET /api/category-tree` e `GET /api/admin/category-tree` listam `{id, path, depth}`; a segunda rota exige admin. O filtro `categoryId` em `/api/products` e `/api/offers` inclui produtos daquele nível e de todos os seus descendentes, sem duplicar produtos. Os campos antigos `category`/`subcategory` e o filtro por categoria raiz continuam compatíveis.

Cada breadcrumb abre uma vitrine compartilhável em `/?categoryId=UUID#ofertas`; os filtros salvos também preservam a ramificação. Produtos sem links disponíveis continuam acessíveis na página direta, mas ficam fora das vitrines.

## Histórico de preços

A migration `016_daily_price_history.sql` cria um histórico por link e dia (`offer_id`, `day`), com preço em centavos e data/hora da observação. O dia usa `America/Sao_Paulo`, independentemente do fuso do servidor. Cada atualização bem-sucedida do job, mesmo sem mudança de preço, faz um upsert na mesma transação da oferta. A última atualização do dia substitui a anterior; falhas técnicas e itens ignorados não alteram o histórico. Indisponibilidade confirmada grava preço nulo. A manutenção conserva os últimos 365 dias inclusivos. Excluir o link também exclui seu histórico; reassociar o link a outro produto não transfere as observações de dias anteriores.

A migração aproveita somente a última observação conhecida dos links publicados, dentro do período de retenção. Não são gerados preços retroativos. Novos links começam a acumular observações quando passam pelo job.

Os cards mostram os últimos 90 dias em nove intervalos de dez dias. Para produtos, primeiro é calculado o menor preço observado entre os links em cada dia. O ponto de cada intervalo representa seu último dia observado, e a data efetiva é exibida na consulta do ponto. Intervalos sem observações ou com indisponibilidade confirmada ficam sem preço; não se transportam valores antigos nem se usam zeros. No gráfico ampliado é possível escolher 7, 30, 90, 180 ou 365 dias, ou um período personalizado de até 365 dias inclusivos. Intervalos automáticos: 1 dia até 31 dias, 5 dias até 60, 10 dias até 120, 15 dias até 180 e 30 dias até um ano. A tabela detalhada mantém todas as observações diárias do período.

`GET /api/price-history?kind=product&ids=UUID,UUID&days=90` consulta até 48 IDs por chamada; `kind=offer` consulta links individuais. `from=YYYY-MM-DD&to=YYYY-MM-DD` substitui `days`; `details=true` inclui os registros diários. A documentação está no Swagger. O frontend agrupa as consultas dos cards e mantém um cache curto de um minuto. Os gráficos SVG são responsivos, compatíveis com os temas e permitem consultar valores com mouse ou teclado. Não há nova dependência nem serviço adicional.

A tarja laranja “Menor preço registrado!” compara o preço atual com o menor preço diário de **qualquer link do mesmo produto** nos últimos 90 dias (`productLowestPriceCents90d`). Em cards de links, também exige que o link tenha o menor preço atual entre as ofertas publicadas e disponíveis (`isCheapestOffer`). Empates são elegíveis. Sem histórico a tarja fica oculta. O gráfico de cada link continua individual; ampliar seu período não altera a referência de 90 dias da tarja.

## Sessão persistente e retorno com Google

Sessões autenticadas e cookies `espertinho.sid`/`XSRF-TOKEN` duram 30 dias. A API renova a validade durante o uso, no máximo uma vez por dia, preservando SID e XSRF para não interromper outras abas. Sessões válidas emitidas com a duração antiga são ampliadas no próximo acesso; sessões já expiradas exigem nova autenticação. Sessões anônimas continuam com 12 horas. Em produção os cookies usam Secure; SID e o indicador de saída usam HttpOnly. Não há migration ou nova credencial.

Depois de um login neste navegador, um indicador local permite uma tentativa opcional do Google One Tap quando não houver mais sessão válida. O SDK é carregado uma vez, com auto_select e FedCM, sem bloquear a vitrine. O token recebido continua validado no backend e é protegido por XSRF. Não são guardados tokens Google no localStorage nem solicitados refresh tokens. Google/navegador podem exigir confirmação; cancelar, bloquear o SDK ou estar sem sessão Google mantém a navegação anônima e o botão manual disponível.

Sair chama cancel/disableAutoSelect do Google, registra a preferência no navegador e um cookie HttpOnly de saída no backend e revoga a sessão. Tentativas automáticas com esse cookie são recusadas; somente um novo login manual limpa a escolha de sair. A preferência local também bloqueia chamadas tardias e informa outras abas abertas. A exclusão da conta aplica o mesmo bloqueio, evitando recriação automática.

## Usuários e perfis de acesso

A migration `017_user_access.sql` preserva as contas e cria os perfis Administrador, Usuário e Editor de catálogo. Usuários são cadastrados ao entrar com Google. Na administração, as abas **Usuários** e **Perfis de acesso** permitem pesquisar e filtrar contas, atribuir perfis, bloquear/desbloquear usuários e criar/editar/excluir perfis personalizados. Nome, avatar e e-mail continuam vinculados à identidade Google.

As permissões agrupam consulta e alteração por área: `overview` (métricas), `catalog` (produtos, links e revisão), `marketplaces` (marketplaces e integrações), `selectors` (seletores/testes), `updates` (job), `activity` (auditoria) e `users` (usuários/perfis). A permissão `users` permite conceder acesso administrativo e deve ser reservada a pessoas de confiança. Perfis sem permissões acessam somente a conta pessoal. Administrador tem acesso completo; os perfis padrão Administrador e Usuário não podem ser alterados ou excluídos. Perfis associados a usuários não podem ser excluídos.

As permissões são verificadas no backend e consultadas no banco em cada requisição. Bloquear uma conta encerra suas sessões e impede novos logins Google; desbloquear permite novo login. Não é permitido alterar o próprio acesso nem remover/bloquear o último administrador ativo. Mudanças de acesso são serializadas no banco para proteger essa regra em alterações simultâneas. Alterações de usuário e perfil possuem controle de conflito e registro de auditoria, na mesma transação.

Endpoints documentados no Swagger: `GET/PATCH /api/admin/users` (PATCH com `/:id`) e `GET/POST/PUT/DELETE /api/admin/access-profiles` (PUT/DELETE com `/:id`). Mantêm autenticação, autorização e XSRF. A interface esconde áreas não autorizadas e redireciona para a primeira área permitida. As alterações de permissões passam a valer nas próximas requisições; uma aba aberta antes da alteração pode precisar ser recarregada para atualizar a navegação.

## Descoberta manual de vitrines

O projeto `o-espertinho-job-discovery` é independente do backend, do extrator manual e do job de preços. Após as migrations e o provisionamento da conta dedicada, use `npm run discovery-job:up`, `npm run discovery-job:logs` e `npm run discovery-job:down`. O setup também prepara e inicia esse container com detach. Ele consome exclusivamente pedidos manuais feitos em Admin → Exploração e não agenda execuções. Consulte o README do projeto para limites, pausas, cancelamento e fila.

## Enriquecimento manual dos links descobertos

O serviço `o-espertinho-job-enrich-links` consome os lotes solicitados na Revisão de ofertas. `npm run setup` aplica a migration e provisiona/inicia o container separado em segundo plano. Comandos independentes: `npm run enrichment-job:up`, `npm run enrichment-job:down`, `npm run enrichment-job:logs`. Não há agendamento. Categoria de origem é preservada; mapeamentos anteriores apenas preenchem sugestões que exigem confirmação por item.
