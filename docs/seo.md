# Catálogo público para SEO

`GET /api/seo/sitemap?page=N` fornece IDs de produtos elegíveis à vitrine e suas categorias ancestrais. O consumidor é o gerador de sitemap do frontend; a API não produz URLs baseadas em headers do visitante.

Produtos precisam de pelo menos uma oferta publicada, disponível e com link de afiliado. Não são incluídos rascunhos ou produtos sem ofertas elegíveis. Categorias vazias também são omitidas. A resposta contém somente `type`, `id` e `updated_at` para cada entrada, além de `total`, `totalPages`, `page` e `pageSize` (1000). Ordenação determinística por tipo e UUID. `page` aceita inteiros entre 1 e 10000; além do fim do catálogo, retorna itens vazios.

`updated_at` considera alterações no produto e nas ofertas públicas. O endpoint não expõe credenciais, SKU, URLs de origem/afiliados ou dados de conta. Cache-Control público de cinco minutos; o frontend faz cache limitado, agrupa requisições concorrentes e aplica timeout.

A rota está documentada no OpenAPI. Não há migrations, seeds, permissões ou variáveis novas. Publicar este backend antes do frontend com o sitemap. O frontend mantém rolagem infinita com URLs paginadas rastreáveis.

Validação: teste em banco PGlite descartável com mais de mil entradas, visibilidade, categorias ancestrais, limites, ordenação e ausência de duplicatas, além da suíte completa. As fixtures adicionais de navegador ficam exclusivamente em `test/preview-server.mjs`, protegido por E2E_TEST_SERVER; não são importadas pelo servidor de produção.
