# O Espertinho

Portal de ofertas com frontend Angular, backend Node/Express, PostgreSQL e extensão do Chrome.

O [plano de migração](PLANO-MIGRACAO-CATALOGO-EXTENSAO.md) e seu diário registram as fases, testes e pendências de homologação. O plano também é versionado em `1-backend/docs`.

## Primeiro uso

Na raiz do workspace, com Node 24 e Docker Desktop Linux:

```powershell
npm run setup
```

O setup instala backend, frontend e extensão, preserva `.env` existente, sobe apenas PostgreSQL com detach, aplica migrations e gera o pacote da extensão. Não abre CMD adicional, não inicia front/backend e não inicia nem interrompe os serviços legados. Configure GOOGLE_CLIENT_ID no backend e, em produção, as origens HTTPS.

Em terminais separados:

```powershell
npm run dev:backend
```

```powershell
npm run dev:frontend
```

Site: http://localhost:4200. API: http://localhost:3000. PostgreSQL: 127.0.0.1:5432. Para a extensão, carregue `o-espertinho-chrome-extension/dist` em chrome://extensions. `npm run extension:package` reconstrói dist e o ZIP.

## Configurar e executar

1. No admin, mantenha marketplaces/domínios, perfis de exploração, vitrines e seletores de produto.
2. Em Marketplaces → Execução pela extensão, configure receita e regras de login/desafio/indisponibilidade. Selecione o executor Extensão somente após concluir/cancelar execuções antigas e validar a transição.
3. Na extensão, entre com conta autorizada, selecione o marketplace e prepare sua janela de processamento.
4. Execute manualmente os passos 1 — Extrair links, 2 — Gerar links de afiliados e 3 — Extrair informações.
5. No admin, confirme categorias, atribua produtos e publique.
6. Use 4 — Atualizar preços para ofertas existentes. Falha técnica preserva o último preço e marca atualização pendente.

Login e desafios são resolvidos por você na janela de processamento. Cookies e tokens de marketplaces permanecem no Chrome. A operação requer computador/navegador disponíveis; não há promessa de processamento durante suspensão ou com o navegador encerrado.

Prévia manual e teste de seletores geram solicitações para a extensão quando o marketplace usa o novo executor. A tela aguarda, mostra instruções e permite cancelar. Selecione a solicitação na extensão em Retomar execução ou prévia.

## Transição e manutenção

Os serviços anteriores e seus dados foram preservados como recuperação até a homologação real. O job de preços precisa da versão que exclui marketplaces migrados; não habilite consumidores antigos sobre as mesmas filas. Comandos de recuperação são explicitamente prefixados por `legacy:` no package.json. Eles não fazem parte do setup normal.

Nenhum repositório, release ou volume de banco foi excluído. A manutenção de sessões e retenção sem navegador continua no backend. Testes usam bancos isolados; não use comandos destrutivos no banco pessoal.

A execução do workspace é versionada em `1-backend/scripts/workspace.mjs`; `scripts/project.mjs` apenas a delega. Documentação histórica anterior está em `1-backend/docs/history` e não descreve o fluxo operacional atual.
