# Revisão do catálogo com IA

## Operação

Admin → Revisão → Configurações de IA mantém ativações e prompts independentes. Salvar exige as permissões atuais, XSRF e autenticação administrativa recente. Cada tarefa tem sua própria revisão.

Na extensão, entre no Espertinho e no ChatGPT, escolha um modelo e inicie a tarefa desejada. Marketplace e máximo de itens delimitam a fila, sem limitar o inventário de comparação.

- **4 — Catalogar produtos:** consulta todos os produtos e rascunhos. Reutilizar um produto existente confirma o vínculo e herda sua categoria. Uma identidade nova gera um rascunho compartilhável, ainda sem criar produto público.
- **5 — Categorizar produtos:** compara os rascunhos com todas as árvores existentes. A decisão válida reutiliza ou cria a árvore, cria o produto com categoria obrigatória e atribui todos os links relacionados. Um rascunho é categorizado uma única vez.
- **6 — Analisar Preços:** etapa independente, separada por divisor.

Os contadores do passo 4 incluem produtos atribuídos e rascunhos identificados / links não arquivados e não publicados. Os do passo 5 mostram produtos com categoria confirmada / links já catalogados. Somente links enriquecidos são analisados. As duas tarefas exigem suas flags habilitadas e login ChatGPT.

Decisões válidas são aplicadas automaticamente. Ambiguidades ficam pendentes para revisão manual e podem ser descartadas para nova análise. Publicação permanece uma confirmação explícita. O admin permite trocar o produto ou corrigir sua categoria, propagando-a aos vínculos relacionados. Produtos existentes nunca ficam sem categoria; novos aguardam a categorização em uma tabela de rascunhos.

## Inventário e reutilização

O painel baixa o inventário completo por páginas consistentes, usando uma revisão comum. Produtos são comparados globalmente em blocos de 30; categorias em blocos de 100, com seleção final entre candidatos. Não há truncamento silencioso do catálogo. Antes de aceitar uma criação, percorre todos os blocos pertinentes. Cada resultado atualiza o cache em memória, incluindo categorias e rascunhos recém-criados, para reutilização nas próximas ofertas.

O servidor também reaproveita identidades exatas normalizadas e caminhos equivalentes conservadores na mesma árvore. Descrição, marca e imagem vêm dos dados extraídos/revisados; a IA não fornece URL de imagem. Modelo, geração, RAM física, armazenamento e tamanho de tela diferentes definem produtos diferentes. Cor, tensão e tamanho de vestuário/calçado isolados não definem outro produto. Kits personalizados têm identidade própria por anúncio. A inferência pode errar semanticamente: revise antes de publicar.

## Segurança e consistência

Credenciais ChatGPT permanecem no navegador, cifradas no cofre local da extensão para restauração de sessão e modelo. O backend recebe decisões estruturadas, nunca cookies ou tokens OpenAI. Permissões, flags, propriedade, expiração, revisão do inventário, versão do link, tarefa e rascunho são verificados no servidor. Resultados inválidos ou obsoletos são rejeitados.

Aplicação e auditoria são transacionais. Reenvio idêntico é idempotente; resposta diferente para a mesma solicitação é rejeitada. Escritas concorrentes são serializadas, com espera curta e conflito explícito. Alterar os dados identificadores da oferta invalida seu rascunho. Cancelamento/falha libera a reserva e não desfaz decisões anteriores; fechamento abrupto pode exigir aguardar sua expiração de até 10 minutos. Não há repetição automática de inferência nem lógica fixa por marketplace.

## Migrations e testes

Migrations 035 e 036 são aditivas: rascunhos, revisão do inventário e invalidação de identidade. Execute npm run db:migrate antes de usar as rotas. O Swagger inclui inventário paginado, filas, contexto e aplicação.

Testes cobrem reutilização global, herança da categoria, rascunhos compartilhados, aplicação automática, publicação manual, inventários maiores que um bloco, cache atualizado, ambiguidades, permissões, flags, versões e replay. Chromium real usa serviços e respostas simulados; este ciclo não executou inferência com a conta real.

O painel usa uma barra de progresso para a tarefa atual e separa decisões aplicadas, revisões, anúncios inválidos e falhas. Não exibe consumo da conta ChatGPT.

## Entrega

