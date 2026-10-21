import type { Router } from 'express';
import type { Database } from './db.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hash, HttpError } from './security.js';
import { marketUrl, validHost } from './scraping.js';
import { scrapedDataSchema } from './extraction-data.js';
import { normalizeProductUrl } from './url-normalization.js';
import { categoryKey } from './enrichment-admin.js';
import { recordDailyPrice } from './price-history.js';
import { catalogTransaction, ownRun, runView, expireRuns } from './catalog-runs.js';
import {discoveryProgress} from './catalog-discovery-progress.js';
import type { CatalogActor } from './catalog-contracts.js';
const uuid = z.uuid();
const dataSchema = scrapedDataSchema.strict().extend({
    brand: z.string().max(120).default('')
});
export const catalogResultInput = z.strictObject({
    itemId: uuid, leaseToken: uuid, outcome: z.enum(['success', 'technical_failure', 'unavailable']),
    reason: z.enum(['incomplete', 'network', 'navigation', 'configuration', 'stale']).optional(),
    failureType: z.enum(['navigation', 'timeout', 'emptyPage', 'invalidItem', 'pagination', 'limit']).optional(),
    links: z.array(z.string().max(10000)).max(500).optional(), done: z.boolean().optional(),
    checkpoint: z.strictObject({
        url: z.string().max(4000), page: z.number().int().min(1).max(1000), seen: z.array(z.string().max(64)).max(1000), found: z.number().int().min(0).max(100000), noProgress: z.number().int().min(0).max(20), advance: z.boolean().optional(),
        scroll:z.strictObject({position:z.number().min(0).max(1e9),height:z.number().min(0).max(1e9),viewport:z.number().min(0).max(1e9)}).optional()
    }).optional(),
    affiliateUrl: z.string().max(10000).optional(), data: dataSchema.optional(),
    sourceCategoryPath: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
});
export type ResultValue = z.infer<typeof catalogResultInput>;
type Queryable = Pick<Database, 'query'>;
interface ResultContext {
    c: Queryable;
    run: any;
    item: any;
    market: any;
    v: ResultValue;
}
async function discoverResult({ c, run, item, market, v }: ResultContext) {
    if (!v.links || v.done === undefined || v.outcome !== 'success' || v.affiliateUrl || v.data)
        throw new HttpError(400, 'Resultado de descoberta inválido.');
    const source = (await c.query('SELECT * FROM discovery_sources WHERE id=$1 FOR SHARE', [item.target_id])).rows[0];
    if (!source?.enabled || source.version.toString() !== item.expected_version)
        throw new HttpError(409, 'A fonte foi alterada.');
    const config = item.payload.config, previous = item.payload.checkpoint, page = v.checkpoint?.page ?? 1;
    if (page !== ((previous?.page ?? 0) + 1) || page > config.limits.maxPages)
        throw new HttpError(400, 'Página fora dos limites.');
    if (!v.done && !v.checkpoint)
        throw new HttpError(400, 'Checkpoint necessário.');
    if (v.checkpoint) {
        marketUrl(v.checkpoint.url, market.allowed_hosts);
        if (v.checkpoint.found > config.limits.maxItems)
            throw new HttpError(400, 'Limite de itens excedido.');
    }
    await discoveryProgress(c,item,market,v);
    await persistDiscoveredLinks(c, market, source.id, v.links!);
    await c.query("UPDATE extension_catalog_items SET payload=jsonb_set(payload,'{checkpoint}',$2::jsonb) WHERE id=$1", [item.id, JSON.stringify(v.checkpoint)]);
    if (v.done)
        return 'completed';
    return 'pending';
}
async function persistDiscoveredLinks(c: Queryable, market: any, sourceId: string, links: string[]) {
    for (const raw of new Set(links)) {
        const url = normalizeProductUrl(marketUrl(raw, market.allowed_hosts), market.url_normalization_rules ?? []);
        const found = (await c.query('INSERT INTO discovery_links(id,marketplace_id,url) VALUES($1,$2,$3) ON CONFLICT(marketplace_id,url) DO UPDATE SET last_seen_at=clock_timestamp() RETURNING id', [randomUUID(), market.id, url])).rows[0];
        await c.query('INSERT INTO discovery_link_sources(link_id,source_id) VALUES($1,$2) ON CONFLICT(link_id,source_id) DO UPDATE SET last_seen_at=clock_timestamp()', [found.id, sourceId]);
    }
}
async function convertResult({ c, run, item, market, v }: ResultContext) {
    if (!v.affiliateUrl || v.data || v.links || v.outcome !== 'success')
        throw new HttpError(400, 'Resultado de conversão inválido.');
    marketUrl(v.affiliateUrl, market.allowed_hosts);
    if (!run.snapshot.settings.recipe.affiliateOrigins.includes(new URL(v.affiliateUrl).origin))
        throw new HttpError(400, 'Domínio de afiliado não autorizado.');
    const updated = await c.query("UPDATE discovery_links SET affiliate_url=$2,converted_at=clock_timestamp(),extraction_status='pending',extraction_error=NULL,enrichment_version=enrichment_version+1 WHERE id=$1 AND status='pending' AND enrichment_version::text=$3 AND published_offer_id IS NULL RETURNING id", [item.target_id, v.affiliateUrl, item.expected_version]);
    if (!updated.rows.length)
        throw new HttpError(409, 'O candidato foi alterado ou arquivado.');
    return 'completed';
}
function validateProductResult({ run, item, market, v }: ResultContext) {
    if (!v.data || v.affiliateUrl || v.links)
        throw new HttpError(400, 'Dados extraídos necessários.');
    const data = v.data;
    marketUrl(data.productUrl, market.allowed_hosts);
    for (const image of data.images) {
        const url = new URL(image);
        if (url.protocol !== 'https:' || url.username || url.password || !validHost(url.hostname))
            throw new HttpError(400, 'Imagem inválida.');
    }
    data.collectedAt = new Date(item.observed_at).toISOString();
    if (v.outcome === 'success' && (!data.title || data.priceCents === null || data.missing.length))
        throw new HttpError(400, 'Extração incompleta não confirma disponibilidade.');
    if (v.outcome === 'unavailable' && !run.snapshot.settings.blockRules.some((r: any) => r.kind === 'unavailable'))
        throw new HttpError(400, 'Configure evidência explícita de indisponibilidade.');
    if (v.outcome === 'unavailable') {
        data.priceCents = null;
        data.originalPriceCents = null;
        data.missing = data.missing.filter(field => field !== 'price');
    }
    return data;
}
async function enrichResult({ c, item, v }: ResultContext, data: z.infer<typeof dataSchema>) {
    const link = (await c.query('SELECT * FROM discovery_links WHERE id=$1 FOR UPDATE', [item.target_id])).rows[0];
    if (link?.status !== 'pending' || link.enrichment_version.toString() !== item.expected_version || link.published_offer_id)
        throw new HttpError(409, 'O candidato foi alterado.');
    data.productUrl = link.url;
    const path = v.sourceCategoryPath ?? [];
    if (link.confirmed_category_id && link.source_category_key !== categoryKey(path))
        throw new HttpError(409, 'A categoria de origem mudou; revise o item antes de substituir os dados.');
    const enriched = {...data, availability: v.outcome === 'unavailable' ? 'unavailable' : 'available'};
    await c.query("UPDATE discovery_links SET enrichment_data=$2,source_category_path=$3,source_category_key=$4,extraction_status='completed',extraction_error=NULL,extracted_at=$5,enrichment_version=enrichment_version+1 WHERE id=$1", [link.id, JSON.stringify(enriched), path, categoryKey(path), data.collectedAt]);
}
async function priceResult({ c, run, item, v }: ResultContext, data: z.infer<typeof dataSchema>) {
    const offer = (await c.query('SELECT * FROM offers WHERE id=$1 FOR UPDATE', [item.target_id])).rows[0];
    const fresh = offer && new Date(offer.updated_at).getTime() === new Date(item.expected_version).getTime() && new Date(offer.data_updated_at).getTime() <= new Date(item.observed_at).getTime();
    if (!fresh || offer.status !== 'published')
        throw new HttpError(409, 'A oferta foi alterada ou já possui observação mais recente.');
    const available = v.outcome === 'success', price = available ? data.priceCents : null;
    const expires=new Date(new Date(data.collectedAt).getTime()+run.snapshot.profile.validity_minutes*60000);
    await c.query("UPDATE offers SET price_cents=COALESCE($2,price_cents),original_price_cents=$3,availability_status=$4,refresh_status='updated',data_updated_at=$5,expires_at=CASE WHEN $4='available' THEN $6 ELSE expires_at END,rating=CASE WHEN $7 THEN $8 ELSE rating END,review_count=CASE WHEN $9 THEN $10 ELSE review_count END,last_refresh_attempt_at=clock_timestamp(),last_refresh_error=NULL,updated_at=clock_timestamp() WHERE id=$1", [offer.id, price, data.originalPriceCents, available ? 'available' : 'unavailable', data.collectedAt,expires,run.snapshot.profile.rules.some((r:any)=>r.field==='rating'),data.rating,run.snapshot.profile.rules.some((r:any)=>r.field==='reviewCount'),data.reviewCount]);
    await recordDailyPrice(c, offer.id, offer.product_id, price, data.collectedAt);
}
async function successfulResult(context: ResultContext) {
    if (context.run.step === 'discover')
        return discoverResult(context);
    if (context.run.step === 'convert')
        return convertResult(context);
    const data = validateProductResult(context);
    if (context.run.step === 'enrich')
        await enrichResult(context, data);
    if (context.run.step === 'prices')
        await priceResult(context, data);
    return 'completed';
}
async function failedResult({ c, run, item, v }: ResultContext) {
    if (run.step === 'discover') {
        let action = item.payload.config.failures?.[v.failureType ?? 'navigation']?.action;
        if (v.failureType === 'limit')
            action = item.payload.config.failures?.limitReached;
        if (action === 'pause_source')
            await c.query("UPDATE discovery_sources SET paused_at=clock_timestamp(),pause_reason=$2 WHERE id=$1 AND version::text=$3", [item.target_id, v.failureType ?? 'navigation', item.expected_version]);
    }
    if (run.step === 'enrich')
        await c.query("UPDATE discovery_links SET extraction_status='failed',extraction_error='Falha técnica; tente novamente pela extensão.' WHERE id=$1 AND status='pending' AND enrichment_version::text=$2", [item.target_id, item.expected_version]);
    if (run.step === 'prices')
        await c.query("UPDATE offers SET refresh_status='pending',last_refresh_attempt_at=clock_timestamp(),last_refresh_error='Atualização pendente' WHERE id=$1 AND status='published' AND updated_at=$2::timestamptz", [item.target_id, item.expected_version]);
    return 'failed';
}
async function leasedResult(c: Queryable, run: any, runId: string, v: ResultValue, digest: string) {
    if (!['running', 'completed'].includes(run.status))
        throw new HttpError(409, 'Execução pausada, cancelada ou expirada.');
    const item = (await c.query('SELECT * FROM extension_catalog_items WHERE id=$1 AND run_id=$2 FOR UPDATE', [v.itemId, runId])).rows[0];
    if (!item || item.lease_token !== v.leaseToken)
        throw new HttpError(409, 'Reserva inválida.');
    if (item.result_hash === digest)
        return {
            item, duplicate: true
        };
    if (run.status !== 'running' || item.status !== 'leased' || new Date(item.lease_until).getTime() < Date.now())
        throw new HttpError(409, 'Reserva expirada ou já utilizada.');
    return {
        item, duplicate: false
    };
}
export async function acceptCatalogResult(db: Database, actor: CatalogActor, runId: string, input: unknown) {
    const v = catalogResultInput.parse(input), digest = hash(JSON.stringify(v));
    return catalogTransaction(db, async (c) => {
        await expireRuns(c);
        const run = await ownRun(c, uuid.parse(runId), actor, true);
        const { item, duplicate } = await leasedResult(c, run, runId, v, digest);
        if (duplicate)
            return {
                accepted: true, duplicate: true
            };
        const market = (await c.query('SELECT id,name,website_url,logo_url,allowed_hosts,scraping_enabled,url_normalization_rules,catalog_executor,updated_at FROM marketplaces WHERE id=$1 FOR SHARE', [run.marketplace_id])).rows[0];
        if (market.catalog_executor !== 'extension' || !market.scraping_enabled)
            throw new HttpError(409, 'O executor foi desativado.');
        const context = {
            c, run, item, market, v
        };
        const status = v.outcome === 'technical_failure' ? await failedResult(context) : await successfulResult(context);
        await c.query('UPDATE extension_catalog_items SET status=$2,result_hash=$3,result=$4,error=$5,updated_at=clock_timestamp() WHERE id=$1', [item.id, status, digest, JSON.stringify(v), v.reason ?? '']);
        const pending = (await c.query("SELECT id FROM extension_catalog_items WHERE run_id=$1 AND status IN ('pending','leased') LIMIT 1", [runId])).rows.length;
        if (!pending)
            await c.query("UPDATE extension_catalog_runs SET status='completed',updated_at=clock_timestamp() WHERE id=$1", [runId]);
        return {
            accepted: true, run: await runView(c, runId)
        };
    });
}
export function registerCatalogResults(router: Router, db: Database, account: (req: any) => Promise<CatalogActor>) {
    router.post('/catalog/runs/:id/results', async (req, res) => res.json(await acceptCatalogResult(db, await account(req), uuid.parse(req.params.id), req.body)));
}
