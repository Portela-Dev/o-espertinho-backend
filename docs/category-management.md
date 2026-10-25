# Gestão de categorias

A aba **Categorias** usa a permissão existente `catalog`. A listagem tem pesquisa por caminho, paginação e tamanho de página configurável. Cada linha oferece Renomear, Mover, Unir e Excluir pelo menu de ações.

- **Renomear:** muda o nome do nível e propaga o caminho aos descendentes. Os identificadores são mantidos.
- **Mover:** move a árvore para outro pai, ou para a raiz. Mantém os identificadores dos nós movidos. O destino não pode estar dentro da própria árvore.
- **Unir:** leva a árvore para outra categoria, consolidando descendentes com o mesmo nome sem distinguir maiúsculas/minúsculas. Reaproveita a grafia e os identificadores de destino; descendentes exclusivos mantêm seus identificadores.
- **Excluir:** remove a categoria e seus descendentes. Se houver referências, exige outra categoria de destino, fora da árvore excluída. Os produtos e referências passam diretamente para esse destino; a estrutura excluída não é reproduzida. Árvore sem referências pode ser removida sem destino.

Nenhuma operação remove produtos, ofertas, históricos de preço, favoritos ou itens de coleções. A classificação das ofertas acompanha seus produtos. Revisões continuam vinculadas ao produto e a uma categoria compatível; mapeamentos de origem e filtros salvos são atualizados. A taxonomia de origem do marketplace não muda. IDs removidos por união/exclusão deixam de fazer parte da árvore pública; não são criados redirecionamentos de URLs antigas de categorias.

## Segurança e concorrência

`GET /api/admin/categories` recebe `q`, `page` e `pageSize` (até 50) e retorna uma página com contagens de produtos e descendentes.

`POST /api/admin/categories/preview` recebe `action`, `sourceId` e `name`, `parentId` ou `targetId`, conforme a operação. Retorna o impacto, uma amostra de até 25 caminhos e a revisão do catálogo usado na prévia. Não grava alterações.

`POST /api/admin/categories/apply` recebe o mesmo corpo com `revision` e `confirm: true`. Exige sessão, permissão `catalog`, origem autorizada, XSRF e verificação administrativa recente. A transação verifica novamente o catálogo e recusa prévias obsoletas com 409. Bloqueia escritas concorrentes nas tabelas envolvidas durante o remapeamento; conflitos ou espera excessiva exigem nova prévia. A operação inteira é revertida em caso de falha. Não desativa triggers nem exige privilégios de migrations.

Atualizações de preço ou de texto que não mudem a classificação não invalidam a prévia e são preservadas. A revisão de inventário da IA muda pelas triggers existentes, impedindo a aplicação posterior de análises sobre a árvore antiga. As operações são registradas em auditoria. Não há alteração de schema nem migrations adicionais.

## Validação

Os testes usam bancos temporários, sem acessar produção. Cobrem propagação para ofertas, IDs/SKU preservados, referências de revisão, mapeamentos, filtros salvos, limite de dez níveis, ciclos, colisões, prévia obsoleta, XSRF/permissões, rollback e operação com a role restrita em PostgreSQL real. Os testes de navegador percorrem as quatro ações, a prévia, invalidação por edição, conflitos, paginação e o layout mobile.
