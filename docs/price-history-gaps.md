# Continuidade do histórico de preços

A consulta pública do histórico monta uma série diária usando o último preço conhecido de cada link. Ela inclui a última observação anterior ao início do período, quando existir, e carrega esse valor até a próxima observação ou o fim do período. Não antecipa preços para dias anteriores à primeira observação.

Para produtos com vários links, primeiro preenche a série de cada link e depois calcula o menor preço diário. Assim, a ausência de atualização de um vendedor não elimina seu último preço da comparação. O campo `observedDate` dos pontos mantém a data real do registro utilizado.

Uma observação explicitamente nula continua representando indisponibilidade daquele link e interrompe seu carregamento até surgir outro preço. A interface conecta os pontos numéricos mesmo quando há lacunas. Uma série sem nenhum preço permanece vazia, sem preços zero.

O preenchimento acontece somente na resposta da consulta. Os registros de origem, datas reais de atualização, históricos gravados e regras da tarja de menor preço não são alterados. Não há migration.
