# Releases main por tag

O único gatilho de deploy é a criação e o push de uma tag `vMAJOR.MINOR.PATCH`, por exemplo `v0.1.0`. O commit precisa ser exatamente o HEAD atual de `origin/main`. Uma tag Git não pertence a uma branch: por isso, o pipeline confere os commits, não apenas o nome da tag. Uma tag em commit divergente ou antigo é recusada.

## Fluxo

1. Revise e faça merge da PR de implementação na `develop`.
2. Promova a versão da `develop` para `main` por PR, incluindo os novos arquivos do pipeline.
3. Habilite o workflow quando estiver pronto para publicar. Nenhuma branch faz deploy por push; o disparo manual também não faz deploy.
4. Atualize sua branch local e crie a tag somente quando quiser iniciar o deploy:

```sh
git fetch origin
git checkout main
git merge --ff-only origin/main
git tag -a v0.1.0 -m "Release main 0.1.0"
git push origin refs/tags/v0.1.0
```

Os comandos de tag acima iniciam o deploy quando o workflow estiver habilitado; não são executados durante a implementação. Não reutilize nem force tags existentes. Use outra versão para uma nova tentativa baseada em commit diferente. Uma repetição do mesmo pipeline ainda revalida o HEAD de main antes de usar SSH. Evite avançar main enquanto a release estiver em validação: se a branch avançar, o deploy antigo será recusado.

Backend e frontend têm releases independentes. No primeiro deploy: publique o backend, execute a prévia e a aplicação manual do seed conforme `SEED-ADMIN.md` (repositório backend), e só depois publique o frontend. O deploy backend continua aplicando migrations e provisionando a conta restrita antes de iniciar a aplicação. O seed não é disparado pela tag.

## Condições preservadas

- O job de deploy depende de validação, imagem e Quality Gate do mesmo commit.
- O runner próprio é usado somente para Sonar; CI, Docker e SSH usam runners hospedados.
- O nome do environment permanece `production`, com os secrets já cadastrados na VPS atual. A branch chama-se main; não há criação de um segundo servidor ou banco.
- Em Settings → Environments → production → Deployment branches and tags, permita somente **tags** com o padrão `v*`, sem regras de branch. Isso impede deploy por versões antigas do workflow executadas em outras branches.
- `VPS_AUTO_DEPLOY` e o antigo input manual `deploy` não controlam mais a implantação. A variável antiga pode ser removida.
- Nenhum push de branch, PR, disparo manual, tag fora do padrão, exclusão ou movimentação de tag autoriza deploy. A política é reavaliada imediatamente antes da transferência SSH.
- A extensão apenas gera seu ZIP como artefato. Sua branch main não implanta nada na VPS nem publica na Web Store.
- A criação das branches não habilita workflows e não cria tags. O estado operacional dos workflows é independente dos arquivos versionados.

Referência: [eventos e filtros de workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), [restrições de branches e tags por environment](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
