# Expurgo manual do catálogo

Admin → Manutenção permite calcular uma prévia e confirmar a exclusão física de links e produtos. Critérios independentes, ambos com padrão de 30 dias e faixa de 1 a 3650 dias. Não existe agenda nem expurgo ao iniciar a aplicação.

## Elegibilidade temporal

- Ofertas: indisponibilidade confirmada no marketplace por todo o período, ou falha técnica de atualização persistente por todo o período. Atualização apenas pendente, sem erro real, não é falha. Estar encerrada/rejeitada ou sem atualização recente, isoladamente, não torna uma oferta elegível.
- Links descobertos ainda não publicados: disponibilidade explicitamente unavailable ou extraction_status=failed pelo período. Dúvidas de IA e anúncios inválidos não são falhas técnicas por si sós.
- Produtos: nenhuma linha em offers durante o período, independentemente do status das ofertas. Revisões ainda não publicadas não equivalem a ofertas cadastradas e são dependências removidas junto com o produto.
- Retries e atualizações editoriais não reiniciam os marcadores. Sucesso limpa falha; disponibilidade recuperada limpa indisponibilidade. Retentar extração preserva o início da falha até um resultado bem-sucedido.
- Remover a última oferta inicia a contagem do produto naquele momento. O mesmo expurgo não remove imediatamente produtos recém-esvaziados.

A migration 040 usa a última observação conhecida como limite conservador para estados antigos de links. Quando não há evidência temporal, começa a contar na ativação. Para produtos já vazios, começa na ativação porque o banco não registrava quando a última oferta foi removida. Produtos novos começam no cadastro; adicionar uma oferta limpa o marcador.

## Exclusão e dependências

A seleção inclui ofertas, seus discovery_links publicados, produtos elegíveis e links/rascunhos vinculados a esses produtos. Remove preços históricos, favoritos, itens de coleções, cliques, prévias relacionadas, sugestões de IA, associações às vitrines, itens de processamento e auditorias dos registros removidos. Rascunhos sem outros vínculos e execuções que ficaram sem itens também são removidos. Compartilhados com registros fora da seleção são preservados.

Triggers fixos SECURITY DEFINER, com EXECUTE revogado de PUBLIC e search_path restrito a pg_catalog, removem apenas os vínculos e execuções exclusivas dos jobs aposentados. Não concedem SELECT/DELETE dessas tabelas à conta de runtime. O teste PostgreSQL real confirma que o expurgo funciona e que SELECT nas tabelas antigas continua recusado.

Usuários, coleções, categorias, mapeamentos, marketplaces, seletores, perfis e URLs de seções não são apagados. URLs fisicamente removidas podem ser descobertas novamente em uma exploração futura; não são criados tombstones. Resta apenas um evento independente catalog.purged com critérios/contagens e identificador da operação, sem IDs ou URLs apagados.

## Confirmação e consistência

POST /api/admin/purge/preview recebe {links, products, linksDays, productsDays}. A prévia retorna critérios, instante de referência, contagens e token assinado com validade de dez minutos, vinculado ao usuário. Não altera registros. Reiniciar o backend invalida as prévias daquele processo.

POST /api/admin/purge/execute recebe {previewToken, confirmed:true}. A seleção e dependências são recalculadas sob locks de escrita e comparadas ao hash da prévia. Mudanças exigem nova prévia. Execuções/análises ativas impedem a operação; novas escritas esperam a transação. Timeout/erro causa rollback integral. O token não aceita IDs arbitrários, períodos modificados, adulteração, outro usuário ou repetição após exclusão.

Permissão dedicada purge, autenticação Google recente, sessão e XSRF são obrigatórios. O perfil Administrador recebe a permissão na migration; editores existentes não ganham essa capacidade. Outros perfis podem recebê-la em Acessos. A modal exige confirmação explícita e a prévia é descartada quando os critérios mudam.

## Validação local — 22/10/2026

- Backend: 142 testes aprovados; dois testes PostgreSQL opt-in executados separadamente e aprovados, incluindo conta restrita, dependências históricas, migrations e restauração.
- Frontend: build SSR/typecheck e sete jornadas de navegação/manutenção aprovados em portas/API de fixture independentes.
- Migration aplicada no ambiente preservando as contagens de produtos, ofertas e links. Conferida apenas a prévia padrão, com zero elegíveis; nenhuma exclusão real executada.
- PRs existentes backend #18 e frontend #20; workflows continuam disabled_manually, sem CI acionado ou deploy.
