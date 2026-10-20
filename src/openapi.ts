import {catalogApiPaths} from './catalog-openapi.js';
import {urlNormalizationRulesSchema} from './url-normalization.js';
import {z} from 'zod';
import {discoveryProfileInput,discoverySourceInput,discoveryConfigSchema} from './discovery-config.js';
import {extensionApiPaths} from './extension-openapi.js';
import type {Config} from './config.js';

type Schema=Record<string,any>;
const ref=(name:string):Schema=>({$ref:'#/components/schemas/'+name});
const object=(properties:Record<string,Schema>,required:string[]=[]):Schema=>({type:'object',properties,...(required.length?{required}:{})});
const array=(items:Schema):Schema=>({type:'array',items});
const str=(maxLength?:number):Schema=>({type:'string',...(maxLength?{maxLength}:{})});
const uuid:Schema={type:'string',format:'uuid'},date:Schema={type:'string',format:'date-time'},url:Schema={type:'string',format:'uri'};
const cents:Schema={type:'integer',minimum:1,maximum:100000000,description:'Valor em centavos de BRL.'};
const nullable=(s:Schema):Schema=>s.$ref?{allOf:[s],nullable:true}:{...s,nullable:true};
const enumeration=(...values:string[]):Schema=>({type:'string',enum:values});
const bool:Schema={type:'boolean'},free:Schema={type:'object',additionalProperties:true};
const version=object({expectedUpdatedAt:date},['expectedUpdatedAt']);
const categoryNode=object({id:uuid,path:{...array(str(80)),minItems:1,maxItems:10},depth:{type:'integer',minimum:1,maximum:10}});
const classification={categoryPath:{...array({...str(80),minLength:1}),minItems:1,maxItems:10,description:'Caminho completo da categoria. Obrigatório quando category não é informado.'},category:{...str(80),minLength:1},subcategory:{...str(80),default:''}};
const productInput=object({name:{...str(300),minLength:1},description:{...str(4000),default:''},brand:str(120),model:str(120),...classification,imageUrl:nullable(url)},['name']);
productInput.anyOf=[{required:['categoryPath']},{required:['category']}];
const offerEdit=object({title:{...str(300),minLength:1},description:str(4000),conditions:str(1500),featured:bool,priceCents:cents,originalPriceCents:nullable(cents),expiresAt:date},['title']);
const profileRule=object({field:enumeration('title','brand','price','originalPrice','images','description','specifications','conditions','category','externalId','productUrl'),selectors:{...array(str(600)),minItems:1,maxItems:15},mode:{...enumeration('text','attribute','pairs'),default:'text'},attribute:str(80),required:bool,wholeSelector:str(600),fractionSelector:str(600),nameSelector:str(300),valueSelector:str(300)},['field','selectors']);
const profileInput=object({version:{type:'integer',minimum:0},rules:{...array(ref('SelectorRule')),minItems:2,maxItems:40},waitTimeoutMs:{type:'integer',minimum:1000,maximum:30000,default:15000},validityMinutes:{type:'integer',minimum:15,maximum:1440,default:360}},['version','rules']);
const marketInput=object({id:{type:'string',pattern:'^[a-z][a-z0-9_-]{1,39}$'},name:{...str(80),minLength:2},websiteUrl:url,logoUrl:{...str(2000),description:'URL HTTPS pública da imagem oficial; vazio remove o logo.'},allowedHosts:{...array(str()),minItems:1,maxItems:20,description:'Hosts exatos, públicos, sem protocolo/caminho. Inclua os hosts de redirecionamento.'},scrapingEnabled:bool,urlNormalizationRules:z.toJSONSchema(urlNormalizationRulesSchema,{target:'openapi-3.0'})},['id','name','websiteUrl','allowedHosts','scrapingEnabled']);
const filters={categoryId:{...str(),description:'ID de qualquer nível; inclui todos os descendentes. Vazio remove o filtro.'},q:{...str(160),default:''},marketplace:{...str(40),default:''},category:{...str(80),default:''},maxPrice:{type:'integer',minimum:0,maximum:100000000,default:0,description:'Preço máximo em centavos; 0 remove o limite.'},sort:{...enumeration('recent','price_asc','discount'),default:'recent'}};
const product=object({id:uuid,name:str(),description:str(),brand:str(),model:str(),category:str(),subcategory:str(),category_path:array(str(80)),category_ids:array(uuid),image_url:nullable(url),created_at:date,updated_at:date});
const offer=object({availability_status:enumeration('available','unavailable'),refresh_status:enumeration('updated','pending'),data_updated_at:date,last_refresh_attempt_at:nullable(date),last_refresh_error:nullable(str()),id:uuid,product_id:uuid,marketplace_id:str(),marketplace_name:str(),marketplace_logo_url:str(2000),external_id:str(),seller_name:str(),title:str(),description:str(),category:str(),subcategory:str(),category_path:array(str(80)),category_ids:array(uuid),image_url:nullable(url),product_url:url,affiliate_url:nullable(url),price_cents:cents,original_price_cents:nullable(cents),currency:enumeration('BRL'),status:enumeration('pending','published','rejected','expired'),source:enumeration('api','manual','scraped'),conditions:str(),featured:bool,images:array(url),specifications:array(ref('Specification')),extraction_metadata:free,verified_at:date,expires_at:date,published_at:nullable(date),created_at:date,updated_at:date});
const summary={display_image_url:nullable(url),min_price_cents:nullable(cents),max_price_cents:nullable(cents),offer_count:{type:'integer',minimum:0}};
const schemas:Record<string,Schema>={
 Error:object({error:str(),fields:array(object({field:str(),message:str()}))},['error']),Ok:object({ok:{type:'boolean',enum:[true]}},['ok']),
 User:object({id:uuid,email:{type:'string',format:'email'},name:str(),avatar:nullable(url),role:enumeration('user','admin'),access_profile_id:str(),permissions:array(str())}),
 Session:object({user:nullable(ref('User')),autoSignInAllowed:bool}),Specification:object({name:str(150),value:str(600)},['name','value']),
 ProductInput:productInput,Product:product,
 ProductUpdate:{allOf:[ref('ProductInput'),version]},
 ProductSummary:{allOf:[ref('Product'),object(summary)]},
 ProductDetail:{allOf:[ref('Product'),object({...summary,available:bool,status:enumeration('available','unavailable'),offers:array(ref('Offer'))})]},
 AdminProduct:{allOf:[ref('Product'),object({sku:str(),link_count:{type:'integer'},available_count:{type:'integer'}})]},
 ProductPage:object({items:array(ref('ProductSummary')),total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer',enum:[24]}}),
 Offer:offer,OfferEdit:offerEdit,
 OfferPage:object({items:array(ref('Offer')),total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer',enum:[24]}}),
 Filters:object(filters),SavedFilter:object({id:uuid,user_id:uuid,name:str(),filters:ref('Filters'),created_at:date}),
 CollectionInput:object({name:{...str(80),minLength:1},description:str(400)},['name']),
 Collection:object({id:uuid,name:str(),description:str(),item_count:{type:'integer'},created_at:date,items:array(ref('Offer'))}),
 MarketInput:marketInput,Marketplace:object({id:str(),name:str(),website_url:url,logo_url:str(2000)}),
 CatalogMarketplace:object({id:str(),name:str(),website_url:url,logo_url:str(2000),allowed_hosts:array(str()),scraping_enabled:bool,url_normalization_rules:z.toJSONSchema(urlNormalizationRulesSchema,{target:'openapi-3.0'})}),
 SelectorRule:profileRule,ProfileInput:profileInput,
 SelectorProfile:object({marketplace_id:str(),rules:array(ref('SelectorRule')),version:{type:'integer'},wait_timeout_ms:{type:'integer'},validity_minutes:{type:'integer'},updated_at:date}),
 ExtractedData:object({title:str(),description:str(),category:str(),subcategory:str(),sellerName:str(),priceCents:nullable(cents),originalPriceCents:nullable(cents),conditions:str(),externalId:str(),productUrl:url,images:array(url),specifications:array(ref('Specification')),warnings:array(str()),missing:array(str()),evidence:array(object({field:str(),selector:str()})),collectedAt:date}),
 LinkPreview:object({previewId:uuid,product:ref('AdminProduct'),marketplaceId:str(),marketplaceName:str(),affiliateUrl:url,data:ref('ExtractedData'),expiresAt:date,canConfirm:bool}),
 SelectorTestResult:object({data:ref('ExtractedData'),marketplaceName:str(),affiliateUrl:url,isTest:{type:'boolean',enum:[true]},canConfirm:{type:'boolean',enum:[true]}}),
 ImportedLink:object({id:uuid,title:str(),marketplace_id:str(),marketplace_name:str(),affiliate_url:url,status:enumeration('pending','published','rejected','expired'),price_cents:cents,created_at:date,updated_at:date,category:str(),subcategory:str(),product_id:uuid,product_name:str(),product_sku:str(),seller_name:str()}),
 AuditEntry:object({id:uuid,email:nullable(str()),action:str(),entity_id:str(),created_at:date}),
 Stats:object({days:{type:'integer'},offers:array(object({status:str(),count:{type:'integer'}})),marketplaces:array(object({id:str(),name:str(),clicks:{type:'integer'}})),top:array(object({id:uuid,title:str(),marketplace_id:str(),clicks:{type:'integer'}})),daily:array(object({day:{type:'string',format:'date'},clicks:{type:'integer'}})),totalClicks:{type:'integer'}})
};
const parameter=(name:string,schema:Schema,where='query',required=false)=>({name,in:where,required,schema});
const filterParams=Object.entries(filters).map(([key,value])=>parameter(key,value));
const pageParam=parameter('page',{type:'integer',minimum:1,maximum:10000,default:1});
const response=(description:string,schema?:Schema)=>({description,...(schema?{content:{'application/json':{schema}}}:{})});
const errors:Record<string,string>={'400':'Campos ou parâmetros inválidos.','401':'Sessão autenticada necessária.','403':'Origem/token XSRF inválido ou permissão insuficiente.','404':'Registro não encontrado ou indisponível.','409':'Conflito, versão desatualizada ou operação indisponível.','422':'Página do marketplace indisponível para extração.','429':'Limite de requisições ou extrações atingido.','500':'Falha interna.','502':'Falha do serviço externo.','503':'Integração não configurada.','504':'Tempo de espera do serviço externo excedido.'};

export function createOpenApiDocument(config:Pick<Config,'APP_ORIGIN'>){
 const paths:Record<string,any>={};
 function add(method:string,path:string,tag:string,title:string,options:{body?:Schema;result?:Schema;status?:number;parameters?:any[];description?:string;role?:'public'|'user'|'admin';deprecated?:boolean;responses?:Record<string,any>}={}){
  const mutating=!['get','head','options'].includes(method),role=options.role??(path.startsWith('/admin/')?'admin':path.startsWith('/me/')?'user':'public');
  const params=[...(options.parameters??[])];
  for(const match of path.matchAll(/\{([^}]+)\}/g)){const name=match[1];if(!params.some(p=>p.in==='path'&&p.name===name))params.push(parameter(name,uuid,'path',true));}
  const security=role==='public'&&!mutating?[]:[{SessionCookie:[],...(mutating?{XSRFToken:[]}:{})}];
  const operation:any={tags:[tag],summary:title,operationId:method+'_'+path.replace(/[^a-zA-Z0-9]+/g,'_'),description:[options.description,role==='admin'?'Requer papel admin ou perfil com a permissão da área.':role==='user'?'Requer login.':null,mutating?'Requer sessão (inclusive anônima), cabeçalho X-XSRF-TOKEN e Origin igual a APP_ORIGIN.':null].filter(Boolean).join(' '),security,responses:options.responses??{[options.status??200]:response('Sucesso.',options.result??ref('Ok')),...Object.fromEntries(Object.entries(errors).map(([status,message])=>[status,response(message,ref('Error'))]))}};
  if(params.length)operation.parameters=params;if(options.body)operation.requestBody={required:true,content:{'application/json':{schema:options.body}}};if(options.deprecated)operation.deprecated=true;
  paths[path]??={};paths[path][method]=operation;
 }
 const marketParam=parameter('id',{type:'string',pattern:'^[a-z][a-z0-9_-]{1,39}$'},'path',true);
 add('get','/health','Sistema','Verificar conexão com o banco',{result:object({status:enumeration('ok')})});
 add('get','/config','Sistema','Consultar configuração pública de login',{result:object({googleClientId:str(),loginAvailable:bool})});
 add('get','/auth/session','Autenticação','Consultar usuário e iniciar sessão XSRF',{result:ref('Session'),description:'Cria sessão anônima e cookies espertinho.sid (HttpOnly) e XSRF-TOKEN se necessário. Não retorna os tokens no JSON.'});
 add('post','/auth/google','Autenticação','Entrar com Google',{body:object({automatic:{...bool,default:false,description:'Tentativa automática; recusada após saída explícita.'},credential:{...str(10000),minLength:1,writeOnly:true,description:'ID token obtido pelo Google Identity Services; não é um client secret.'}},['credential']),result:ref('Session'),description:'Valida o ID token e regenera a sessão. O e-mail administrador já reservado é reconhecido pelo backend.'});
 add('post','/auth/reauth/challenge','Autenticação','Iniciar confirmação administrativa',{role:'user',result:object({nonce:str(64)},['nonce'])});
 add('post','/auth/reauth','Autenticação','Confirmar a mesma conta Google com nonce de uso único',{role:'user',body:object({credential:str(10000)},['credential'])});
 add('post','/auth/logout','Autenticação','Encerrar login e renovar sessão anônima');
 add('get','/price-history','Catálogo público','Consultar histórico diário de preços por link ou produto',{parameters:[parameter('kind',enumeration('product','offer'),'query',true),parameter('ids',str(1800),'query',true),parameter('days',{type:'integer',minimum:1,maximum:365,default:90}),parameter('from',{type:'string',format:'date'}),parameter('to',{type:'string',format:'date'}),parameter('details',enumeration('true','false'))],result:object({startDate:{type:'string',format:'date'},endDate:{type:'string',format:'date'},intervalDays:{type:'integer'},timeZone:enumeration('America/Sao_Paulo'),aggregation:enumeration('daily_minimum','link_price'),series:array(object({id:uuid,isCheapestOffer:bool,productLowestPriceCents90d:{...nullable(cents),description:'Menor preço diário entre todos os links do produto nos últimos 90 dias, independentemente do período do gráfico.'},lowestPriceCents:nullable(cents),points:array(object({date:{type:'string',format:'date'},observedDate:nullable({type:'string',format:'date'}),priceCents:nullable(cents)})),daily:array(object({date:{type:'string',format:'date'},priceCents:nullable(cents)}))}))}),description:'Até 48 IDs separados por vírgula. Padrão: 90 dias com pontos a cada 10 dias. Para produto, calcula primeiro o menor preço diário dos links; cada ponto é o último dia observado no intervalo. Sem preenchimento de lacunas. from/to substituem days; ambos são obrigatórios juntos, com até 365 dias inclusivos. details=true inclui os registros diários. Histórico de link pendente ou rejeitado não é público.'});
 add('get','/marketplaces' ,'Catálogo público','Listar marketplaces',{result:array(ref('Marketplace'))});
 add('get','/category-tree','Catálogo público','Listar todos os caminhos de categorias navegáveis',{result:array(categoryNode)});
 add('get','/admin/category-tree','Produtos','Listar todos os caminhos cadastrados para os combos',{result:array(categoryNode)});
 add('get','/categories','Catálogo público','Listar categorias com ofertas disponíveis',{result:array(str())});
 add('get','/products','Catálogo público','Listar produtos da vitrine',{parameters:[...filterParams,pageParam],result:ref('ProductPage'),description:'Um resultado por produto, somente com ofertas publicadas, disponíveis e com link. Faixa de preço considera todas as ofertas disponíveis, mesmo ao filtrar por marketplace.'});
 add('get','/products/{id}','Catálogo público','Consultar produto e suas ofertas',{result:ref('ProductDetail'),description:'Produto sem ofertas continua acessível, com available=false, status=unavailable e preços nulos.'});
 add('get','/offers','Catálogo público','Listar ofertas individuais disponíveis (inclui atualização pendente)',{parameters:[...filterParams,pageParam],result:ref('OfferPage')});
 add('get','/offers/{id}','Catálogo público','Consultar uma oferta disponível',{result:ref('Offer')});
 add('post','/offers/{id}/click','Catálogo público','Registrar clique anônimo',{body:object({placement:{...enumeration('home','search','detail','favorites','collection'),default:'detail'}}),description:'Registra somente oferta, marketplace, posição e horário; não identifica o usuário nem confirma compra.'});
 add('get','/me/favorites','Área pessoal','Listar favoritos',{result:array(ref('Offer'))});
 add('put','/me/favorites/{id}','Área pessoal','Favoritar oferta disponível');add('delete','/me/favorites/{id}','Área pessoal','Remover favorito');
 add('get','/me/filters','Área pessoal','Listar filtros salvos',{result:array(ref('SavedFilter'))});
 add('post','/me/filters','Área pessoal','Salvar filtro',{body:object({name:{...str(80),minLength:1},filters:ref('Filters')},['name','filters']),result:ref('SavedFilter'),status:201});
 add('delete','/me/filters/{id}','Área pessoal','Excluir filtro');
 add('get','/me/collections','Área pessoal','Listar catálogos privados',{result:array(ref('Collection'))});
 add('post','/me/collections','Área pessoal','Criar catálogo privado',{body:ref('CollectionInput'),result:ref('Collection'),status:201});
 add('get','/me/collections/{id}','Área pessoal','Consultar catálogo e suas ofertas',{result:ref('Collection')});
 add('patch','/me/collections/{id}','Área pessoal','Editar catálogo',{body:ref('CollectionInput')});
 add('delete','/me/collections/{id}','Área pessoal','Excluir catálogo');
 add('put','/me/collections/{id}/items/{offerId}','Área pessoal','Adicionar oferta disponível ao catálogo');
 add('delete','/me/collections/{id}/items/{offerId}','Área pessoal','Remover oferta do catálogo');
 add('delete','/me/account','Área pessoal','Excluir conta e seus dados pessoais',{description:'Conta administradora não pode ser excluída por esta operação.'});
 add('get','/admin/products','Produtos','Listar produtos, incluindo indisponíveis',{parameters:[parameter('q',str(160))],result:array(ref('AdminProduct'))});
 add('post','/admin/products','Produtos','Cadastrar produto sem exigir links',{body:ref('ProductInput'),result:ref('AdminProduct'),status:201,description:'SKU interno é gerado automaticamente. categoryPath aceita de 1 a 10 níveis; novas opções são salvas por ramificação. category/subcategory continuam aceitos para clientes antigos.'});
 add('put','/admin/products/{id}','Produtos','Editar produto e classificação',{body:ref('ProductUpdate'),result:ref('AdminProduct'),description:'expectedUpdatedAt deve corresponder ao updated_at recebido. Classificação é propagada às ofertas vinculadas.'});
 add('put','/admin/offers/{id}/product','Produtos','Corrigir produto vinculado a uma oferta',{body:object({productId:uuid,expectedUpdatedAt:date},['productId','expectedUpdatedAt']),description:'Requer produto existente e devolve a oferta para revisão.'});
 add('get','/admin/category-options','Produtos','Listar categorias e subcategorias cadastradas',{result:array(object({category:str(),subcategory:str()}))});
 add('get','/admin/catalog-marketplaces','Marketplaces','Listar cadastro de lojas para extração',{result:array(ref('CatalogMarketplace'))});
 add('post','/admin/catalog-marketplaces','Marketplaces','Cadastrar marketplace',{body:ref('MarketInput'),status:201});
 add('put','/admin/catalog-marketplaces/{id}','Marketplaces','Editar marketplace e hosts permitidos',{body:ref('MarketInput'),parameters:[marketParam]});
 add('post','/admin/catalog-marketplaces/normalize-url','Marketplaces','Pré-visualizar normalização de URL sem acessar a página',{body:object({url:url,allowedHosts:array(str()),rules:z.toJSONSchema(urlNormalizationRulesSchema,{target:'openapi-3.0'})},['url','allowedHosts','rules']),result:object({url:url}),description:'Operação pura: não acessa a rede nem grava dados. As regras só removem sufixos do caminho de links descobertos; query e fragmento são descartados. Não altera URLs de seção ou links de afiliados.'});
 add('delete','/admin/catalog-marketplaces/{id}','Marketplaces','Excluir marketplace personalizado sem histórico',{parameters:[marketParam],description:'Somente marketplaces sem histórico ou referências podem ser excluídos.'});
 const redirectResponse={'303':{description:'Redireciona para a origem fixa da aplicação.',headers:{Location:{schema:url}}},'400':response(errors['400'],ref('Error'))};
 const oauthParams=[parameter('state',str(64),'query',true),parameter('code',str(4096)),parameter('error',str())];
 add('get','/admin/selectors/{id}','Extração e links','Consultar perfil de seletores',{parameters:[marketParam],result:ref('SelectorProfile')});
 add('put','/admin/selectors/{id}','Extração e links','Salvar seletores com controle de versão',{parameters:[marketParam],body:ref('ProfileInput'),result:object({ok:bool,version:{type:'integer'}}),description:'Inclua regras para title e price. version=0 cria; alterações exigem a versão atual.'});
 add('post','/admin/selectors/{id}/test','Extração e links','Testar seletores sem salvar oferta',{parameters:[marketParam],body:object({url:url,profile:ref('ProfileInput')},['url','profile']),result:ref('SelectorTestResult')});
 add('post','/admin/link-imports/preview','Extração e links','Extrair link e gerar prévia',{body:object({marketplaceId:str(40),productId:uuid,url:url,sellerName:str(200)},['marketplaceId','productId','url']),result:ref('LinkPreview'),description:'Produto precisa existir. O link de afiliado é preservado. A classificação vem do produto. A prévia pertence ao admin e expira em 15 minutos.'});
 add('post','/admin/link-imports/confirm','Extração e links','Confirmar cadastro da prévia',{body:object({previewId:uuid,authorizedContent:{type:'boolean',enum:[true]}},['previewId','authorizedContent']),result:object({ok:bool,offerId:uuid,status:enumeration('pending')}),status:201,description:'Cria oferta pendente, com o produto fixado na prévia. Alteração do produto/perfil ou expiração invalida a confirmação.'});
 add('get','/admin/link-imports','Extração e links','Listar últimos 100 links extraídos',{result:array(ref('ImportedLink'))});
 add('get','/admin/offers','Revisão de ofertas','Listar ofertas para revisão',{parameters:[parameter('status',{...enumeration('all','pending','published','rejected','expired'),default:'pending'}),pageParam],result:array(ref('Offer')),description:'Retorna até 50 ofertas por página.'});
 add('patch','/admin/offers/{id}','Revisão de ofertas','Editar oferta e devolver para revisão',{body:ref('OfferEdit'),description:'Conteúdo, preço e validade de ofertas de API são preservados pelo conector. Em ofertas manuais/extraídas, validade futura de até sete dias.'});
 add('delete','/admin/offers/{id}','Revisão de ofertas','Excluir oferta encerrada',{body:version,description:'Somente status expired. Exclui favoritos, itens de catálogos, cliques e prévias associados; mantém produto e auditoria.'});
 add('post','/admin/offers/{id}/review','Revisão de ofertas','Publicar, rejeitar ou encerrar oferta',{body:object({action:enumeration('publish','reject','expire'),expectedUpdatedAt:date},['action']),description:'Para publish, expectedUpdatedAt é obrigatório; a oferta deve estar válida e ter link. Ofertas de API são revalidadas.'});
 add('put','/admin/offers/{id}/classification','Revisão de ofertas','Classificação legada indisponível',{deprecated:true,description:'Sempre retorna 409. Edite categoria e subcategoria no produto.',responses:{'409':response(errors['409'],ref('Error'))}});
 add('get','/admin/stats','Métricas e auditoria','Resumo de ofertas e cliques anônimos',{parameters:[parameter('days',{type:'integer',minimum:1,maximum:365,default:30})],result:ref('Stats')});
 add('get','/admin/audit','Métricas e auditoria','Consultar últimas 100 alterações administrativas',{result:array(ref('AuditEntry'))});
 const accessPermission=enumeration('overview','catalog','marketplaces','selectors','updates','activity','users','affiliate_links','discovery');
 const accessInput=object({name:{...str(80),minLength:1},description:str(400),permissions:{...array(accessPermission),maxItems:9}},['name']);
 const accessProfile=object({id:str(),name:str(),description:str(),permissions:array(accessPermission),system:bool,updated_at:date,user_count:{type:'integer'}});
 add('get','/admin/access-profiles','Usuários e perfis','Listar perfis e permissões disponíveis',{result:object({profiles:array(accessProfile),permissions:array(object({id:accessPermission,name:str()}))}),description:'Requer permissão users. Perfis padrão admin e user são imutáveis. Gestão de usuários permite conceder acesso administrativo.'});
 add('post','/admin/access-profiles','Usuários e perfis','Criar perfil de acesso',{body:accessInput,status:201,result:object({id:str()}),description:'Requer permissão users. Nomes são únicos sem distinção de maiúsculas.'});
 add('put','/admin/access-profiles/{id}','Usuários e perfis','Editar perfil personalizado',{parameters:[parameter('id',str(),'path',true)],body:{allOf:[accessInput,version]},description:'Requer permissão users e expectedUpdatedAt. Alterações afetam as próximas requisições dos usuários vinculados.'});
 add('delete','/admin/access-profiles/{id}','Usuários e perfis','Excluir perfil sem usuários',{parameters:[parameter('id',str(),'path',true)],description:'Requer permissão users. Perfis padrão ou associados a usuários retornam 409.'});
 add('get','/admin/users','Usuários e perfis','Pesquisar usuários cadastrados pelo Google',{parameters:[parameter('q',str(160)),parameter('page',{type:'integer',minimum:1,default:1}),parameter('pageSize',{type:'integer',minimum:1,maximum:50,default:25}),parameter('profile',str()),parameter('status',enumeration('all','active','blocked'))],result:object({items:array({allOf:[ref('User'),object({blocked:bool,created_at:date,profile_name:str()})]}),total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer',minimum:1,maximum:50,default:25}}),description:'Requer permissão users. Não expõe google_sub nem sessões.'});
 add('patch','/admin/users/{id}','Usuários e perfis','Alterar perfil e bloquear ou desbloquear conta',{body:object({profileId:str(80),blocked:bool,expectedProfileId:str(80),expectedBlocked:bool},['profileId','blocked','expectedProfileId','expectedBlocked']),description:'Requer permissão users. Bloqueio revoga sessões e impede login Google. Proíbe alterar o próprio acesso e remover o último administrador ativo. Alterações concorrentes retornam 409.'});
 paths['/admin/stats'].get.parameters.push(parameter('paginate',{type:'boolean',default:false}),parameter('topPage',{type:'integer',minimum:1,maximum:100000,default:1}),parameter('pageSize',{type:'integer',minimum:1,maximum:50,default:5}));
 paths['/admin/stats'].get.description='Com paginate=true, pagina o ranking completo em top e retorna topTotal, topPage e topPageSize, preservando as métricas globais do período.';
 const pagedPaths=['/me/favorites','/me/filters','/me/collections','/me/collections/{id}','/products/{id}','/admin/products','/admin/catalog-marketplaces','/admin/link-imports','/admin/offers','/admin/audit'];
 const keys:Record<string,string>={'/products/{id}':'offers'},totals:Record<string,string>={'/products/{id}':'offer_count'};
 for(const path of pagedPaths){
  const operation=paths[path]?.get;if(!operation){continue;}
  operation.parameters=[...(operation.parameters??[]).filter((p:any)=>p.name!=='page'),parameter('paginate',{type:'boolean',default:false}),parameter('page',{type:'integer',minimum:1,maximum:100000,default:1}),parameter('pageSize',{type:'integer',minimum:1,maximum:50,default:20})];
  const response=operation.responses['200'].content['application/json'];
  const legacy=response.schema;
  const key=keys[path]??'items';
  const rows=legacy.type==='array'?legacy:legacy.properties?.[key]??array(free);
  const totalKey=totals[path]??'total';
  response.schema={anyOf:[legacy,object({[key]:rows,[totalKey]:{type:'integer',minimum:0},page:{type:'integer',minimum:1},pageSize:{type:'integer',minimum:1,maximum:50}},[key,totalKey,'page','pageSize'])]};
  operation.description=(operation.description??'')+' Com paginate=true, retorna paginação no banco com total, page e pageSize (20 por padrão, máximo 50). Coleções simples retornam items; detalhes de catálogo usam items; produto usa offers e offer_count; execuções usam runs; detalhes de execução usam errors e errorTotal. Sem paginate, mantém o contrato anterior. Páginas além do fim são ajustadas à última disponível.';
 }
 const discoveryDescription='O cadastro apenas persiste configurações e não inicia nenhum job. A exploração é iniciada manualmente pela extensão do Chrome; não existe agendamento. Exige permissão discovery; escritas exigem confirmação administrativa recente. URLs de seção e templates preservam parâmetros de busca/paginação; fragmentos são removidos das URLs de seção. Seletores CSS são armazenados, sem teste no marketplace nesta etapa.';
 add('get','/admin/discovery/defaults','Exploração','Obter configuração inicial',{result:object({config:z.toJSONSchema(discoveryConfigSchema,{target:'openapi-3.0'}),executionAvailable:{type:'boolean',enum:[true]}}),description:discoveryDescription});
 add('get','/admin/discovery/profile-options','Exploração','Listar perfis para seleção',{parameters:[parameter('marketplaceId',str(40))],result:array(object({id:uuid,name:str(120),marketplace_id:str(40)})),description:discoveryDescription});
 for(const [kind,input] of [['profiles',discoveryProfileInput],['sources',discoverySourceInput]] as const){
  const body=z.toJSONSchema(input,{target:'openapi-3.0'});
  const record=object({id:uuid,marketplace_id:str(40),name:str(120),version:{type:'integer',minimum:1},created_at:date,updated_at:date,...(kind==='profiles'?{config:z.toJSONSchema(discoveryConfigSchema,{target:'openapi-3.0'})}:{profile_id:uuid,url:url,source_category_path:array(str(120)),enabled:bool,notes:str(2000)})});
  add('get','/admin/discovery/'+kind,'Exploração','Listar configurações de '+kind,{parameters:[pageParam,parameter('pageSize',{type:'integer',minimum:1,maximum:50,default:20}),parameter('marketplaceId',str(40)),parameter('q',str(120)),parameter('enabled',enumeration('','true','false'))],result:object({items:array(record),total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer'}}),description:discoveryDescription});
  add('get','/admin/discovery/'+kind+'/{id}','Exploração','Consultar configuração de '+kind,{result:record,description:discoveryDescription});
  add('post','/admin/discovery/'+kind,'Exploração','Criar configuração de '+kind,{body,result:record,status:201,description:discoveryDescription});
  add('put','/admin/discovery/'+kind+'/{id}','Exploração','Atualizar configuração de '+kind,{body:{...body,properties:{...body.properties,version:{type:'integer',minimum:1}},required:[...(body.required??[]),'version']},result:record,description:discoveryDescription});
  add('delete','/admin/discovery/'+kind+'/{id}','Exploração','Excluir configuração de '+kind,{body:object({version:{type:'integer',minimum:1}},['version']),description:discoveryDescription});
 }
 const discoveryPage=(item:any)=>object({items:array(item),total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer'}});
 add('get','/admin/discovery/links','Exploração','Listar links descobertos',{parameters:[pageParam,parameter('pageSize',{type:'integer',minimum:1,maximum:50}),parameter('marketplaceId',str()),parameter('sourceId',str()),parameter('status',enumeration('','pending','archived'))],result:discoveryPage(object({id:uuid,url:url,marketplace_id:str(),marketplace_name:str(),status:enumeration('pending','archived'),first_seen_at:date,last_seen_at:date,sources:array(object({id:uuid,name:str(),categoryPath:array(str())}))}))});
 add('post','/admin/discovery/links/{id}/archive','Exploração','Arquivar um link descoberto',{description:'Preserva a identidade do link. Uma nova descoberta atualiza a última ocorrência, mas não desfaz o arquivamento.'});
 Object.assign(paths,extensionApiPaths(),catalogApiPaths());
 const enrich='/admin/discovery/enrichment';
 const enrichDescription='Exige perfil discovery ou catalog, sessão, XSRF e confirmação recente para escritas. Não agenda nem publica ofertas. Mapeamentos são sugestões; a categoria exige confirmação por item.';
 const enrichPage=[pageParam,parameter('pageSize',{type:'integer',minimum:1,maximum:50})];
 add('post',enrich+'/review/{id}/retry','Exploração','Retentar um link com falha',{status:202,result:free,description:enrichDescription+' Marca somente este link como pendente, se ainda estiver com falha e não arquivado. A nova tentativa deve ser iniciada no passo 3 da extensão; não cria job.'});
 add('get',enrich+'/review','Exploração','Revisar dados, árvore de origem e sugestão de categoria',{parameters:[...enrichPage,parameter('marketplaceId',str(40)),parameter('state',enumeration('','pending','completed','failed')),parameter('sourceCategory',str(1000))],result:discoveryPage(free)});
 add('get',enrich+'/categories','Exploração','Listar categorias de destino',{result:array(categoryNode)});
 add('post',enrich+'/categories','Exploração','Criar uma árvore de categorias durante a revisão',{status:201,body:object({categoryPath:{...array({...str(80),minLength:1}),minItems:1,maxItems:10}},['categoryPath']),result:object({id:uuid,path:array(str(80)),nodes:array(categoryNode)}),description:enrichDescription+' Cria ou reutiliza os níveis existentes; não atribui a categoria ao item nem altera mapeamentos.'});
 add('post',enrich+'/review/{id}/category','Exploração','Confirmar categoria de um item',{body:object({categoryId:uuid,version:{type:'integer',minimum:0},saveMapping:bool},['categoryId','version']),description:enrichDescription+' saveMapping atualiza apenas sugestões dos demais itens; não os aprova. Versão divergente retorna 409.'});
 add('get',enrich+'/review/{id}/products','Exploração','Buscar produtos da categoria confirmada e suas subcategorias',{parameters:[...enrichPage,parameter('q',str(160))],result:discoveryPage(product),description:enrichDescription+' Exige categoria confirmada; pesquisa por nome ou SKU.'});
 add('post',enrich+'/review/{id}/product','Exploração','Atribuir produto existente ou criar e atribuir atomicamente',{body:{oneOf:[object({mode:enumeration('existing'),version:{type:'integer',minimum:0},productId:uuid},['mode','version','productId']),object({mode:enumeration('new'),version:{type:'integer',minimum:0},product:object({name:str(300),description:str(4000),brand:str(120),imageUrl:nullable(url)},['name'])},['mode','version','product'])]},result:object({product,status:enumeration('ready_for_review')}),description:enrichDescription+' Novos produtos herdam a categoria confirmada. Versão divergente retorna 409, sem criar produto. Não gera link nem publica.'});
 add('post',enrich+'/review/{id}/archive','Exploração','Arquivar item em revisão',{description:enrichDescription});
 add('get',enrich+'/mappings','Exploração','Listar mapeamentos de árvores',{parameters:enrichPage,result:discoveryPage(free)});
 add('put',enrich+'/mappings/{id}','Exploração','Alterar mapeamento sem mudar categorias confirmadas',{body:object({categoryId:uuid},['categoryId']),description:enrichDescription});
 add('delete',enrich+'/mappings/{id}','Exploração','Excluir mapeamento sem mudar categorias confirmadas',{description:enrichDescription});
 return {openapi:'3.0.3',info:{title:'O Espertinho API',version:'1.0.0',description:`API do catálogo de produtos e ofertas. Valores monetários em centavos de BRL.\n\nPara testar operações autenticadas, faça login no site e abra [Swagger na origem da aplicação](${new URL('/api/docs/',config.APP_ORIGIN).href}). O navegador reutiliza os cookies e o Swagger envia o token XSRF automaticamente. A origem das chamadas de escrita precisa ser APP_ORIGIN. Nenhuma proteção de autenticação ou XSRF é desativada.\n\nNo backend diretamente, a documentação e as consultas GET funcionam; para escritas, use a origem indicada acima. As operações executam ações reais: confira os dados antes de enviar. Swagger não recebe client secret do Google nem retorna segredos dos marketplaces.`},servers:[{url:'/api',description:'API na mesma origem da documentação'}],tags:['Sistema','Autenticação','Catálogo público','Área pessoal','Produtos','Marketplaces','Extração e links','Revisão de ofertas','Métricas e auditoria','Atualização de ofertas','Usuários e perfis','Extensão Chrome','Exploração'].map(name=>({name})),paths,components:{schemas,securitySchemes:{ExtensionBearer:{type:'http',scheme:'bearer',description:'Token opaco da extensão, obtido após autorização no site.'},SessionCookie:{type:'apiKey',in:'cookie',name:'espertinho.sid',description:'Cookie HttpOnly criado por /auth/session. Login Google associa usuário à sessão. O navegador o envia automaticamente; não cole cookies no Swagger.'},XSRFToken:{type:'apiKey',in:'header',name:'X-XSRF-TOKEN',description:'Token do cookie XSRF-TOKEN. Preenchido automaticamente pelo Swagger nas chamadas de escrita; é renovado no login/logout.'}}}};
}
