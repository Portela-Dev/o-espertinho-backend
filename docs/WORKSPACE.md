# O Espertinho

Componentes ativos: `1-backend` (Node.js), `2-frontend` (Angular), PostgreSQL e `o-espertinho-chrome-extension`.

## Primeira execução

Na raiz, execute `npm run setup`. Ele instala as dependências dos três projetos ativos, prepara o `.env` local quando ausente, sobe PostgreSQL com `docker compose up -d --wait`, aplica as migrations e gera o ZIP da extensão. Configure `GOOGLE_CLIENT_ID` no backend. O setup não abre outras janelas nem inicia frontend e backend juntos.

Em terminais separados: `npm run dev:backend` e `npm run dev:frontend`. Backend usa porta 3000, frontend 4200 e banco 5432. Cada processo tem seu próprio ciclo. `npm run db:up` e `npm run db:down` controlam somente PostgreSQL.

No Chrome, carregue a pasta `o-espertinho-chrome-extension/dist` em modo desenvolvedor ou use o ZIP gerado por `npm run extension:package`. Entre com uma conta autorizada, atualize as configurações e escolha o marketplace.

## Operação

Cadastre marketplaces, hosts permitidos, perfis de exploração, páginas de seção, seletores de produto, receita de conversão e detecção de bloqueios no admin. Na extensão execute manualmente 1 — Extrair links, 2 — Gerar links de afiliados, 3 — Extrair informações. Confirme categorias/produtos na revisão e publique. Use 4 — Atualizar preços para novas observações e histórico diário. Prévias e testes de seletores criam solicitações que devem ser selecionadas na extensão.

Login e desafios exigem intervenção humana na janela dedicada. Ao fechar a janela, use Abrir janela de processamento e depois Continuar. Cookies/tokens dos marketplaces não são enviados ao backend. Não há agendamento de consultas de navegador.

## Serviços descontinuados

Jobs de descoberta, enriquecimento e preços, extrator e pacote de extração Node não fazem parte do runtime, setup ou deploy ativos. Seu código anterior e históricos são evidência arquivada; não devem ser iniciados junto da extensão. Não há comandos `legacy:*` no workspace. Restauração anterior ao corte exige backup correspondente e versão anterior do conjunto de aplicações; rollback apenas da imagem não reverte migrations.

O plano detalhado está em `PLANO-MIGRACAO-CATALOGO-EXTENSAO.md`, versionado também em `1-backend/docs`. Os dados históricos dos serviços aposentados são preservados, sem uso operacional pela API.
