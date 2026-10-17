import { createHash } from 'node:crypto';
import { HttpError, marketplaceURL } from './security.js';
export type ProviderId = 'amazon'|'mercadolivre';
export interface Candidate {
  externalId: string; title: string; description: string; imageUrl: string|null;
  productUrl: string; affiliateUrl: string|null; priceCents: number; originalPriceCents: number|null;
  conditions: string; expiresAt: Date;
}
export interface SearchInput { keywords: string; maxPriceCents?: number|null; minDiscount?: number; }
export type Transport = typeof fetch;
export const credentialFields: Record<ProviderId,{key:string;label:string;secret:boolean;required:boolean}[]> = {
  amazon: [{key:'clientId',label:'Credential ID',secret:false,required:true},{key:'clientSecret',label:'Credential Secret',secret:true,required:true},{key:'version',label:'Version (3.1 para Brasil)',secret:false,required:true},{key:'partnerTag',label:'ID de rastreamento / PartnerTag',secret:false,required:true}],
  mercadolivre: [{key:'clientId',label:'Client ID (API geral)',secret:false,required:true},{key:'clientSecret',label:'Client Secret',secret:true,required:true}]
};
export class ProviderService {
  private tokens=new Map<string,{token:string;until:number}>();
  constructor(private transport: Transport=fetch) {}
  private async json(url: string, options: RequestInit) {
    let res: Response;
    try { res=await this.transport(url,{...options,signal:AbortSignal.timeout(20000),redirect:'error'}); }
    catch { throw new HttpError(502,'Não foi possível acessar o marketplace. Tente novamente mais tarde.'); }
    const data=await res.json().catch(()=>null);
    // Never return provider response bodies: they can echo credentials or tokens.
    if (!res.ok) throw new HttpError(502,`Marketplace respondeu HTTP ${res.status}. Confira permissões, credenciais e limites da conta.`);
    if (!data || data.errors?.length) throw new HttpError(502,'A API não aceitou a consulta. Confira acesso e compatibilidade no portal oficial.');
    return data;
  }
  private async amazon(c: Record<string,string>, operation: string, input: object) {
    if(c.version!=='3.1') throw new HttpError(400,'Esta integração Brasil utiliza credenciais Creators API versão 3.1.');
    const cacheKey=createHash('sha256').update(c.clientId+c.clientSecret).digest('hex');
    let cached=this.tokens.get(cacheKey);
    if (!cached || cached.until<Date.now()) {
      const auth=await this.json('https://api.amazon.com/auth/o2/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret,scope:'creatorsapi::default'})});
      if(typeof auth.access_token!=='string') throw new HttpError(502,'A Amazon não retornou um token válido.');
      cached={token:auth.access_token,until:Date.now()+Math.max(30,Number(auth.expires_in || 3600)-120)*1000}; this.tokens.set(cacheKey,cached);
    }
    return this.json(`https://creatorsapi.amazon/catalog/v1/${operation}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${cached.token}`,'x-marketplace':'www.amazon.com.br'},body:JSON.stringify({marketplace:'www.amazon.com.br',partnerTag:c.partnerTag,...input})});
  }
  private storeMeliTokens(c: Record<string,string>,auth: any) {
    if(typeof auth.access_token!=='string'||!auth.access_token||typeof auth.refresh_token!=='string'||!auth.refresh_token) throw new HttpError(502,'O Mercado Livre não retornou os tokens necessários. Autorize novamente com Refresh Token habilitado.');
    c.accessToken=auth.access_token;c.refreshToken=auth.refresh_token;
    const seconds=Number(auth.expires_in);
    c.accessTokenExpiresAt=String(Date.now()+(Number.isFinite(seconds)&&seconds>0?seconds:0)*1000);
  }
  async authorizeMeli(c: Record<string,string>,code: string,redirectUri: string,verifier='') {
    const body=new URLSearchParams({grant_type:'authorization_code',client_id:c.clientId,client_secret:c.clientSecret,code,redirect_uri:redirectUri});
    if(verifier)body.set('code_verifier',verifier);
    const auth=await this.json('https://api.mercadolibre.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    this.storeMeliTokens(c,auth);
  }
  private async meliToken(c: Record<string,string>) {
    if(c.accessToken && Number(c.accessTokenExpiresAt)>Date.now()+60000)return c.accessToken;
    if(!c.refreshToken)throw new HttpError(409,'Conecte sua conta do Mercado Livre antes de testar ou consultar produtos.');
    const auth=await this.json('https://api.mercadolibre.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:c.clientId,client_secret:c.clientSecret,refresh_token:c.refreshToken})});
    this.storeMeliTokens(c,auth);
    return auth.access_token as string;
  }
  private amazonCandidate(item: any): Candidate|null {
    const price=item.offersV2?.listings?.[0]?.price;
    const amount=price?.money?.amount ?? price?.amount;
    if (!Number.isFinite(Number(amount)) || Number(amount)<=0 || !item.detailPageURL || !item.itemInfo?.title?.displayValue) return null;
    const saving=price?.savings?.money?.amount ?? price?.savings?.amount;
    const basis=item.offersV2?.listings?.[0]?.savingBasis?.money?.amount;
    return {externalId:item.asin,title:item.itemInfo.title.displayValue,description:'',imageUrl:item.images?.primary?.medium?.url??null,
      productUrl:marketplaceURL(item.detailPageURL,'amazon'),affiliateUrl:marketplaceURL(item.detailPageURL,'amazon'),priceCents:Math.round(Number(amount)*100),
      originalPriceCents:basis ? Math.round(Number(basis)*100) : saving ? Math.round((Number(amount)+Number(saving))*100):null,
      conditions:'Preço e disponibilidade sujeitos a alteração. Confira as condições na Amazon.',expiresAt:new Date(Date.now()+3600000)};
  }
  async search(id: ProviderId,c: Record<string,string>,input: SearchInput): Promise<Candidate[]> {
    for(const f of credentialFields[id]) if(f.required && !c[f.key]) throw new HttpError(400,`Configure ${f.label}.`);
    if(id==='mercadolivre') throw new HttpError(409,'A API geral do Mercado Livre não gera links de afiliado. A descoberta automática exige uma integração de parceiros oficialmente autorizada. Cadastre ofertas com links oficiais pela revisão manual.');
    let candidates: Candidate[]=[];
    if(id==='amazon') {
      const data=await this.amazon(c,'searchItems',{keywords:input.keywords,itemCount:10,...(input.maxPriceCents?{maxPrice:input.maxPriceCents}:{}),...(input.minDiscount?{minSavingPercent:input.minDiscount}:{}),resources:['images.primary.medium','itemInfo.title','offersV2.listings.price']});
      candidates=(data.searchResult?.items??[]).map((v:any)=>this.amazonCandidate(v)).filter(Boolean);
    }
    return candidates.filter(c=>(!input.maxPriceCents || c.priceCents<=input.maxPriceCents) && (!input.minDiscount || !!c.originalPriceCents && (1-c.priceCents/c.originalPriceCents)*100>=input.minDiscount));
  }
  async refresh(id: ProviderId,c: Record<string,string>,externalId: string): Promise<Candidate|null> {
    if(id==='amazon') {
      const data=await this.amazon(c,'getItems',{itemIds:[externalId],resources:['images.primary.medium','itemInfo.title','offersV2.listings.price']});
      const item=(data.itemsResult?.items??data.itemResults?.items??[]).find((i:any)=>i.asin===externalId);
      return item?this.amazonCandidate(item):null;
    }
    const token=await this.meliToken(c);
    const data=await this.json(`https://api.mercadolibre.com/items/${encodeURIComponent(externalId)}`,{headers:{Authorization:`Bearer ${token}`}});
    if(data.status!=='active' || data.currency_id!=='BRL' || !data.price) return null;
    return {externalId:data.id,title:data.title,description:'',imageUrl:data.pictures?.[0]?.secure_url??null,productUrl:marketplaceURL(data.permalink,'mercadolivre'),affiliateUrl:null,priceCents:Math.round(data.price*100),originalPriceCents:data.original_price?Math.round(data.original_price*100):null,conditions:'Confira condições, frete e vendedor no Mercado Livre.',expiresAt:new Date(Date.now()+3600000)};
  }
  async check(id: ProviderId,c: Record<string,string>) {
    if(id==='mercadolivre') {const token=await this.meliToken(c);await this.json('https://api.mercadolibre.com/users/me',{headers:{Authorization:`Bearer ${token}`}});return 'catalog_only';}
    await this.search(id,c,{keywords:'livro'});
    return 'connected';
  }
}
