# Catalogação de todos os tipos de produto

O fluxo ativo cataloga e categoriza todos os itens com link de afiliado, sem decisões automáticas de inválido, revisão ou exclusão. Publicação permanece manual. Os estados de excluído de execuções antigas são apenas histórico, não bloqueiam publicação ou reprocessamento.

O título prevalece sobre informações conflitantes da descrição/ficha. Atributos ausentes não são inventados: a identidade usa os fatos comprovados e o nome baseado no título quando a identidade tipada é parcial. Modelos, RAM, armazenamento e tela explicitamente distintos continuam diferenciando produtos; cor, tensão e tamanho de roupa/calçado isoladamente não distinguem. Kits mantêm identidade própria por anúncio.

## Etapas

1. Reutilizar a política correspondente ao título. Sem correspondência ou com ambiguidade de tipo, a IA escolhe entre políticas oferecidas ou propõe uma nova política reutilizável e seus fatos na mesma resposta.
2. O backend valida estrutura, unidades, evidências, versão, tipo escolhido e autorização. Políticas novas recebem identificador determinístico por nome, sem sobrescrever políticas existentes. No modo de simulação, políticas, produtos e categorias não são criados.
3. Identidade indexada resolve equivalências exatas. Quando houver candidatos antigos incompletos, uma comparação de IA com até 20 produtos escolhe um equivalente ou cria um produto. Não existe preparação por IA de todo o inventário ou uma chamada por candidato.
4. A categorização sempre reutiliza ou cria uma árvore. Mapeamentos e categorias existentes compõem o contexto. Produtos equivalentes reaproveitam categoria e vínculo existentes.

Criar um tipo não reenfileira todos os produtos. Alterar uma política reenfileira somente identidades daquele tipo; demais candidatos são tratados sob demanda. Índices com identidade já confirmada são preservados quando o título limpo deixa de conter os termos da política, desde que fonte e versão continuem iguais.

## Operação e segurança

Requer migration 044 e extensão com protocolo 2. Publicar backend antes da extensão/frontend. A extensão antiga pode não entender as etapas novas; recarregue configurações e inicie uma execução nova após atualizar. Credenciais permanecem locais na extensão. IDs de produtos/políticas/categorias são restritos aos candidatos e versões oferecidos; fontes alteradas invalidam o contexto e dados inventados são recusados sem gravações parciais. Política gerada não pode definir categoria fixa nem prioridade administrativa.

Reservas, retomada, cancelamento, limites de concorrência e idempotência permanecem. Falhas técnicas têm tentativas limitadas e métricas; falha técnica não é decisão de negócio sobre o produto. Configurações de IA desativadas ou ausência de conexão/modelo interrompem a execução com mensagem, sem marcar o anúncio como excluído.

Migration 044 libera marcações antigas sem apagar histórico. A liberação pontual solicitada em produção preservou os recibos antigos, invalidando apenas seu reaproveitamento. Nenhum deploy é feito ao abrir as PRs.
