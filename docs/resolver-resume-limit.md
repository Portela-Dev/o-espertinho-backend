# Limite na retomada de catalogação e categorização

`POST /api/extension/catalog/resolver/start` aplica `limit` também à execução existente em andamento ou pausada, inclusive quando a extensão repete a mesma `requestKey`. Não é necessário cancelar o ciclo para aumentar seu tamanho.

O limite representa o total de links do ciclo, incluindo os já processados. Aumentar de 100 para 1000 acrescenta até 900 links elegíveis, sem duplicar os atuais; se houver menos links elegíveis, o total será menor. O comportamento é comum a todos os marketplaces e às duas tarefas de IA.

Ao diminuir o limite, somente entradas de fila nunca iniciadas são retiradas do ciclo; os links de origem continuam disponíveis. Resultados, reservas e contextos já iniciados são preservados. Se esses itens já ultrapassarem o novo limite, o total conservado será maior que o solicitado, pois a retomada não desfaz trabalho anterior.

Execuções concluídas ou canceladas permanecem encerradas. Repetir sua chave não as reabre; a extensão já solicita uma nova chave nesses casos. Uma chave de outra tarefa ou marketplace é rejeitada. A transação e os bloqueios existentes serializam retomadas, reservas e respostas concorrentes.

Sem migration, alteração de configuração em produção ou deploy. Testes cobrem ampliação de 100 para 1000, repetição com mesma/nova chave, redução, preservação de trabalho, esgotamento, categorização e concorrência em PostgreSQL descartável.
