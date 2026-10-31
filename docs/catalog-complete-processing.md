# Catalogação e categorização completas

## Contrato de negócio

Todo link pendente com URL de afiliado pode passar pelas etapas 4 e 5, mesmo sem extração completa. Produto e categoria sempre recebem uma decisão: reutilizar ou criar. Não existem saídas novas de exclusão, invalidação ou revisão obrigatória. A publicação permanece manual e continua exigindo os dados necessários da oferta, inclusive preço; este processo não inventa preço, marca ou especificações.

O título tem prioridade. Quando não há título extraído, utiliza-se o caminho público da URL; o último recurso é um nome genérico. Identidades sem texto utilizável ficam isoladas por link para não reunir todos os registros vazios em um produto.

## Etapas e decisões

1. A fila é limitada pelo lote solicitado e pelo marketplace, sem exigir um tipo de produto previamente cadastrado. Itens arquivados e publicados são preservados fora da fila.
2. Identidades comprovadas no título e categorias mapeadas dispensam chamada de IA. Não se prepara nem baixa todo o catálogo antes de iniciar o lote.
3. Para tipos novos, uma chamada pode propor política e atributos. O backend valida o contrato e as evidências. Atributos ausentes não impedem a identificação pelo título.
4. Índices de identidade e busca textual fornecem até 20 candidatos, incluindo rascunhos de outros links. Equivalentes são reutilizados; se não houver equivalente, cria-se um rascunho. Kits personalizados conservam identidade própria por anúncio. Modelo, RAM, armazenamento e tela explicitamente diferentes distinguem produtos.
5. A categorização considera o mapeamento manual, as categorias candidatas, o tipo e a árvore de origem. A confirmação cria o produto definitivo ou utiliza aquele já finalizado por outro link. Árvores equivalentes são pesquisadas por índice e ancestrais existentes são reutilizados.

## Alternativa de conclusão

JSON inválido, política inválida, evidência inventada, recusa, indisponibilidade, autenticação da IA, limite e timeout não terminam o item como falha de negócio. O backend usa identidade pelo título, comparação dos candidatos e categoria de origem/tipo; `Outros` é a categoria de último recurso. Reutiliza títulos equivalentes sem conflito numérico; caso contrário, cria produto. Essa alternativa deliberadamente aceita menor precisão para concluir o cadastro, conforme a preferência do administrador.

O resultado e o recibo registram `fallback` com etapa e código fixo de diagnóstico. Nenhum corpo de erro, token, cookie ou credencial da IA vai para o backend. O prompt completo das políticas permanece configurável. Mapeamentos confirmados prevalecem na extensão.

## Interrupções e consistência

- Cada análise tem prazo de 30 segundos. Duas falhas consecutivas evitam outras chamadas ao provedor naquele lote; falha de autenticação ou limite ativa essa proteção na primeira ocorrência. Resultados determinísticos continuam válidos.
- Perder a sessão da IA não equivale a clicar em cancelar. Cancelar, desconectar explicitamente, fechar o painel ou trocar o ambiente interrompe a aplicação de respostas tardias.
- Se a confirmação não chegar, a extensão repete exatamente o mesmo payload uma vez. O recibo por reserva impede duplicação. Se o backend continuar inacessível, a execução pausa e mantém os itens para retomada.
- Fonte, política, categoria ou candidato alterados durante a análise provocam novo contexto. Tarefa desativada e perda de permissão impedem gravação. Falhas de banco não são convertidas em sucesso fictício.
- Reservas expiradas voltam à fila; falhas antigas são liberadas na retomada. Métricas e decisões históricas são preservadas. Registros que já foram vinculados são reconhecidos sem duplicar o produto.
- Simulação não grava política, rascunho, produto ou categoria. Retém somente execução, métricas e resultado projetado.

## Retirada do legado e publicação

Protocolo 3 requer backend e extensão compatíveis; publicar o backend primeiro. A migration 045 é aditiva, mantém os dados e libera bloqueios históricos em links pendentes. O modo aposentado `legacy` é convertido em simulação; o modo ativo existente é preservado. O campo antigo de tentativas só é aceito por compatibilidade de configuração e não encerra mais os itens.

Foram retirados o cliente de inventário global da extensão, as decisões legadas e suas rotas de execução, além dos controles de modo anterior e tentativas terminais no admin. As tabelas históricas e a revisão manual continuam disponíveis. O preparo incremental de índices permanece como manutenção opcional do admin, sem bloquear a execução normal.

## Verificação

Testes cobrem indisponibilidade permanente da IA, respostas inválidas, todos os links concluídos, reutilização e criação, kits, contradições, dados vazios, árvores equivalentes, confirmação idempotente, reserva expirada, edição concorrente, retomada histórica, cancelamento, simulação, autenticação, CSRF e permissões. O CI também executa concorrência, migrations, backup/restauração e segurança em PostgreSQL real descartável. A homologação com a conta real da IA deve verificar os diagnósticos locais, sem exportar credenciais.
