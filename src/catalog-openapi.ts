import {publishBatchInput} from './catalog-publication.js';
import {reviewAiInput,reviewAiResult} from './review-ai.js';
import { z } from 'zod';
import { catalogSettings } from './catalog-settings.js';
import { startCatalogInput, actionInput } from './catalog-contracts.js';
import { catalogResultInput } from './catalog-results.js';
export function catalogApiPaths() {
    const paths: Record<string, any> = {};
    const definitions: [
        string,
        string,
        string,
        any?
    ][] = [
        ['get','/admin/discovery/enrichment/ai/settings','Consultar configurações independentes de IA'],
        ['put','/admin/discovery/enrichment/ai/settings','Ativar tarefas e definir prompts; invalida sugestões antigas',reviewAiInput],
        ['post','/admin/discovery/enrichment/ai/suggestions/{id}/discard','Descartar proposta e permitir nova análise',z.strictObject({})],
        ['get','/extension/catalog/ai/config','Configurações e contadores de categorias/produtos confirmados'],
        ['get','/extension/catalog/ai/inventory','Inventário completo e paginado de categorias, produtos e rascunhos, com revisão consistente'],
        ['get','/extension/catalog/ai/queue','Fila elegível de categorização ou catalogação'],
        ['post','/extension/catalog/ai/context','Reservar contexto e obter candidatos sem credenciais OpenAI',z.strictObject({id:z.uuid(),task:z.enum(['category','product']),inventoryRevision:z.string().regex(/^\d+$/)})],
        ['post','/extension/catalog/ai/suggestions','Aplicar decisão válida; respostas ambíguas ficam pendentes, sem publicação',reviewAiResult],
        ['post','/extension/catalog/ai/release','Liberar análise cancelada ou com falha',z.strictObject({requestId:z.uuid()})],
        ['get', '/extension/catalog/config', 'Configurações dos marketplaces autorizados'],
        ['get', '/extension/catalog/stats', 'Pendências por marketplace; preços sem verificação bem-sucedida nas últimas 24 horas'],
        ['get', '/extension/catalog/runs', 'Listar execuções próprias com paginação'],
        ['post', '/extension/catalog/runs', 'Iniciar etapa manual, idempotente por requestKey', startCatalogInput],
        ['get', '/extension/catalog/runs/{id}', 'Consultar execução e snapshot'],
        ['get', '/extension/catalog/runs/{id}/items', 'Consultar itens sem segredos'],
        ['post', '/extension/catalog/runs/{id}/claim', 'Reservar um item por até três minutos', z.strictObject({})],
        ['post', '/extension/catalog/runs/{id}/heartbeat', 'Renovar reserva durante extração', z.strictObject({
                itemId: z.uuid(), leaseToken: z.uuid()
            })],
        ['post', '/extension/catalog/runs/{id}/results', 'Salvar resultado sem dados de sessão', catalogResultInput],
        ['post', '/extension/catalog/runs/{id}/action', 'Pausar, retomar ou cancelar execução', actionInput],
        ['post', '/admin/extension-catalog/sources/{id}/resume', 'Retomar fonte pausada sem iniciar extração', z.strictObject({})],
        ['get', '/admin/extension-catalog/settings/{id}', 'Consultar configuração da extensão'],
        ['put', '/admin/extension-catalog/settings/{id}', 'Configurar receita, bloqueios e executor', z.strictObject({
                version: z.number().int(), executor: z.literal('extension'), config: catalogSettings
            })],
        ['get', '/admin/extension-catalog/runs', 'Acompanhar execuções da extensão'],
        ['get', '/admin/extension-catalog/runs/{id}/items', 'Consultar itens da execução'],
        ['post', '/admin/extension-catalog/runs/{id}/cancel', 'Cancelar execução sem aceitar resultados tardios', z.strictObject({})],
        ['get', '/admin/extension-catalog/manual/{id}', 'Acompanhar prévia manual solicitada no admin'],
        ['post', '/admin/extension-catalog/manual/{id}/finalize', 'Criar prévia após extração com XSRF', z.strictObject({})],
        ['post', '/admin/extension-catalog/manual/{id}/cancel', 'Cancelar solicitação de prévia', z.strictObject({})],
        ['post','/admin/discovery/enrichment/review/publish-batch','Publicar até 100 links selecionados com confirmação explícita e validação individual',publishBatchInput],
        ['post', '/admin/discovery/enrichment/review/{id}/publish', 'Publicar candidato após confirmação de categoria e produto', z.strictObject({
                version: z.number().int().nonnegative(), authorizedContent: z.literal(true)
            })],
    ];
    for (const [method, path, summary, input] of definitions) {
        const extension = path.startsWith('/extension/');
        const parameters: any[] = [];
        for (const match of path.matchAll(/\{(\w+)\}/g))
            parameters.push({
                name: match[1], in: 'path', required: true, schema: {
                    type: 'string'
                }
            });
        if (extension)
            parameters.push({
                name: 'X-Espertinho-Extension-Id', in: 'header', required: true, schema: {
                    type: 'string', pattern: '^[a-p]{32}$'
                }
            });
        if(path==='/extension/catalog/stats'||path==='/extension/catalog/ai/config'||path==='/extension/catalog/ai/queue')parameters.push(
            {name:'marketplaceId',in:'query',required:true,schema:{type:'string'}},
            {name:'retryFailed',in:'query',schema:{type:'string',enum:['true','false'],default:'false'}}
        );
        if(path==='/extension/catalog/ai/queue')parameters.push({name:'task',in:'query',required:true,schema:{type:'string',enum:['category','product']}},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:10000,default:100}});
        if(path==='/extension/catalog/ai/inventory')parameters.push(
            {name:'kind',in:'query',required:true,schema:{type:'string',enum:['categories','products','drafts']}},
            {name:'cursor',in:'query',schema:{type:'string',format:'uuid'}},
            {name:'revision',in:'query',schema:{type:'string',pattern:'^[0-9]+$'}},
            {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:500,default:250}}
        );
        let security: any = [{
                SessionCookie: [], XSRFToken: []
            }];
        if (method === 'get')
            security = [{
                    SessionCookie: []
                }];
        if (extension)
            security = [{
                    ExtensionBearer: []
                }];
        const operation: any = {
            operationId: 'catalog_' + method + '_' + path.replace(/[^a-zA-Z0-9]/g, '_'), summary, tags: ['Catálogo pela extensão'], security, parameters,
            description: 'Operação autenticada e validada no servidor. Cookies, headers de sessão do marketplace e scripts remotos não são aceitos. Reservas e snapshots impedem duplicação e sobrescrita de revisão.',
            responses: {
                '200': {
                    description: 'Resultado ou página de registros'
                }, '201': {
                    description: 'Execução criada'
                }, '202': {
                    description: 'Solicitação aguardando extensão'
                }, '400': {
                    description: 'Contrato inválido'
                }, '401': {
                    description: 'Sessão expirada'
                }, '403': {
                    description: 'Permissão ou origem inválida'
                }, '404': {
                    description: 'Recurso não encontrado'
                }, '409': {
                    description: 'Conflito de versão, estado ou reserva'
                }
            }
        };
        if (input)
            operation.requestBody = {
                required: true, content: {
                    'application/json': {
                        schema: z.toJSONSchema(input, {
                            target: 'openapi-3.0', io: 'input'
                        })
                    }
                }
            };
        paths[path] ??= {};
        paths[path][method] = operation;
    }
    return paths;
}
