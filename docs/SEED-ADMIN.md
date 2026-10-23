# Preparação das configurações do admin

O snapshot `seeds/admin-config.json` registra as configurações locais de 23/10/2026. Ele é independente das 41 migrations existentes e não é aplicado pela inicialização, pelo setup ou pelo deploy. Nenhuma migration foi alterada. O seed destina-se à preparação explícita de um banco novo na VPS, depois das migrations.

## Conteúdo

| Configuração | Registros |
|---|---:|
| Marketplaces, domínios, logos e normalização de URLs | 3 |
| Perfis de seletores de produto | 3 |
| Perfis de exploração, paginação, rolagem, limites e falhas | 3 |
| Páginas de vitrine | 3 |
| Receitas da extensão, intervalos e detecção de bloqueios | 3 |
| Prompts e ativações de IA | 1 |
| Redes, logos e textos de compartilhamento | 1 configuração com 6 redes |
| Perfis de acesso e permissões | 3 |

Os identificadores públicos de afiliado (`tag`, `storeId`, `subId1`) fazem parte das receitas e foram preservados. Os tokens de CSRF são apenas referências `{{csrf}}` a valores obtidos localmente pela extensão; o arquivo não contém seus valores. A Shopee é cadastrada novamente pelo seed, depois da migration histórica que a remove.

Não são exportados usuários, identidades Google/OpenAI, senhas, cookies, sessões, tokens, credenciais arquivadas, configurações legadas sem uso, produtos, rascunhos, categorias, mapeamentos de categoria, links de oferta/afiliado já gerados, históricos, favoritos, coleções, execuções ou auditoria de origem. URLs de vitrines e endpoints de conversão são configurações e estão incluídos. A categoria alternativa de origem da vitrine Amazon também foi omitida: todas as vitrines começam com `source_category_path=[]`.

As migrations continuam criando seu administrador inicial, perfis e a categoria padrão “Outros”. O seed não copia a árvore de categorias atual nem muda o usuário inicial. Credenciais de banco e login Google continuam sendo definidas exclusivamente no ambiente da VPS; o login dos marketplaces e da IA continua na extensão.

## Execução pelo código-fonte

Configure `MIGRATION_DATABASE_URL` e `DATABASE_URL` em um ambiente seguro. Em um banco novo, aplique as migrations e as permissões antes de preparar as configurações:

```sh
npm run db:migrate
npm run db:seed:admin -- --dry-run
npm run db:seed:admin
```

O modo `--dry-run` executa as validações e comandos SQL em uma transação, terminando com rollback. Seu resultado lista as quantidades de registros que seriam inseridos ou alterados; registros que já são idênticos não contam como alteração.

## Execução na VPS com a imagem validada

A imagem inclui o snapshot e o CLI compilado. O serviço `seed-admin` tem perfil `tools`, não inicia no `compose up` normal e recebe somente a conexão de migrations. Depois de configurar a imagem, o arquivo de ambiente e o banco, use os mesmos argumentos do Compose de produção:

```sh
docker compose --env-file /opt/o-espertinho/backend/.env -p o-espertinho-backend -f compose.production.yml run --rm --no-deps migrate
docker compose --env-file /opt/o-espertinho/backend/.env -p o-espertinho-backend -f compose.production.yml run --rm --no-deps seed-admin node dist/admin-seed-cli.js --dry-run
docker compose --env-file /opt/o-espertinho/backend/.env -p o-espertinho-backend -f compose.production.yml run --rm --no-deps seed-admin
```

Execute na pasta que contém o `compose.production.yml` da release validada e com `APP_IMAGE` definido conforme o deploy. O PostgreSQL precisa estar disponível. Os comandos acima são instruções para a preparação futura; nenhum deploy ou seed no banco local foi executado durante a implementação.

## Integridade e reexecução

- A carga usa uma única transação e um advisory lock. Duas solicitações simultâneas não aplicam o seed duas vezes.
- O bloco `baseline` é a projeção das configurações criadas exclusivamente pelas migrations, sem categorias, usuários ou segredos. Permite substituir os defaults antigos pelos valores atuais do bloco `config`.
- Na primeira execução, o seed recusa banco com produtos, ofertas, links descobertos ou execuções da extensão. Recusa também sobrescrever um registro cuja configuração difira tanto do baseline quanto do snapshot. Uma colisão de nome/URL ou qualquer falha SQL reverte toda a carga. Configurações adicionais que não colidem não são excluídas.
- A primeira aplicação registra somente o identificador e o hash SHA-256 do snapshot em `audit_logs`, com ator de sistema e sem copiar a auditoria local. Não cria tabela nova.
- Reexecutar o mesmo seed retorna `already_applied`: não reverte alterações feitas depois pelo admin nem altera catálogo novo. Alterar o conteúdo mantendo o mesmo identificador é recusado.
- Para preparar outro conjunto no futuro, crie uma versão explícita e revise suas regras; não remova o marcador de auditoria para forçar sobrescrita. O seed não é uma ferramenta de sincronização ou restauração de configurações de um ambiente em uso.
- As colunas são permitidas explicitamente pelo código. O conteúdo passa pelos validadores de seletores, exploração, receitas, URLs, compartilhamento e permissões, além de rejeitar credenciais fixas. A conta restrita do backend não é utilizada pelo CLI.

## Testes

`test/admin-seed.test.mjs` recria o schema em memória e verifica conteúdo, ausência de catálogo/categorias/credenciais, igualdade das configurações, dry-run, reexecução, preservação de edições, conflitos e rollback por falha SQL. A integração PostgreSQL em `test/database-security.integration.test.mjs` valida também duas cargas concorrentes e acesso posterior pela conta restrita. Ambos executam isolados do banco de desenvolvimento.