- [x] Passo 4 cataloga globalmente e reutiliza cadastros/rascunhos.
- [x] Passo 5 categoriza os novos produtos e confirma vínculos válidos.
- [x] Inventário completo e cache atualizado em memória.
- [x] Revisão permite correções; publicação permanece manual.
- [x] Limpeza local sem backup: produtos, ofertas, links descobertos e dependências zerados; preservados 12 nós de categorias, usuários, 2 marketplaces e configurações/URLs de vitrines.
- [x] Testes de backend, frontend e extensão.
- [x] Commits enviados e pipelines acionados nas PRs existentes #16/backend, #18/frontend e #9/extensão.

## Publicação em massa e teste limpo

A revisão permite selecionar links aptos entre páginas (até 100), com confirmação única de autorização para divulgação. POST /api/admin/discovery/enrichment/review/publish-batch recebe IDs e versões explícitos. Cada item passa pela mesma transação e validações da publicação individual; pendências, dados vencidos, versões alteradas e marketplaces desativados são recusados sem bloquear os demais. O retorno informa sucesso ou motivo de recusa por link. Reenvio não duplica ofertas, histórico ou auditoria. Permissões, XSRF e confirmação administrativa recente permanecem obrigatórios.

Novo ciclo de teste: removidos 46 produtos, 54 links descobertos, 3 ofertas, 46 rascunhos e dependências de processamento, sem backup. Preservadas 41 categorias, 2 marketplaces, usuários, coleções e configurações/perfis/URLs de vitrines.

Na extensão, a barra única conta links processados (incluindo pendências), enquanto o contador de catalogação conta somente links vinculados ou identificados como rascunho. O caso 47/51 continha 47 links catalogados, 43 identidades distintas e 4 decisões needs_review, não um erro de deduplicação de produtos.


## Política e reprocessamento — 22/10/2026

A migration 039 adiciona personalized_kit aos produtos e rascunhos e atualiza os dois prompts configurados, incrementando suas versões. As flags de ativação são preservadas. O contexto lê o prompt atual do banco; a extensão inclui literalmente essas instruções na chamada ao modelo, além das regras de segurança e do contrato JSON. O mapeamento de categoria anterior também é entregue ao modelo.

- Modelo, RAM, armazenamento e tela distintos não são equivalentes. Modelos alternativos no mesmo anúncio sem seleção explícita continuam em revisão: o vínculo atual é de um link para um produto, sem criar várias identidades por suposição.
- Qualquer contradição factual interna fornecida exige invalid, com motivo, sem vínculo, criação ou publicação. Ausência de dados e alternativas de variantes não são contradição por si só. Não inferir inconsistência por desconhecer um modelo recente.
- Kits personalizados usam product.personalizedKit=true. A deduplicação considera o anúncio, mesmo com nomes e marcas iguais; a categorização cria produtos independentes. O AI link_existing recusa produtos/rascunhos marcados como kit personalizado. Produtos anteriores não são reclassificados ou reunidos automaticamente.
- O controle Reprocessar somente itens em revisão nos passos 4 e 5 seleciona exclusivamente decisões needs_review do marketplace e tarefa. Fila é somente leitura; contexto reserva cada item transacionalmente, impedindo sobrescrita de outra análise. Cancelamento/falha libera a reserva sem apagar o estado de revisão. Desmarque para processar itens novos.
- Inválidos ficam visíveis no admin com motivo e filtro próprio. Publicação individual/em massa e atribuição/categorização são recusadas no servidor. Use Extrair novamente para reavaliar no menu, execute passo 3 e depois passo 4 (e 5 quando necessário). Somente uma extração bem-sucedida remove o bloqueio anterior; falhas técnicas e o simples agendamento não o removem.
- Produtos são comparados em lotes e os vínculos candidatos são consolidados antes da decisão final; dúvida de lote irrelevante não veta criação. Até 100 categorias são avaliadas juntas; ancestrais genéricos podem receber novos descendentes, preservando as árvores existentes.

Aplicação local preservou 151 links e 111 produtos. Não houve limpeza, publicação ou inferência real com a conta do administrador. Workflows continuam disabled_manually; as PRs existentes são atualizadas.

Validação local: nove testes de revisão por IA, três de enriquecimento (incluindo inválido → extração → nova fila), três de publicação e quatro de Swagger aprovados em banco isolado. Extensão: check completo com 112 testes aprovados e dois nativos opt-in executados separadamente com sucesso; cenários de IA revalidados após o envio de especificações. Frontend: typecheck e duas jornadas de revisão no navegador aprovados. Fila real consultada somente em leitura encontrou 3/8/18 itens em revisão por marketplace, sem iniciar inferência.
