# Homologação Shopee pela extensão

Configuração de referência: `examples/shopee-catalog-test.json`. São dados declarativos, não uma integração fixa no código. Não há chaves de API, cookies ou tokens nesse arquivo. O cadastro no banco local é separado de migrations: outros ambientes precisam receber essas configurações pelo admin.

## Limites iniciais

- Vitrine: celulares, uma página e até três links únicos, com intervalo de cinco segundos.
- Paginação: links próximo/anterior do controlador compacto, identificados no DOM fornecido pelo administrador. O limite inicial impede avançar para a segunda página.
- Produto: título, preço, descrição, imagem principal, categoria de origem, nota, quantidade de avaliações e condições. A galeria completa e indicadores de indisponibilidade precisam de evidência adicional antes de configurar.
- Preço observado: R$ 2.116,00 **no Pix com cupom**, com outro valor sem cupom. O perfil captura a condição junto ao preço; não cadastra o preço sem cupom como desconto fictício.
- Queries e fragmentos são removidos somente das URLs originais de produto; os links de afiliado são preservados.

## Conversão

A receita usa POST GraphQL, com `variables.linkParams` e `subId1=OEspertinho`. O executor interpola strings mantendo objetos, listas e tipos JSON; não executa código da receita. A resposta precisa de `data.batchCustomLink.0.failCode` igual a zero antes de aceitar `data.batchCustomLink.0.shortLink`.

O diagnóstico no portal confirmou um cookie `csrftoken` e um `fetch` não nativo. A receita lê esse cookie localmente para o header `csrf-token` e usa `executionWorld=MAIN`, permitindo que o `fetch` do próprio portal prepare a requisição. Não exige gerar previamente um link manual. Nenhum cookie/token é enviado ao backend, e os demais headers de segurança do cURL não são copiados nem fixados. O funcionamento real permanece dependente da homologação; se houver recusa, o fluxo deve parar para diagnóstico.

## Teste acompanhado

1. Recarregar a extensão atualizada e atualizar as configurações; selecionar Shopee e limite de uma vitrine.
2. Executar `1 — Extrair links`, resolver login ou verificação manualmente se solicitado e conferir três URLs normalizadas.
3. Preparar a aba do portal e fazer login. Executar `2 — Gerar links de afiliados`, inicialmente para um item, sem geração manual prévia. Execuções criadas com configuração anterior devem ser canceladas e recriadas para receber o novo snapshot.
4. Extrair informações pelo endereço original. Conferir especialmente preço e condição de cupom, imagem, categoria e avaliações.
5. Catalogar, categorizar e revisar. Publicar uma oferta válida pelo admin e conferir a página pública e o destino de compra.
6. Atualizar o preço e conferir resultado e histórico. Somente após a homologação aumentar os limites e validar a segunda página.

O navegador temporário sem sessão retornou `/verify/traffic/error`; esse estado está configurado para pausa, sem tentativas de contornar a verificação. Os testes de contrato e de fragmentos HTML não substituem a homologação na sessão real. Consultar as evidências abaixo para distinguir as etapas já homologadas das pendentes.

## Evidências de 22/10/2026

- Configuração aplicada no banco local; a API pública lista a Shopee.
- Descoberta real concluída: uma vitrine processada, três links únicos normalizados, sem falhas (execução `4c667f38-d3fc-4157-baa5-6ad95d7bdc80`).
- A primeira tentativa de conversão pausou com o motivo genérico `login`, embora o administrador estivesse no portal autenticado. O executor foi ajustado para distinguir HTTP 401 (login), 403 (acesso negado) e 429 (limite de consultas), com status local no painel e sem exportar resposta ou sessão.
- A tentativa anterior confirmou HTTP 403 (`access_denied`). O diagnóstico mostrou `fetch` não nativo e cookie `csrftoken` no portal. A receita foi então ajustada para usar contexto MAIN e o cookie local, sem exigir observação manual de header; a confirmação real está registrada abaixo.
- Conversão real confirmada com a nova receita: execução `2a4d822a-af7a-4688-9714-9f0124c336c2`, um item concluído, nenhuma falha e link curto salvo. O administrador confirmou que não precisou gerar manualmente o primeiro link.
- Enriquecimento real confirmado: execução `2c9ecea1-9071-4b3a-8d4c-df9233d3ddb5`, produto “Aparelho Iphone 11 Roxo 128gb Apple Vitrine Grade A”, R$ 1.656,00 no Pix com cupom, condição de R$ 1.899,99 sem cupom preservada, imagem principal, nota 4,8, 47 avaliações e categoria de origem “Celulares e Dispositivos > Celulares”.
- Pendentes: confirmação do produto/categoria, publicação, atualização de preço, segunda página, galeria completa e indicador explícito de indisponibilidade.
