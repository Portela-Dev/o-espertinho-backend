import type {Express,RequestHandler} from 'express';
import swaggerUi from 'swagger-ui-express';
import type {Config} from './config.js';
import {createOpenApiDocument} from './openapi.js';

export function registerApiDocs(app:Express,config:Config){
 const document=createOpenApiDocument(config);
 app.get('/api/openapi.json',(_req,res)=>res.set('Cache-Control','no-store').json(document));
 // Served as an external script so Helmet's script-src self remains intact.
 app.get('/api/docs/xsrf.js',(_req,res)=>res.type('application/javascript').set('Cache-Control','no-store').send(`
 window.espertinhoSwaggerRequest=async function(request){
  const method=(request.method||'GET').toUpperCase();
  if(!['GET','HEAD','OPTIONS'].includes(method)){
   const origin=${JSON.stringify(config.APP_ORIGIN)};
   if(window.location.origin!==origin)throw new Error('Para operações de escrita, abra '+origin+'/api/docs/ e faça login na aplicação.');
   const response=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw new Error('Não foi possível iniciar a sessão XSRF.');
   const cookie=document.cookie.split('; ').find(value=>value.startsWith('XSRF-TOKEN='));
   if(!cookie)throw new Error('Cookie XSRF-TOKEN não encontrado. Atualize a página.');
   request.headers=request.headers||{};
   request.headers['X-XSRF-TOKEN']=decodeURIComponent(cookie.slice('XSRF-TOKEN='.length));
  }
  request.credentials='same-origin';return request;
 };
 `));
 const options={customSiteTitle:'O Espertinho · API',customJs:'/api/docs/xsrf.js',swaggerOptions:{url:'/api/openapi.json',validatorUrl:null,withCredentials:true,persistAuthorization:false,displayRequestDuration:true,filter:true,requestInterceptor:function(request:unknown){return (globalThis as any).espertinhoSwaggerRequest(request);}}};
 const noStore:RequestHandler=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
 app.use('/api/docs',noStore,swaggerUi.serveFiles(undefined,options),swaggerUi.setup(undefined,options));
}
