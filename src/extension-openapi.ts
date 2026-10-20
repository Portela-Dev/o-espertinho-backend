export function extensionApiPaths() {
  const paths: Record<string, unknown> = {};
  const operations = [
    [
      "post",
      "auth/start",
      "Iniciar pareamento com desafio SHA-256",
      { challenge: { type: "string", pattern: "^[a-f0-9]{64}$" } },
      "public",
    ],
    [
      "post",
      "auth/poll",
      "Trocar aprovação por tokens de sessão",
      { deviceCode: { type: "string" }, verifier: { type: "string" } },
      "public",
    ],
    [
      "post",
      "auth/approve",
      "Autorizar extensão com conta real e permissão affiliate_links",
      { code: { type: "string" } },
      "browser",
    ],
    [
      "post",
      "auth/refresh",
      "Renovar sessão com rotação do refresh token",
      { refreshToken: { type: "string" } },
      "public",
    ],
    ["post", "auth/logout", "Revogar sessão da extensão", {}, "extension"],
    ["get", "session", "Consultar conta e permissão atual", null, "extension"],
    [
      "get",
      "config",
      "Obter receitas declarativas de demonstração",
      null,
      "extension",
    ],
    ["get", "queue", "Listar fila demonstrativa do usuário", null, "extension"],
    [
      "post",
      "batches/claim",
      "Reservar até dois itens por 120 segundos",
      { marketplaceId: { type: "string", enum: ["demo"] } },
      "extension",
    ],
    [
      "post",
      "batches/results",
      "Salvar resultados do lote mockado",
      {
        leaseId: { type: "string", format: "uuid" },
        results: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              affiliateUrl: { type: "string", format: "uri" },
              error: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
      "extension",
    ],
    [
      "post",
      "queue/reset",
      "Reiniciar demonstração sem alterar ofertas reais",
      {},
      "extension",
    ],
  ] as const;
  for (const [method, path, summary, properties, auth] of operations) {
    let security: Record<string, never[]>[] = [];
    if (auth === "extension") {
      security = [{ ExtensionBearer: [] }];
    } else if (auth === "browser") {
      security = [{ SessionCookie: [], XSRFToken: [] }];
    }
    paths["/extension/" + path] = {
      [method]: {
        operationId: "extension_" + method + "_" + path.replaceAll("/", "_"),
        tags: ["Extensão Chrome"],
        summary,
        description:
          "Disponível somente fora de produção, com EXTENSION_MOCK_ENABLED=true. Login, sessão e permissão são reais; configuração, fila e conversão são mockadas. A prova de sessão é uma operação separada, explícita e restrita a administradores.",
        security,
        parameters:
          auth === "browser"
            ? []
            : [
                {
                  name: "X-Espertinho-Extension-Id",
                  in: "header",
                  required: true,
                  schema: { type: "string", pattern: "^[a-p]{32}$" },
                },
              ],
        ...(properties && Object.keys(properties).length
          ? {
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties,
                      required: Object.keys(properties),
                    },
                  },
                },
              },
            }
          : {}),
        responses: {
          "200": { description: "Operação concluída." },
          ...(path === "auth/poll"
            ? { "202": { description: "Aguardando aprovação no navegador." } }
            : {}),
          "400": { description: "Contrato inválido." },
          "401": { description: "Sessão inválida ou expirada." },
          "403": { description: "Permissão, origem ou XSRF inválido." },
          "409": { description: "Reserva inválida." },
          "410": { description: "Pareamento expirado ou consumido." },
        },
      },
    };
  }
  const proofOperations = [
    ['get','affiliate-proof/config','Listar receitas reais da prova de conversão local'],
    ['post','affiliate-proof/recipes/{market}','Configurar receita declarativa da prova'],
    ['post','affiliate-proof/tests','Preparar até três links com falha para conversão'],
    ['post','affiliate-proof/tests/{id}/results','Receber somente links convertidos, sem credenciais'],
    ['post','affiliate-proof/tests/{id}/enrich','Solicitar enriquecimento pelas URLs convertidas'],
    ['get','affiliate-proof/tests/{id}','Acompanhar conversões e enriquecimento'],
    ['get','session-proof/marketplaces','Listar marketplaces para a prova'],
    ['post','session-proof/tests','Testar uma sessão temporária no container'],
    ['get','session-proof/tests/{id}','Consultar resultado privado da prova']
  ] as const;
  const proofBody = {
    type:'object', required:['marketplaceId','consent','session'],
    properties:{
      marketplaceId:{type:'string'},url:{type:'string',format:'uri',description:'Obrigatório no teste individual.'},batchFailed:{type:'boolean',default:false,description:'Seleciona até 5 links pendentes com falha de enriquecimento deste marketplace. Sequencial, com 20 s entre acessos; não altera os links.'},consent:{type:'boolean',enum:[true]},
      session:{type:'object',required:['cookies'],description:'Até 48 KiB. Cookies HTTPS de domínios cadastrados, incluindo HttpOnly; origins opcional com localStorage.',properties:{
        cookies:{type:'array',minItems:1,maxItems:200,items:{type:'object'}},
        origins:{type:'array',maxItems:10,items:{type:'object'}}
      }}
    }
  };
  for(const [method,path,summary] of proofOperations){
    paths['/extension/'+path] = {[method]:{
      summary,operationId:'extension_proof_'+method+'_'+path.replaceAll('/','_'),tags:['Extensão Chrome'],
      description:path.startsWith('affiliate-proof')?'Prova fora de produção, restrita a administrador com affiliate_links. Receitas declarativas e URLs, sem envio de cookies ou headers de sessão. Testes privados expiram em 30 minutos. O enriquecimento usa URLs convertidas no snapshot, preservando a identidade original dos itens.':'Prova fora de produção. Exige administrador com affiliate_links. Sessão temporária, sem persistência no banco. Resultado privado expira em cinco minutos no teste individual ou quinze no lote. O lote retorna progresso e resultados por link e usa um contexto novo por acesso com a mesma captura inicial.',
      security:[{ExtensionBearer:[]}],
      parameters:[
        {name:'X-Espertinho-Extension-Id',in:'header',required:true,schema:{type:'string',pattern:'^[a-p]{32}$'}},
        ...(path.includes('{id}')?[{name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}}]:[])
        ,...(path.includes('{market}')?[{name:'market',in:'path',required:true,schema:{type:'string'}}]:[])
      ],
      ...(method==='post'?{requestBody:{required:true,content:{'application/json':{schema:path.startsWith('affiliate-proof')?{type:'object',description:'Receita ou marketplaceId ao preparar; results com id e affiliateUrl ou conversion_failed ao enviar; objeto vazio para enriquecer. Nunca aceita sessão ou cookies.'}:proofBody}}}}:{}),
      responses:{
        '200':{description:'Configuração ou resultado sem cookies'},'201':{description:'Teste de conversão preparado'},'202':{description:'Teste enfileirado'},
        '400':{description:'Sessão ou domínio inválido'},'401':{description:'Extensão não autenticada'},
        '403':{description:'Exige administrador'},'404':{description:'Teste expirado ou de outra sessão'},
        '429':{description:'Teste já em andamento'},'503':{description:'Extrator não configurado'}
      }
    }};
  }
  return paths;
}
