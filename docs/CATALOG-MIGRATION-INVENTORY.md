# Inventário de migração — fase 0 — 20/10/2026

Plano principal: `../../PLANO-MIGRACAO-CATALOGO-EXTENSAO.md`. A raiz é um agrupador sem Git; cópias do plano e evidências são versionadas neste diretório a cada fase, sem criar repositório sobre os repositórios existentes.

## Base e alterações preservadas

Backend: a77f3d0; frontend: 84fac38; extensão: 12e3523; descoberta: dd3e55b; enriquecimento: 70e962a; extrator: 4a91ecb. Branches novas dos três consumidores ativos: `feat/catalog-extension-pipeline`, base `origin/develop`. Não havia PR aberta nesses três repositórios na consulta inicial.

O extrator tem `src/contracts.ts` modificado e `src/interactive-proof.ts` não rastreado, referentes à interação humana remota incompleta. Não descartar ou commitar incidentalmente. Essa implementação não é necessária ao novo fluxo; ficará preservada até o corte validado.

## Consumidores

| Fluxo | Entrada | Persistência | Consumidor atual | Decisão |
|---|---|---|---|---|
| Exploração/configuração | discovery-admin, discovery-config | discovery_profiles/sources | admin | Manter |
| Descobrir URLs | discovery-runs | discovery_runs/links/sources/events | job-discovery | Substituir por extensão |
| Conversão | affiliate-proof e demonstração | recipe de POC e Maps | extensão + backend de teste | Receita real e fila persistida |
| Enriquecimento | enrichment-admin | enrichment_runs/items e discovery_links | job-enrich-links | Substituir executor; manter revisão/mapeamentos |
| Preços | offer-refresh | offer_refresh_runs/items e offer_price_history | job-update-price | Execução manual na extensão; preservar histórico |
| Prévia e seletores | scraping-admin | offer_import_previews | manual-extractor HTTP | Solicitações assíncronas da extensão |
| Categoria/produto | enrichment-admin e products | category_mappings/nodes/products | API transacional | Preservar confirmação humana |
| Publicação | offers/admin | offers | API | Exigir dados confirmados, nunca executor |
| Autenticação da extensão | extension-mock | extension_sessions + pareamento temporário | API | Separar do mock para produção |
| Sessão em container | extension-session-proof, session-proof | temporário | extrator | Remover após substituição |
| Manutenção | worker-runtime → workerTick | sessões/auditoria/etc. | backend | Manter efeitos sem navegador; auditar integrações históricas |

## Recuperação e coexistência

Não aplicar testes destrutivos ao banco pessoal. Testes usam PostgreSQL isolado/PGlite. Antes de migrar dados reais: gerar backup com credencial de migrations sem imprimir senha, guardar fora do Git, restaurar em banco isolado e conferir contagens, FKs e dados amostrados. Preservar ENCRYPTION_KEY separadamente enquanto houver credenciais cifradas.

O corte exige seleção de executor por marketplace e exclusão entre filas antigas e novas. Não parar containers ou revogar contas nesta fase. Arquivamento de GitHub, exclusão de imagens/releases e deploy não estão autorizados por consequência da implementação.

Relatórios ignorados, screenshots e POCs não constituem dependência de produção. Limpeza precisa de busca por rotas, variáveis, imports, storage, OpenAPI, grants, scripts npm, Compose, workflows, testes e documentação. Nunca reescrever migrations já aplicadas.

## Estado após a limpeza definitiva

Backend e frontend retiraram rotas/UI/clientes dos executores anteriores. A extensão é o único navegador operacional. Os quatro containers antigos estão parados com restart desativado; três roles dedicadas de banco estão NOLOGIN e sem grants. O runtime usa espertinho_app, sem acesso às credenciais cifradas antigas. A conta dona permanece separada para migrations.

Migration 031 encerra filas antigas e preserva evidência histórica. offer_refresh_settings/search_rules estão desativadas. Tabelas antigas e colunas cifradas são arquivo deliberado sem consumidor; nenhum produto/link/categoria/preço foi zerado. A chave do arquivo e backups não são versionados. Código compilado removido não permanece em dist, pois o build agora limpa somente esse diretório validado.

Jobs/extrator/extraction-core têm branches/PRs de aposentadoria e workflows desativados; não houve archive/delete de repositório ou pacote. Alterações locais src/contracts.ts e src/interactive-proof.ts do extrator original continuam preservadas e fora da entrega. Os worktrees isolados usados para aposentadoria ficam em .retirement no workspace, sem modificar essa POC.

Recuperação requer backup pré-031 e versões compatíveis; não iniciar consumidores antigos contra as filas atuais. Evidências ignoradas/reports e artefatos históricos não são dependências de execução e foram preservados quando sua exclusão não era necessária ao código.
