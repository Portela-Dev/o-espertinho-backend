import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './security.js';
export const canonical = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const attribute = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(80),
  required: z.boolean(),
  aliases: z.array(z.string().min(1).max(80)).max(20),
  unit: z.enum(['text', 'gb', 'inch', 'number']).default('text'),
  values: z.record(z.string().max(80), z.string().max(80)).default({}),
});
export const policyInput = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    terms: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
    attributes: z.array(attribute).min(1).max(16),
    categoryId: z.uuid().nullable().default(null),
    exclusive: z.boolean().default(false),
    priority: z.number().int().min(0).max(100).default(0),
  })
  .superRefine((v, c) => {
    if (!v.attributes.some((a) => a.required))
      c.addIssue({
        code: 'custom',
        message: 'Defina ao menos um atributo obrigatório.',
      });
    if (new Set(v.attributes.map((a) => a.key)).size !== v.attributes.length)
      c.addIssue({ code: 'custom', message: 'Atributos repetidos.' });
  });
export type IdentityPolicy = z.infer<typeof policyInput> & {
  id: string;
  version: number;
};
export const digest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function sourceData(row: any) {
  const d = row.enrichment_data ?? row;
  return {
    title: String(d.title ?? d.name ?? '').slice(0, 500),
    brand: String(d.brand ?? '').slice(0, 120),
    description: String(d.description ?? '').slice(0, 6000),
    specifications: (d.specifications ?? []).slice(0, 80).map((s: any) => ({
      name: String(s.name).slice(0, 100),
      value: String(s.value).slice(0, 500),
    })),
    selectedVariant: d.selectedVariant ?? null,
  };
}
export const sourceHash = (row: any) => digest(sourceData(row));
export function normalizeAttribute(value: string, unit: string) {
  const s = canonical(value);
  if (unit === 'text') return s;
  const normalized = value.trim().replaceAll(/\s+/gu, ' ').replace(',', '.');
  const match =
    /^(\d+(?:\.\d+)?) ?(tb|gb|mb|pol|polegadas|inches|inch|["”])?$/i.exec(
      normalized,
    );
  if (!match) return '';
  const suffix = match[2]?.toLowerCase();
  const allowed: Record<string, string[]> = {
    gb: ['gb', 'tb', 'mb'],
    inch: ['pol', 'polegadas', 'inches', 'inch', '"', '”'],
    number: [],
  };
  if (suffix && !allowed[unit]?.includes(suffix)) return '';
  let n = Number(match[1]);
  if (unit === 'gb' && match[2]?.toLowerCase() === 'tb') n *= 1024;
  if (unit === 'gb' && match[2]?.toLowerCase() === 'mb') n /= 1024;
  return n > 0 && Number.isFinite(n) ? String(n) : '';
}
export function selectPolicy(
  data: ReturnType<typeof sourceData>,
  policies: IdentityPolicy[],
) {
  const title = ' ' + canonical(data.title) + ' ';
  const matches = policies.filter((p) =>
    p.terms.some((t) => title.includes(' ' + canonical(t) + ' ')),
  );
  // A specific kit rule wins only when explicitly configured as exclusive.
  const highest = Math.max(...matches.map((p) => p.priority));
  const best = matches.filter((p) => p.priority === highest);
  return best.length === 1 ? best[0] : null;
}
export function deterministicIdentity(
  data: ReturnType<typeof sourceData>,
  policy: IdentityPolicy,
) {
  const facts: Record<string, { value: string; evidence: string }> = {};
  for (const a of policy.attributes) {
    const aliases = new Set([a.key, a.label, ...a.aliases].map(canonical));
    const values = data.specifications.filter((s: any) =>
      aliases.has(canonical(s.name)),
    );
    if (a.key === 'brand' && data.brand)
      values.push({ name: 'brand', value: data.brand });
    const normalized = values.map((s: any) =>
      normalizeAttribute(s.value, a.unit),
    );
    if (
      normalized.length &&
      normalized.every((s: string) => s && s === normalized[0])
    )
      facts[a.key] = { value: values[0].value, evidence: values[0].value };
  }
  return validateIdentity(
    { policyId: policy.id, facts, exclude: false, reason: '' },
    data,
    policy,
    '',
  );
}
export function validateIdentity(
  input: any,
  data: ReturnType<typeof sourceData>,
  policy: IdentityPolicy,
  exclusiveKey: string,
) {
  const parsed = z
    .strictObject({
      policyId: z.string(),
      facts: z.record(
        z.string(),
        z.strictObject({
          value: z.string().min(1).max(160),
          evidence: z.string().min(1).max(300),
        }),
      ),
      exclude: z.boolean(),
      reason: z.string().max(240),
    })
    .parse(input);
  if (parsed.policyId !== policy.id)
    throw new HttpError(400, 'Tipo fora do contexto.');
  const evidence = [
    data.title,
    data.brand,
    data.description,
    ...data.specifications.map((s: any) => s.value),
  ].map(canonical);
  const attrs: Record<string, string> = {};
  for (const [key, fact] of Object.entries(parsed.facts)) {
    const a = policy.attributes.find((a) => a.key === key);
    if (
      !a ||
      !evidence.some((s) => s.includes(canonical(fact.evidence))) ||
      !canonical(fact.evidence).includes(canonical(fact.value))
    )
      throw new HttpError(400, 'Atributo sem evidência na fonte.');
    const value = normalizeAttribute(fact.value, a.unit);
    if (!value) throw new HttpError(400, 'Unidade inválida.');
    attrs[key] =
      Object.entries(a.values ?? {}).find(
        ([alias]) => canonical(alias) === value,
      )?.[1] ?? value;
    attrs[key] =
      a.unit === 'text'
        ? canonical(attrs[key])
        : normalizeAttribute(attrs[key], a.unit);
  }
  const missing = policy.attributes
    .filter((a) => a.required && !attrs[a.key])
    .map((a) => a.key);
  const fingerprint =
    !parsed.exclude && !missing.length
      ? digest({
          type: policy.id,
          version: policy.version,
          attrs: Object.fromEntries(
            Object.entries(attrs)
              .filter(
                ([key]) =>
                  policy.attributes.find((a) => a.key === key)?.required,
              )
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
          exclusive: policy.exclusive ? exclusiveKey : '',
        })
      : null;
  return {
    policyId: policy.id,
    attrs,
    facts: parsed.facts,
    missing,
    fingerprint,
    reason: parsed.reason,
    exclude: parsed.exclude,
  };
}
export const defaultPolicies = [
  {
    id: 'smartphone',
    name: 'Smartphones',
    terms: ['smartphone', 'celular', 'iphone'],
    attributes: [
      {
        key: 'brand',
        label: 'Marca',
        required: true,
        aliases: ['fabricante'],
        unit: 'text',
      },
      {
        key: 'model',
        label: 'Modelo',
        required: true,
        aliases: ['modelo do produto'],
        unit: 'text',
      },
      {
        key: 'storage',
        label: 'Armazenamento',
        required: true,
        aliases: ['capacidade de armazenamento', 'memória interna'],
        unit: 'gb',
      },
      {
        key: 'ram',
        label: 'RAM física',
        required: true,
        aliases: ['memória ram', 'ram'],
        unit: 'gb',
      },
    ],
  },
  {
    id: 'kit',
    name: 'Kits personalizados',
    priority: 100,
    terms: ['kit', 'combo'],
    exclusive: true,
    attributes: [
      {
        key: 'composition',
        label: 'Composição e quantidade selecionada',
        required: true,
        aliases: ['conteúdo da embalagem'],
        unit: 'text',
      },
    ],
  },
  {
    id: 'accessory',
    name: 'Acessórios e peças',
    priority: 20,
    terms: ['capa', 'película', 'tampa traseira'],
    attributes: [
      {
        key: 'brand',
        label: 'Marca',
        required: true,
        aliases: ['fabricante'],
        unit: 'text',
      },
      {
        key: 'model',
        label: 'Modelo da peça',
        required: true,
        aliases: ['modelo'],
        unit: 'text',
      },
      {
        key: 'compatibility',
        label: 'Compatibilidade',
        required: true,
        aliases: ['modelo compatível'],
        unit: 'text',
      },
    ],
  },
].map(({ id, ...definition }) => ({
  id,
  version: 1,
  ...policyInput.parse(definition),
}));
