# O Espertinho — backend

API Express/TypeScript e PostgreSQL. A extensão executa navegação; a API autentica, fornece snapshots, reserva itens, valida resultados e mantém revisão/publicação e histórico. Mobile fora do escopo.

## Desenvolvimento

Use Node 24. Na raiz do workspace, `npm run setup` prepara os três projetos ativos e sobe somente PostgreSQL com detach. Em seguida execute `npm run dev:backend` e `npm run dev:frontend` em terminais separados.

Neste repositório: `npm ci`, `npm run setup:env`, `npm run db:migrate`, `npm run dev`. Scripts não imprimem segredos e preservam `.env` existente. Configure GOOGLE_CLIENT_ID; a conta administrativa continua reconhecida após login Google verificado. Não há senha padrão nem bypass de autenticação de produção.

Migrations novas: 029 adiciona filas persistidas e seleção de executor; 030 copia receitas da POC sem apagar registros ou habilitar execução automaticamente. Migrations antigas não foram reescritas. Aplique com a conta de migrations; produção usa DATABASE_URL restrita e separada de MIGRATION_DATABASE_URL. Faça backup do banco e da ENCRYPTION_KEY antes de atualizar ambiente real.

## Configuração e execução

Em Admin → Marketplaces → Execução pela extensão, configure o executor, receita e regras genéricas de login, desafio, acesso negado, limite e indisponibilidade. Cadastre perfis/fontes de exploração e seletores normalmente. O executor começa como legacy para preservar o ambiente anterior; a troca é bloqueada se houver execução antiga ou nova em andamento.

A extensão usa `/api/extension/auth/*` para pareamento com prova de posse, sessão Google e XSRF na aprovação. Recebe token opaco com rotação, verifica a permissão affiliate_links e permissões adicionais de cada etapa. Logout, bloqueio e remoção de acesso invalidam chamadas. Tokens da API não são enviados ao marketplace.

Operações reais: `/api/extension/catalog/config`, `/catalog/runs`, `/catalog/runs/:id`, `/claim`, `/heartbeat`, `/results`, `/action` e `/items`. Uma execução por marketplace, reserva de três minutos, snapshot versionado, prazo de intervenção e gravações idempotentes. Cancelamento recusa respostas tardias. A extensão não acessa o banco diretamente e não envia cookies, storage ou headers do marketplace.

Admin: `/api/admin/extension-catalog/settings/:id`, `/runs`, `/runs/:id/items`, `/runs/:id/cancel` e `/manual/:id`. Configuração usa XSRF e confirmação administrativa recente. A API autoriza e valida independentemente da interface.

Revisão: categoria de origem e sugestão de mapeamento não equivalem à confirmação. Atribuir produto exige categoria confirmada. Publicar exige vínculo compatível, URL e dados válidos, confirmação explícita e observação recente; é idempotente. Produtos podem existir sem ofertas, mas ofertas exigem produto.

Em marketplaces migrados, prévia manual e teste de seletores retornam 202 com executionId. O admin acompanha a solicitação e permite cancelar; a extensão a processa. Confirmar a prévia continua sujeito ao produto/perfil original e à expiração.

Preço e histórico são atualizados na mesma transação: um preço por oferta/dia de America/Sao_Paulo, sobrescrito somente por observação mais recente. Falhas técnicas preservam preço/disponibilidade e marcam Atualização pendente. Indisponibilidade exige indicador explícito. A publicação mantém agregação por produto e árvores de até dez níveis.

Swagger/OpenAPI: `/api/docs/` e `/api/openapi.json`; produção exige autorização administrativa conforme configuração existente. Nenhum endpoint de demonstração, captura de sessão ou prova de conversão permanece registrado.

## Migração e recuperação

Consulte `docs/PLANO-MIGRACAO-CATALOGO-EXTENSAO.md` e `docs/CATALOG-MIGRATION-INVENTORY.md`. O workspace principal mantém o documento sincronizado a cada fase.

O job legado de preços precisa da alteração que exclui marketplaces da extensão. Serviços antigos, contas e tabelas de histórico operacional permanecem temporariamente disponíveis para recuperação até a homologação real. Eles não são iniciados pelo setup normal. Não execute dois consumidores sobre as mesmas filas e não apague volumes.

O worker interno continua responsável pela manutenção sem navegador. Integrações históricas e seu extrator manual só ficam no caminho de recuperação dos marketplaces ainda não migrados; não são necessários ao novo fluxo. Documentação anterior está em docs/history.

## Validação

`npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`. Testes SQL usam PGlite descartável; testes PostgreSQL reais exigem URL explícita de ambiente de teste. Nenhum teste normal usa DATABASE_URL pessoal. O teste de backup restaura uma cópia isolada antes de comparar os dados.

A extensão tem teste adicional em Chromium real com HTTPS e API controlados. Isso não substitui homologar sua sessão real, seletores e um pequeno lote autorizado em cada marketplace. Não há contorno de login/CAPTCHA, perfis ocultos ou exportação de sessão.
