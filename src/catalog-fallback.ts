import { canonical, type IdentityPolicy } from './catalog-identity.js';

// One reusable, marketplace-independent identity when the provider cannot classify a type.
export const titlePolicy = {
  name: 'Identidade por título', terms: ['produto'],
  attributes: [{ key: 'title', label: 'Título', required: true, aliases: [], unit: 'text' as const, values: {} }],
  exclusive: false, categoryId: null, priority: 0,
};
export function fallbackTitle(link: any) {
  const title = String(link.enrichment_data?.title ?? link.name ?? '').trim();
  if (title) return title.slice(0, 300);
  try {
    const path = decodeURIComponent(new URL(link.url).pathname).split('/').filter(Boolean);
    const slug = path.sort((a, b) => b.length - a.length)[0]?.replaceAll(/[-_]+/g, ' ').trim();
    if (slug && /\p{L}/u.test(slug)) return slug.slice(0, 300);
  } catch { /* A missing title must not turn a link into an invalid business decision. */ }
  return 'Produto da oferta';
}
export function fallbackIdentity(policy: IdentityPolicy, title: string) {
  return { policyId: policy.id, facts: {}, name: title, reason: 'Identificação pelos dados disponíveis da oferta.' };
}
function overlap(a: string, b: string) {
  const x = new Set(canonical(a).split(' ').filter(w => w.length > 1));
  const y = new Set(canonical(b).split(' ').filter(w => w.length > 1));
  if (!x.size || !y.size) return 0;
  const numbers = (s: Set<string>) => [...s].filter(w => /\d/.test(w)).sort().join('|');
  if (numbers(x) !== numbers(y)) return 0;
  return [...x].filter(w => y.has(w)).length / new Set([...x, ...y]).size;
}
export function fallbackMatch(context: any) {
  const title = context.identity?.name ?? context.offer.title;
  const candidates = [...(context.candidates ?? [])]
    .map(p => ({ ...p, score: overlap(title, p.title) }))
    .filter(p => p.score >= 0.85)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { productId: candidates[0]?.id ?? null, reason: 'Comparação dos títulos; criar quando não houver equivalente.' };
}
export function fallbackCategory(context: any) {
  const categories = context.categories ?? [];
  const mapped = categories.find((n: any) => n.id === (context.mappedCategoryId ?? context.defaultCategoryId));
  if (mapped) return { categoryId: mapped.id, path: [], reason: 'Categoria já configurada ou mapeada.' };
  const source = String(context.offer.sourceCategory ?? '').split('>').map(p => p.trim().slice(0, 80)).filter(Boolean).slice(0, 10);
  const path = source.length ? source : [context.policy?.name === titlePolicy.name ? 'Outros' : (context.policy?.name ?? 'Outros').slice(0, 80)];
  const key = (p: string[]) => p.map(canonical).join('>');
  const existing = categories.find((n: any) => key(n.path) === key(path));
  return { categoryId: existing?.id ?? null, path: existing ? [] : path, reason: 'Árvore de origem ou tipo disponível; reutilizar árvore equivalente.' };
}
