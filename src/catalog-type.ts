import { z } from 'zod';
import type { Database } from './db.js';
import { HttpError } from './security.js';
import { canonical, digest, policyInput, sourceData, validateIdentity, type IdentityPolicy } from './catalog-identity.js';

const fact = z.strictObject({ value: z.string().min(1).max(160), evidence: z.string().min(1).max(300) });
export const identityDecision = z.strictObject({
  policyId: z.string(), facts: z.record(z.string(), fact),
  name: z.string().trim().min(1).max(300).optional(),
  reason: z.string().max(240),
  // Accept older clients without granting them a business rejection action.
  exclude: z.boolean().optional(),
});
const typeDecision = z.strictObject({
  policyId: z.string().nullable(), policy: policyInput.nullable(),
  facts: z.record(z.string(), fact), name: z.string().trim().min(1).max(300).optional(),
  reason: z.string().max(240),
});
export function catalogOffer(row: any) {
  const data = sourceData(row);
  return { ...data, description: data.description.slice(0, 1800),
    specifications: data.specifications.slice(0, 32).map((s: any) => ({ ...s, value: s.value.slice(0, 200) })) };
}
export function catalogIdentity(raw: unknown, offer: ReturnType<typeof sourceData>, policy: IdentityPolicy, linkId: string) {
  const v = identityDecision.parse(raw);
  const identity = validateIdentity({ policyId: v.policyId, facts: v.facts, exclude: false, reason: v.reason }, offer, policy, linkId);
  const title = offer.title.trim().slice(0, 300);
  if (!title) throw new HttpError(400, 'A extração precisa fornecer o título do produto.');
  const titleCompact = canonical(title).replaceAll(' ', '');
  const name = v.name && canonical(v.name).split(' ').every(word => titleCompact.includes(word)) ? v.name : title;
  return { ...identity, name, partial: !identity.fingerprint,
    fingerprint: identity.fingerprint ?? digest({ type: policy.id, version: policy.version, attrs: identity.attrs, title: canonical(name), exclusive: policy.exclusive ? linkId : '' }) };
}
export function titleProvesIdentity(identity: any, offer: ReturnType<typeof sourceData>) {
  const title = canonical(offer.title).replaceAll(' ', '');
  return !!identity?.fingerprint && Object.values(identity.facts).every((f: any) => title.includes(canonical(f.value).replaceAll(' ', '')));
}
export function policyChoices(policies: IdentityPolicy[], offer: ReturnType<typeof sourceData>) {
  const words = new Set(canonical(offer.title).split(' '));
  const score = (p: IdentityPolicy) => canonical(p.name + ' ' + p.terms.join(' ')).split(' ').filter(w => words.has(w)).length;
  return [...policies].sort((a,b) => score(b)-score(a) || a.id.localeCompare(b.id)).slice(0, 30);
}
async function choosePolicy(c: Pick<Database,'query'>, context: any, id: string, proposed: unknown) {
  const chosen = context.policies.find((p: IdentityPolicy) => p.id === id);
  if (!chosen || proposed) throw new HttpError(400, 'Escolha somente uma política oferecida no contexto.');
  const row = (await c.query('SELECT * FROM catalog_identity_policies WHERE id=$1 AND enabled FOR SHARE', [id])).rows[0];
  if (!row || row.version !== chosen.version) throw new HttpError(409, 'Política alterada durante a identificação do tipo.');
  return { ...row.definition, id: row.id, version: row.version } as IdentityPolicy;
}
async function createPolicy(c: Pick<Database,'query'>, proposed: z.infer<typeof policyInput> | null, mode: string) {
  if (!proposed || proposed.categoryId || proposed.attributes.length > 8)
    throw new HttpError(400, 'A nova política precisa ser limitada a oito atributos e sem categoria fixa.');
  const existing = (await c.query('SELECT * FROM catalog_identity_policies WHERE enabled ORDER BY id')).rows
    .find(p => canonical(p.definition.name) === canonical(proposed.name));
  if (existing) return { ...existing.definition, id: existing.id, version: existing.version } as IdentityPolicy;
  const definition = { ...proposed, categoryId: null, priority: 0 };
  const id = 'ai-' + digest(canonical(definition.name)).slice(0,24);
  if (mode === 'shadow') return { ...definition, id, version: 1 };
  await c.query('INSERT INTO catalog_identity_policies(id,definition) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id, JSON.stringify(definition)]);
  const row = (await c.query('SELECT * FROM catalog_identity_policies WHERE id=$1 AND enabled FOR SHARE', [id])).rows[0];
  if (!row) throw new HttpError(409, 'A política deste tipo foi desativada no admin.');
  return { ...row.definition, id, version: row.version } as IdentityPolicy;
}
export async function inferCatalogPolicy(c: Pick<Database, 'query'>, context: any, raw: unknown, mode: string) {
  const v = typeDecision.parse(raw);
  const policy = v.policyId ? await choosePolicy(c,context,v.policyId,v.policy) : await createPolicy(c,v.policy,mode);
  const facts = Object.fromEntries(Object.entries(v.facts).filter(([key]) => policy.attributes.some(a => a.key === key)));
  return { policy, decision: { policyId: policy.id, facts, name: v.name, reason: v.reason }, ephemeralPolicy: mode === 'shadow' && !context.policies.some((p: IdentityPolicy) => p.id === policy.id) };
}
