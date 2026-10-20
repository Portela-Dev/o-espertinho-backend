# Revisão assistida por IA

## Operação

Admin → Revisão → Configurações de IA contém ativações e prompts independentes para categorização e catalogação. Ambas começam desativadas. Salvar exige as permissões atuais da revisão, XSRF e autenticação Google recente. Cada tarefa tem sua própria revisão: alterações em uma não invalidam a outra.

No painel lateral da extensão, entre no Espertinho e no ChatGPT, selecione um modelo e autorize o envio do lote. O marketplace e o máximo de itens por execução delimitam as filas. Os novos passos são:

- 4 — Categorizar produtos: categorias confirmadas / total de links não arquivados e não publicados do marketplace. Só analisa links enriquecidos sem categoria confirmada.
- 5 — Catalogar produtos: produtos atribuídos / total de links com categoria confirmada. Só analisa links enriquecidos, com categoria confirmada e sem produto.
- 6 — Analisar Preços: atualização independente, separada por divisor horizontal.

As sugestões não contam como categorias/produtos confirmados. Após cada lote, no site, use Categorizar ou Atribuir Produto para revisar os dados preenchidos. É possível criar uma nova árvore, editar o produto sugerido, escolher outro existente ou descartar a sugestão e gerar outra. Publicar permanece uma confirmação separada.

## Segurança e consistência

A extensão faz inferência diretamente na OpenAI com credenciais exclusivamente em memória. O backend recebe apenas sugestões estruturadas e o identificador de uma solicitação, nunca tokens OpenAI. As rotas da extensão exigem conta Espertinho autorizada com catálogo e geração de links; o servidor verifica flags, tarefa, propriedade, expiração e versões. Não há código específico por marketplace.

Cada contexto reserva um link por até 10 minutos. O contexto é vinculado ao usuário, à versão do enriquecimento, à revisão do prompt/tarefa, à categoria confirmada e aos produtos candidatos. Cancelamento/falha libera a reserva; fechamento abrupto pode exigir aguardar sua expiração. Respostas obsoletas não são aplicadas. Reenvio da mesma resposta é idempotente. Erros interrompem o lote sem repetir inferência automaticamente; sugestões já enviadas permanecem para revisão.

O backend seleciona até 100 árvores relevantes, priorizando mapeamento anterior e texto de origem/oferta. Para catalogação, busca até 30 produtos na categoria confirmada e subcategorias, ordenados por relevância textual e marca. Os candidatos podem ser parciais: o prompt informa isso, e ausência de candidato não comprova inexistência. A IA só pode vincular IDs incluídos no contexto. Nome, descrição e marca de novos produtos seguem os limites do cadastro; a imagem vem da extração, nunca de uma URL inventada pela IA. Cor, tamanho e tensão isolados não tornam o produto diferente.

A sugestão é armazenada separadamente. As rotas administrativas existentes são as únicas que confirmam categorias e criam/atribuem produtos. As confirmações continuam verificando versões e pertinência à categoria, incluindo mudanças concorrentes no catálogo.

## Uso ChatGPT

Mostramos o número de respostas concluídas e os tokens reportados nesta sessão, sem persistir credenciais. Esse número não representa a quota total da conta. Não foi encontrado um saldo documentado para construir uma barra percentual confiável; o painel inclui Gerenciar uso no ChatGPT, conforme https://developers.openai.com/siwc/ui-ux-guidelines.

## Entrega e testes

Migrations 033 e 034 são aditivas e preservam os registros existentes. Rode npm run db:migrate (com as contas de migration/runtime já configuradas) antes de usar as novas rotas. O Swagger documenta configurações, filas, contextos, sugestões e liberação.

Testes cobrem ausência de aplicação automática, confirmação de árvore/produto, flags independentes, prompts, candidatos falsos, versões obsoletas, cancelamento e dados extras. O teste de Chromium usa uma conta OpenAI e serviços simulados; nenhuma conta real é utilizada automaticamente. A validação anterior de login/análise real permanece registrada na extensão, mas os novos lotes ainda precisam de homologação opcional com o administrador.
