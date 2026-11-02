# Recuperação de páginas e pulo manual

A extensão espera o documento da navegação atual, incluindo pendingUrl, e revalida as permissões e origens antes de ler a página. Erros de acesso à página reportados pelo Chrome admitem no máximo três tentativas de injeção recusada; erros do código executado não repetem a operação. Não amplia hosts nem automatiza login/CAPTCHA.

Em enriquecimento/preços, página persistentemente ilegível ou timeout produz technical_failure para o item e permite avançar a fila. Conserva preço e disponibilidade anteriores; preço pendente não é interpretado como indisponibilidade. Aviso explícito configurado de indisponibilidade continua usando o fluxo próprio. Permissão revogada pausa com reason=permission; o botão Continuar solicita apenas os hosts do marketplace da execução.

## Pular registro e continuar

Disponível para preços/enriquecimento em pausa, com um item reservado e sem resultado aguardando confirmação. Backend anuncia capabilities.skipItem no GET /api/extension/catalog/config; versões anteriores mantêm o botão desabilitado. Atualizar configurações recarrega essa capacidade.

POST /api/extension/catalog/runs/{id}/skip recebe itemId e leaseToken. Exige conta/permissão e propriedade da execução. Aceita a reserva anterior expirada somente na decisão manual com execução pausada, não permite alterar item finalizado/cancelado nem de outra execução e é idempotente. Marca o item skipped, deixa a atualização pendente e continua a mesma execução; o último item conclui o ciclo. Não cria histórico de preço nem marca indisponibilidade por suposição. Itens pulados permanecem elegíveis em ciclo futuro.

Publicar backend antes da extensão para habilitar o botão. Não requer migration. Respostas tardias de operações anteriores a pausa/cancelamento/pulo não gravam dados nem pausam a nova operação.
