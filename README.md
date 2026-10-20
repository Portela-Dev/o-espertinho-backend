# O Espertinho — backend

API Express/TypeScript e PostgreSQL. A extensão executa navegação; a API autentica, fornece snapshots, reserva itens, valida resultados e mantém revisão/publicação e histórico. Mobile fora do escopo.

## Desenvolvimento

Use Node 24. Na raiz do workspace, `npm run setup` prepara os três projetos ativos e sobe somente PostgreSQL com detach. Em seguida execute `npm run dev:backend` e `npm run dev:frontend` em terminais separados.

Neste repositório: `npm ci`, `npm run setup:env`, `npm run db:migrate`, `npm run dev`. Scripts não imprimem segredos e preservam `.env` existente. Configure GOOGLE_CLIENT_ID; a conta administrativa continua reconhecida após login Google verificado. Não há senha padrão nem bypass de autenticação de produção.

Migrations novas: 029 adiciona filas persistidas e seleção de executor; 030 copia receitas da POC sem apagar registros ou habilitar execução automaticamente. Migrations antigas não foram reescritas. Aplique com a conta de migrations; produção usa DATABASE_URL restrita e separada de MIGRATION_DATABASE_URL. A migration 031 encerra filas/agendamentos antigos e fixa extension como único executor. Preserve o backup anterior e sua chave de arquivo cifrado; ENCRYPTION_KEY não é usada pelo runtime atual.

## Configuração e execução

Em Admin → Marketplaces → Execução pela extensão, configure receita e regras genéricas de login, desafio, acesso negado, limite e indisponibilidade. Cadastre perfis/fontes de exploração e seletores normalmente. Todo marketplace usa a extensão, inclusive novos cadastros; não há opção de reativar workers antigos.

A extensão usa `/api/extension/auth/*` para pareamento com prova de posse, sessão Google e XSRF na aprovação. Recebe token opaco com rotação, verifica a permissão affiliate_links e permissões adicionais de cada etapa. Logout, bloqueio e remoção de acesso invalidam chamadas. Tokens da API não são enviados ao marketplace.

Operações reais: `/api/extension/catalog/config`, `/catalog/runs`, `/catalog/runs/:id`, `/claim`, `/heartbeat`, `/results`, `/action` e `/items`. Uma execução por marketplace, reserva de três minutos, snapshot versionado, prazo de intervenção e gravações idempotentes. Cancelamento recusa respostas tardias. A extensão não acessa o banco diretamente e não envia cookies, storage ou headers do marketplace.

`GET /api/extension/catalog/stats?marketplaceId=...&retryFailed=false` fornece os contadores do painel autenticado: conversões e extrações pendentes / links descobertos não arquivados; preços sem verificação bem-sucedida nas últimas 24 horas / ofertas publicadas com link de afiliado. Extrações com falha entram nos elegíveis quando retryFailed=true. Campos de extração e preços são nulos sem as permissões catalog e updates, respectivamente. Falhas técnicas não renovam data_updated_at. Os contadores não modificam a seleção das execuções nem seu limite de itens.

Admin: `/api/admin/extension-catalog/settings/:id`, `/runs`, `/runs/:id/items`, `/runs/:id/cancel` e `/manual/:id`. Configuração usa XSRF e confirmação administrativa recente. A API autoriza e valida independentemente da interface.

Revisão: categoria de origem e sugestão de mapeamento não equivalem à confirmação. Atribuir produto exige categoria confirmada. Publicar exige vínculo compatível, URL e dados válidos, confirmação explícita e observação recente; é idempotente. Produtos podem existir sem ofertas, mas ofertas exigem produto.

Prévia manual e teste de seletores retornam 202 com executionId. O admin acompanha a solicitação e permite cancelar; a extensão a processa. Confirmar a prévia continua sujeito ao produto/perfil original e à expiração.

Preço e histórico são atualizados na mesma transação: um preço por oferta/dia de America/Sao_Paulo, sobrescrito somente por observação mais recente. Falhas técnicas preservam preço/disponibilidade e marcam Atualização pendente. Indisponibilidade exige indicador explícito. A publicação mantém agregação por produto e árvores de até dez níveis.

Swagger/OpenAPI: `/api/docs/` e `/api/openapi.json`; produção exige autorização administrativa conforme configuração existente. Nenhum endpoint de demonstração, captura de sessão ou prova de conversão permanece registrado.

## Migração e recuperação

Consulte `docs/PLANO-MIGRACAO-CATALOGO-EXTENSAO.md` e `docs/CATALOG-MIGRATION-INVENTORY.md`. O workspace principal mantém o documento sincronizado a cada fase.

Jobs/extrator/pacote Node foram descontinuados. Não há rota, variável de runtime ou dependência de navegador para esses serviços. Históricos antigos e credenciais cifradas são preservados como arquivo, sem acesso pela conta de runtime; somente discovery_runs recebe SELECT para conferir referências ao excluir configurações. Recuperação anterior ao corte exige backup e versões compatíveis; rollback apenas da imagem não desfaz migrations.

O worker interno executa somente manutenção de sessões, prévias expiradas, auditoria, cliques e retenção de preços. O setup gera senhas distintas para a conta de migrations e a conta espertinho_app, e db:migrate provisiona os grants restritos. Em ambientes existentes, configurar as duas URLs antes de aplicar migration/provisionamento; não usar a conta dona do banco como runtime. Exemplos não incluem segredos do marketplace.

## Validação

`npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`. Testes SQL usam PGlite descartável; testes PostgreSQL reais exigem URL explícita de ambiente de teste. Nenhum teste normal usa DATABASE_URL pessoal. O teste de backup restaura uma cópia isolada antes de comparar os dados.

A extensão tem teste adicional em Chromium real com HTTPS e API controlados. Isso não substitui homologar sua sessão real, seletores e um pequeno lote autorizado em cada marketplace. Não há contorno de login/CAPTCHA, perfis ocultos ou exportação de sessão.

## Administração reorganizada

A consulta administrativa de ofertas inclui o nome/SKU do produto e o marketplace para a listagem única do frontend, mantendo a permissão catalog. As permissões existentes permanecem com os mesmos IDs; o rótulo updates descreve consulta de execuções e atualização de preços. A centralização visual não altera as verificações de etapa no cancelamento.

O cadastro de fontes não aceita mais intervalHours e não atualiza interval_hours. A coluna histórica permanece preservada no banco, sem consumidor de agendamento; não há migration destrutiva nem mudança nas URLs/perfis de vitrines. Habilitação da fonte, paginação e intervalo entre requisições continuam operacionais.
