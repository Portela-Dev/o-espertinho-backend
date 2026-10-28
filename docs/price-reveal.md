# Extração de preço após interação

`priceReveal` é uma opção da regra de `price`, salva no JSON de seletores existente. Não exige migration nem aceita scripts. Pode existir em apenas uma regra por perfil, nos modos texto ou atributo.

1. A extensão tenta todos os seletores normalmente, incluindo valores únicos e o primeiro preço de faixas configuradas com `first_in_range`.
2. Se não houver preço válido e o botão configurado já estiver visível e habilitado, retorna imediatamente ao executor para verificar pausa ou cancelamento antes do clique. Não espera o timeout geral nessa situação. Se o botão ainda não estiver pronto, mantém a espera normal de hidratação.
3. A segunda fase verifica novamente os estados de bloqueio e os preços. Caso necessário, clica uma única vez no elemento indicado por `clickSelector`.
4. Aguarda até `waitTimeoutMs` (100–15000 ms, padrão 8000 ms), lendo os seletores já configurados. Preço inválido ou ausente resulta em falha técnica; não torna o anúncio indisponível.
5. Login, CAPTCHA e demais bloqueios continuam exigindo intervenção humana. Um indicador configurado de indisponibilidade encerra a leitura sem clicar. Não há repetição automática do clique.

Controles desabilitados, ocultos, submits de formulário e links para origens não autorizadas são recusados. O comportamento vale para enriquecimento, atualização de preços, prévia e teste de seletores.

## Configurar no admin

Adicione uma regra de preço ao final das regras atuais e informe os seletores do primeiro preço da lista. Ative “Clicar para revelar preço somente se nenhum preço válido for encontrado”, informe o seletor do botão e a espera após o clique. Partes inteira e fracionária e a leitura por faixa permanecem disponíveis. Habilitar outra interação desabilita a anterior.

`examples/amazon-price-reveal.json` contém uma regra de exemplo com os elementos das opções de compra fornecidos no teste. Acrescente-a ao perfil existente, sem substituir as regras atuais de preço único e de faixa. Os seletores precisam ser conferidos no DOM da página real; o exemplo não é uma condição fixa no código nem altera produção automaticamente.

## Publicação e teste

Publique primeiro o backend, depois o frontend e o pacote da extensão. O backend antigo não conhece esta propriedade e pode descartá-la ao salvar. Somente após atualizar os componentes, salve a configuração, atualize as configurações na extensão e inicie nova execução; execuções antigas mantêm seu snapshot.

O exemplo foi validado por testes locais de DOM e por interação em Chromium. Homologação na sessão real da Amazon continua necessária, pois a resposta HTTP pública do endereço de teste não apresentou a página de produto nesta consulta. Nenhuma credencial ou sessão de marketplace é enviada ao backend.
