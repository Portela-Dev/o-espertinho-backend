import { z } from 'zod';
import { HttpError } from './security.js';

export const catalogStep = z.enum(['discover','convert','enrich','prices','preview','selector_test']);
export type CatalogStep = z.infer<typeof catalogStep>;
export type CatalogActor = { id:string; extension_session_id:string; extension_id?:string; permissions:string[] };
export const stepPermission:Record<CatalogStep,string> = {discover:'discovery',convert:'affiliate_links',enrich:'catalog',prices:'updates',preview:'catalog',selector_test:'selectors'};
export function allowStep(actor:CatalogActor, step:CatalogStep) {
  if (!actor.permissions.includes('affiliate_links') || !actor.permissions.includes(stepPermission[step])) {
    throw new HttpError(403, 'Seu perfil não tem permissão para esta etapa.');
  }
}
export const startCatalogInput = z.strictObject({
  marketplaceId:z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/), step:catalogStep,
  requestKey:z.uuid(), limit:z.number().int().min(1).max(10000).default(100), retryFailed:z.boolean().default(false),
});
export const actionInput = z.strictObject({action:z.enum(['pause','resume','cancel','human','technical']),reason:z.enum(['','login','challenge','access_denied','rate_limit','incomplete','network','tab_closed','permission','intervention_expired']).default('')});
export const uuid = z.uuid();
