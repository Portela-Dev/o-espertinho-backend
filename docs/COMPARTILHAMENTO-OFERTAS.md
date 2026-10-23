# Compartilhamento de ofertas

Configuração em Admin > Ofertas > Compartilhamento, disponível ao administrador ou a perfis com permissão catalog. Escritas exigem sessão, XSRF, origem válida, confirmação administrativa recente e versão atual da configuração.

A migration 041 cria uma configuração global e cadastra WhatsApp, Telegram, Facebook, X, LinkedIn e Instagram. O provisionamento concede acesso da conta restrita à nova tabela. Aplicar `npm run db:migrate` usando as contas distintas de migrations/runtime antes do deploy.

Cada rede tem nome, ativação, logo, texto padrão e ação (abrir URL HTTPS ou preparar texto para cópia). Logos padrão são arquivos locais do frontend; também são aceitas URLs HTTPS externas. Os logos Bootstrap Icons 1.11.3 estão acompanhados da licença MIT em public/brand/social/LICENSE.txt no frontend. É possível editar, adicionar ou remover redes; a desativação global oculta os botões públicos.

Variáveis de texto: `{titulo}`, `{preco}` (BRL), `{loja}` e `{url}`. URLs de compartilhamento também aceitam `{texto}`. As substituições ocorrem em uma passagem e os parâmetros são codificados. O conteúdo é texto simples, sem HTML executável. A URL compartilhada é sempre a página `/oferta/:id` na origem pública do site, nunca o link de afiliado.

O componente aparece nos cards de ofertas disponíveis e no conteúdo principal das páginas de oferta/produto que exibem uma oferta principal. O usuário escolhe a rede, confere a prévia e abre o compartilhador ou copia o texto/link. Nada é publicado automaticamente; a confirmação final acontece na rede social. Instagram usa cópia; Facebook e LinkedIn recebem a URL e o texto permanece disponível para copiar, pois não aceitam a mensagem por esse tipo de link. As páginas de ofertas também oferecem metadados Open Graph para título, descrição e imagem.

Endpoints:
- GET /api/sharing: configuração pública com redes ativas; desativado retorna lista vazia.
- GET /api/admin/sharing: configuração completa, incluindo versão.
- PUT /api/admin/sharing: atualização global transacional com auditoria; versão antiga retorna 409.

Desativar ou editar configurações se reflete na próxima carga da página pública; salvar pelo admin invalida o cache da sessão atual. Nenhum cookie/token de rede social é solicitado ou armazenado. Os testes de navegador verificam a prévia e os destinos, sem publicar mensagens reais.

Referências dos mecanismos: https://core.telegram.org/widgets/share e os compartilhadores web configurados em cada rede. A plataforma externa pode alterar seu comportamento; os endereços são editáveis no admin.
