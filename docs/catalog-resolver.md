# Resolvedor estruturado de catálogo

A migration 043 é aditiva; preserva IDs, vínculos e histórico. O modo inicial é **simulação**. Credenciais do provedor permanecem na extensão. Publicação continua manual.

## Configurar e operar

1. Em Revisão de ofertas → Configurações de IA, confira o modo de operação.
2. Edite políticas por tipo de produto: termos no título, prioridade, atributos obrigatórios, aliases, unidades, equivalências e categoria padrão opcional. Não há regras por marketplace. Kits podem exigir identidade exclusiva por anúncio.
3. Prepare os índices existentes. O passo 4 também faz isso incrementalmente; identidades incompletas conhecidas são analisadas uma vez, sem mudar nome, categoria, ID ou vínculos do produto antigo. Colisões antigas nunca causam união automática.
4. Execute catalogação na extensão. A identidade é extraída por regras ou por uma chamada curta de IA com evidências. A busca global usa fingerprint e índice textual; não envia o catálogo inteiro ao modelo. Um candidato antigo ainda incompleto impede criação potencialmente duplicada.
5. Execute categorização. Política pode definir categoria; caso contrário a IA recebe candidatos indexados e sugestão de mapeamento, sem tratá-la como verdade. Uma árvore equivalente é reaproveitada; novos produtos só ficam definitivos após categoria.
6. Confira resultados paginados e métricas. Use avaliação da amostra para registrar vínculo incorreto, duplicata, categoria errada e exclusão indevida. Cobertura/velocidade não comprovam precisão.
7. Só após validar uma amostra real, escolha **ativo**. O modo anterior permanece disponível para retorno. Ativar não aplica retroativamente resultados da simulação.

## Garantias e limites

- Aceito, excluído com motivo ou falha técnica com repetição limitada. O motor novo não produz `invalid` nem `needs_review`. Não significa aproveitar todos os anúncios: sem evidência suficiente, exclui. Intervenções manuais continuam possíveis e removem a exclusão.
- Atributos obrigatórios configurados definem identidade. Cor, tensão e tamanho de roupa isoladamente não devem ser atributos de identidade. Modelos, RAM física, armazenamento e tela podem ser. A seleção de preço mínimo de um intervalo não prova variante selecionada.
- `fingerprint` inclui tipo, versão da política e atributos normalizados; kits incluem anúncio. Rascunho único impede criação duplicada em concorrência. Produtos antigos com mesma identidade permanecem separados e impedem escolha automática ambígua.
- Cache reutiliza fatos apenas com fonte, política e prompt compatíveis. Antes de gravar, revalida fonte, política, prompt, rascunho e vínculo. Mudanças alheias no catálogo não invalidam o lote inteiro.
- Reservas de cinco minutos, exclusão mútua por link/produto, resultados idempotentes, pausa/retomada/cancelamento persistentes e tentativas limitadas. Reabrir a extensão retoma a execução pendente do usuário. Sem agendamento.
- Concorrência inicial 1, configurável até 2; limita chamadas do modelo e não altera limites do navegador dos marketplaces. Progresso conta links, preparação tem métrica separada.
- Métricas de tokens dependem do relatório do provedor; não equivalem à cota real da assinatura. Não usa Batch API nem presume parâmetros especiais aceitos pelo login OAuth.
- Normalização é determinística, mas a interpretação semântica continua sujeita a erro. Validar evidência literal evita atributos sem fonte; a avaliação de amostra é necessária antes de ativar.

## Testes e publicação

Testes de identidade/evidências/unidades/kits, pipeline em memória, contratos/CSRF/permissões, cache, reenvio, fonte alterada, modo simulação, índices antigos, paginação e integração real concorrente no PostgreSQL descartável do CI. O banco real nunca é usado para os testes.

Publicar o backend/migration antes dos clientes. Nenhum deploy faz parte desta entrega. O Docker local estava indisponível durante a implementação; a validação concorrente real é executada pelo CI. A latência e precisão reais do modelo precisam de amostra com a sessão do administrador; testes automatizados não gastam sua assinatura.
