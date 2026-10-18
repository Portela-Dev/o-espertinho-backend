export function extensionApiPaths(){
 const paths:Record<string,unknown>={};
 const operations=[
  ['post','auth/start','Iniciar pareamento com desafio SHA-256',{challenge:{type:'string',pattern:'^[a-f0-9]{64}$'}},'public'],
  ['post','auth/poll','Trocar aprovação por tokens de sessão',{deviceCode:{type:'string'},verifier:{type:'string'}},'public'],
  ['post','auth/approve','Autorizar extensão com conta real e permissão affiliate_links',{code:{type:'string'}},'browser'],
  ['post','auth/refresh','Renovar sessão com rotação do refresh token',{refreshToken:{type:'string'}},'public'],
  ['post','auth/logout','Revogar sessão da extensão',{},'extension'],
  ['get','session','Consultar conta e permissão atual',null,'extension'],
  ['get','config','Obter receitas declarativas de demonstração',null,'extension'],
  ['get','queue','Listar fila demonstrativa do usuário',null,'extension'],
  ['post','batches/claim','Reservar até dois itens por 120 segundos',{marketplaceId:{type:'string',enum:['demo']}},'extension'],
  ['post','batches/results','Salvar resultados do lote mockado',{leaseId:{type:'string',format:'uuid'},results:{type:'array',minItems:1,maxItems:2,items:{type:'object',properties:{id:{type:'string'},affiliateUrl:{type:'string',format:'uri'},error:{type:'string'}},required:['id']}}},'extension'],
  ['post','queue/reset','Reiniciar demonstração sem alterar ofertas reais',{},'extension'],
 ] as const;
 for(const [method,path,summary,properties,auth] of operations){
  paths['/extension/'+path]={[method]:{operationId:'extension_'+method+'_'+path.replaceAll('/','_'),tags:['Extensão Chrome'],summary,description:'Disponível somente fora de produção, com EXTENSION_MOCK_ENABLED=true. Login, sessão e permissão são reais; configuração, fila e conversão são mockadas. Cookies de marketplace não são recebidos pelo backend.',
   security:auth==='extension'?[{ExtensionBearer:[]}]:auth==='browser'?[{SessionCookie:[],XSRFToken:[]}]:[],
   parameters:auth==='browser'?[]:[{name:'X-Espertinho-Extension-Id',in:'header',required:true,schema:{type:'string',pattern:'^[a-p]{32}$'}}],
   ...(properties&&Object.keys(properties).length?{requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties,required:Object.keys(properties)}}}}}:{}),
   responses:{'200':{description:'Operação concluída.'},...(path==='auth/poll'?{'202':{description:'Aguardando aprovação no navegador.'}}:{}),'400':{description:'Contrato inválido.'},'401':{description:'Sessão inválida ou expirada.'},'403':{description:'Permissão, origem ou XSRF inválido.'},'409':{description:'Reserva inválida.'},'410':{description:'Pareamento expirado ou consumido.'}}
  }};
 }
 return paths;
}
