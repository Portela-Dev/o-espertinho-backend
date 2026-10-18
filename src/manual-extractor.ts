import { z } from 'zod';
import { scrapedDataSchema } from './extraction-data.js';
import { HttpError } from './security.js';
import { marketUrl, type OfferExtractor, type ScrapedData, type ScrapingMarket, type ScrapingProfile } from './scraping.js';
import { manualProfile } from './manual-extractor-profile.js';
import { linkIdentity } from './link-identity.js';

const coreData = scrapedDataSchema.extend({
  category: z.string().max(300), externalId: z.string().max(300),
  brand: z.string().max(300), availability: z.enum(['available', 'unavailable', 'unknown']),
});
const resultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), data: coreData }),
  z.object({ status: z.literal('unavailable'), data: coreData }),
  z.object({ status: z.literal('technical_failure'), reason: z.enum(['invalid_configuration', 'unsafe_url', 'blocked', 'http_error', 'timeout', 'incomplete', 'browser_error']), data: coreData.optional(), httpStatus: z.number().int().min(100).max(599).optional() }),
]);
function responseError(status: number): never {
  if (status === 401 || status === 403) { throw new HttpError(502, 'O extrator manual recusou a autenticação. Confira MANUAL_EXTRACTION_SERVICE_TOKEN.'); }
  if (status === 429) { throw new HttpError(429, 'O extrator manual está ocupado. Aguarde e tente novamente.'); }
  if (status === 503) { throw new HttpError(503, 'O extrator manual não está pronto. Confira o container.'); }
  if (status === 400 || status === 413 || status === 415) { throw new HttpError(400, 'O extrator manual recusou a configuração. Confira os seletores e o tamanho do perfil.'); }
  throw new HttpError(502, 'Não foi possível consultar o extrator manual. Confira o container.');
}
function technicalError(reason: string): never {
  if (reason === 'timeout') { throw new HttpError(504, 'A extração manual excedeu o tempo limite. Tente novamente.'); }
  if (reason === 'unsafe_url' || reason === 'invalid_configuration') { throw new HttpError(400, 'O extrator recusou o endereço ou a configuração. Confira os domínios e seletores.'); }
  if (reason === 'blocked' || reason === 'http_error') { throw new HttpError(422, 'A página não pôde ser consultada. O marketplace pode exigir login, limitar acesso ou estar indisponível.'); }
  throw new HttpError(502, 'Falha técnica no navegador do extrator manual. Confira o container e tente novamente.');
}
function adapt(result: z.infer<typeof resultSchema>, market: ScrapingMarket, affiliateUrl: string): ScrapedData {
  if (result.status === 'technical_failure' && result.reason !== 'incomplete') { technicalError(result.reason); }
  const data = result.data;
  if (!data) { throw new HttpError(502, 'O extrator manual retornou dados inválidos.'); }
  marketUrl(data.productUrl, market.allowed_hosts);
  if (result.status === 'available' && (data.availability !== 'available' || !data.title.trim() || data.priceCents === null || data.missing.length)) {
    throw new HttpError(502, 'O extrator manual retornou disponibilidade inconsistente.');
  }
  const unavailable = result.status === 'unavailable';
  if ((unavailable && data.availability !== 'unavailable') || (result.status === 'technical_failure' && !data.missing.length)) {
    throw new HttpError(502, 'O extrator manual retornou disponibilidade inconsistente.');
  }
  const missing = unavailable ? [...new Set([...data.missing, 'price'])] : data.missing;
  const externalId = linkIdentity(market.id, affiliateUrl);
  return { ...data, externalId, category: data.category.slice(0, 80),
    conditions: data.conditions || 'Confira vendedor, condição do produto, frete, cupom e forma de pagamento na loja. Preço e disponibilidade sujeitos a alteração.',
    priceCents: unavailable ? null : data.priceCents, missing };
}
export class ManualOfferExtractor implements OfferExtractor {
  private readonly endpoint: string;
  constructor(url: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {
    const base = new URL(url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new Error('MANUAL_EXTRACTOR_URL deve ser uma origem HTTP(S), sem caminho ou credenciais.');
    }
    if (!/^[\w-]{32,256}$/.test(token)) { throw new Error('Configure MANUAL_EXTRACTION_SERVICE_TOKEN para usar o extrator manual.'); }
    this.endpoint = new URL('/v1/extractions', base).href;
  }
  async extract(url: string, market: ScrapingMarket, profile: ScrapingProfile): Promise<ScrapedData> {
    marketUrl(url, market.allowed_hosts);
    const payload = { url, profile: manualProfile(market, profile) };
    try {
      const response = await this.transport(this.endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + this.token },
        body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(115000) });
      if (!response.ok) { responseError(response.status); }
      const parsed = resultSchema.safeParse(await response.json());
      if (!parsed.success) { throw new HttpError(502, 'O extrator manual retornou dados inválidos.'); }
      return adapt(parsed.data, market, url);
    } catch (error) {
      if (error instanceof HttpError) { throw error; }
      throw new HttpError(502, 'Não foi possível consultar o extrator manual. Confira o container, a URL e a conexão.');
    }
  }
}
