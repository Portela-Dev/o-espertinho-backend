import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { catalogSettings } from './catalog-settings.js';
import { validateRecipe } from './catalog-recipe.js';
import { discoveryConfigSchema } from './discovery-config.js';
import {
  profileSchema,
  selectorRuleSchema,
  marketUrl,
  validHost,
} from './scraping.js';
import { publicHttpsUrlSchema } from './public-url.js';
import { urlNormalizationRulesSchema } from './url-normalization.js';
import { sharingChannelSchema } from './sharing.js';
import { accessPermissions } from './user-admin.js';

// Only these columns can be read or written. No user, credential, category or catalog data.
const definitions = {
  marketplaces: {
    key: 'id',
    columns: [
      'id',
      'name',
      'website_url',
      'logo_url',
      'allowed_hosts',
      'scraping_enabled',
      'url_normalization_rules',
      'catalog_executor',
    ],
    json: ['url_normalization_rules'],
  },
  scraping_profiles: {
    key: 'marketplace_id',
    columns: ['marketplace_id', 'rules', 'wait_timeout_ms', 'validity_minutes'],
    json: ['rules'],
  },
  discovery_profiles: {
    key: 'id',
    columns: ['id', 'marketplace_id', 'name', 'config'],
    json: ['config'],
  },
  discovery_sources: {
    key: 'id',
    columns: [
      'id',
      'marketplace_id',
      'profile_id',
      'name',
      'url',
      'enabled',
      'interval_hours',
      'notes',
    ],
    json: [],
  },
  extension_catalog_settings: {
    key: 'marketplace_id',
    columns: ['marketplace_id', 'config'],
    json: ['config'],
  },
  review_ai_settings: {
    key: 'id',
    columns: [
      'id',
      'category_enabled',
      'product_enabled',
      'category_prompt',
      'product_prompt',
    ],
    json: [],
  },
  offer_sharing_settings: {
    key: 'id',
    columns: ['id', 'enabled', 'channels'],
    json: ['channels'],
  },
  meta_pixel_settings: {
    key: 'id',
    columns: ['id', 'enabled', 'pixel_id'],
    json: [],
  },
  access_profiles: {
    key: 'id',
    columns: ['id', 'name', 'description', 'permissions', 'system'],
    json: [],
  },
} as const;
type Table = keyof typeof definitions;
const tables = Object.keys(definitions) as Table[];
const marketId = z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/);
const configurationSchema = z.strictObject({
  marketplaces: z.array(
    z.strictObject({
      id: marketId,
      name: z.string().min(2).max(80),
      website_url: publicHttpsUrlSchema,
      logo_url: publicHttpsUrlSchema.or(z.literal('')),
      allowed_hosts: z.array(z.string().refine(validHost)).min(1).max(20),
      scraping_enabled: z.boolean(),
      url_normalization_rules: urlNormalizationRulesSchema,
      catalog_executor: z.literal('extension'),
    }),
  ),
  scraping_profiles: z.array(
    z.strictObject({
      marketplace_id: marketId,
      rules: z.array(selectorRuleSchema.strict()),
      wait_timeout_ms: z.number().int(),
      validity_minutes: z.number().int(),
    }),
  ),
  discovery_profiles: z.array(
    z.strictObject({
      id: z.uuid(),
      marketplace_id: marketId,
      name: z.string().trim().min(1).max(120),
      config: discoveryConfigSchema,
    }),
  ),
  discovery_sources: z.array(
    z.strictObject({
      id: z.uuid(),
      marketplace_id: marketId,
      profile_id: z.uuid(),
      name: z.string().trim().min(1).max(120),
      url: publicHttpsUrlSchema,
      enabled: z.boolean(),
      interval_hours: z.number().int().min(1).max(168),
      notes: z.string().max(2000),
    }),
  ),
  extension_catalog_settings: z.array(
    z.strictObject({ marketplace_id: marketId, config: catalogSettings }),
  ),
  review_ai_settings: z
    .array(
      z.strictObject({
        id: z.literal(true),
        category_enabled: z.boolean(),
        product_enabled: z.boolean(),
        category_prompt: z.string().trim().min(1).max(10000),
        product_prompt: z.string().trim().min(1).max(10000),
      }),
    )
    .length(1),
  offer_sharing_settings: z
    .array(
      z.strictObject({
        id: z.literal(true),
        enabled: z.boolean(),
        channels: z.array(sharingChannelSchema).max(20),
      }),
    )
    .length(1),
  meta_pixel_settings: z.array(z.strictObject({
    id: z.literal(true), enabled: z.boolean(), pixel_id: z.string().regex(/^[0-9]{5,30}$/),
  })).max(1).default([]),
  access_profiles: z.array(
    z.strictObject({
      id: marketId,
      name: z.string().trim().min(1).max(80),
      description: z.string().max(400),
      permissions: z
        .array(
          z.string().refine((p) => accessPermissions.some((a) => a.id === p)),
        )
        .max(10),
      system: z.boolean(),
    }),
  ),
});
const seedSchema = z.strictObject({
  formatVersion: z.literal(1),
  id: z.string().regex(/^admin-config-[a-z0-9-]+$/),
  requiredMigration: z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/),
  baseline: configurationSchema,
  config: configurationSchema,
});
export const adminSeedFile = new URL(
  '../seeds/admin-config.json',
  import.meta.url,
);
export async function readAdminSeed() {
  return JSON.parse(await readFile(adminSeedFile, 'utf8'));
}
type Row = Record<string, unknown>;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const quote = (name: string) => '"' + name + '"';

const credentialKeys = new Set([
  'password',
  'secret',
  'authorization',
  'credentials',
  'credentialsencrypted',
  'cookie',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'clientsecret',
  'csrftoken',
  'xcsrftoken',
  'xsrftoken',
  'xxsrftoken',
]);
const queryCredentialKeys = new Set([
  'token',
  'password',
  'secret',
  'apikey',
  'accesstoken',
  'refreshtoken',
]);
const normalizedKey = (key: string) =>
  key.toLowerCase().replaceAll(/[_-]/g, '');
function rejectCredentialString(value: string) {
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value))
    throw new Error('JWT não permitido no seed.');
  if (!/^https?:\/\//.test(value)) return;
  const url = new URL(value);
  if (url.username || url.password)
    throw new Error('Credenciais em URL não permitidas no seed.');
  for (const [key, item] of url.searchParams) {
    if (
      queryCredentialKeys.has(normalizedKey(key)) &&
      !/^\{\{[a-zA-Z]\w*(?:\|urlencode)?\}\}$/.test(item)
    )
      throw new Error('Segredo fixo em URL não permitido no seed.');
  }
}
function rejectCredentials(value: unknown) {
  if (typeof value === 'string') return rejectCredentialString(value);
  if (Array.isArray(value)) return value.forEach(rejectCredentials);
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      credentialKeys.has(normalizedKey(key)) &&
      !(typeof item === 'string' && /^\{\{[a-zA-Z]\w*\}\}$/.test(item))
    )
      throw new Error('Credencial fixa não permitida no seed.');
    rejectCredentials(item);
  }
}
export function validateAdminSeed(input: unknown) {
  rejectCredentials(input);
  const seed = seedSchema.parse(input);
  for (const configuration of [seed.baseline, seed.config]) {
    validateConfiguration(configuration);
  }
  // Validation may supply runtime defaults; preserve the exact stored snapshot for comparisons.
  return input as z.input<typeof seedSchema>;
}

/** Explicit, transactional initialization; never called by startup, migrations or deploy. */
export async function applyAdminSeed(
  db: Database,
  input: unknown,
  { dryRun = false } = {},
) {
  const seed = validateAdminSeed(input),
    digest = createHash('sha256').update(canonical(seed)).digest('hex');
  const entity = seed.id + ':' + digest,
    c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(73914202)');
    if (
      !(
        await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [
          seed.requiredMigration,
        ])
      ).rows.length
    )
      throw new Error('Aplique todas as migrations antes do seed.');
    const recorded = (
      await c.query(
        "SELECT entity_id FROM audit_logs WHERE action='admin.seed.applied' AND entity_id LIKE $1",
        [seed.id + ':%'],
      )
    ).rows;
    if (recorded.length) {
      if (!recorded.some((r) => r.entity_id === entity))
        throw new Error(
          'Esse seed já foi aplicado com outro conteúdo; crie uma nova versão explícita.',
        );
      await c.query('ROLLBACK');
      return { status: 'already_applied' as const, counts: {} };
    }
    await c.query(
      'LOCK TABLE ' +
        tables.map(quote).join(',') +
        ' IN SHARE ROW EXCLUSIVE MODE',
    );
    for (const table of [
      'products',
      'offers',
      'discovery_links',
      'extension_catalog_runs',
    ])
      if ((await c.query('SELECT 1 FROM ' + table + ' LIMIT 1')).rows.length)
        throw new Error(
          'Seed de inicialização exige banco sem catálogo ou execuções: ' +
            table,
        );
    const changes = await seedChanges(c, seed);
    for (const change of changes) await writeSeedChange(c, change);
    const counts = Object.fromEntries(
      tables.map((table) => [
        table,
        changes.filter((change) => change.table === table).length,
      ]),
    );
    if (dryRun) {
      await c.query('ROLLBACK');
      return { status: 'preview' as const, counts };
    }
    await c.query(
      "INSERT INTO audit_logs(id,action,entity_id) VALUES($1,'admin.seed.applied',$2)",
      [randomUUID(), entity],
    );
    await c.query('COMMIT');
    return { status: 'applied' as const, counts };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

function validateConfiguration(
  configuration: z.output<typeof configurationSchema>,
) {
  for (const table of tables) {
    const keys = configuration[table].map((row) =>
      String((row as Row)[definitions[table].key]),
    );
    if (new Set(keys).size !== keys.length)
      throw new Error('Chaves repetidas no seed: ' + table);
  }
  const market = (id: string) => {
    const row = configuration.marketplaces.find((m) => m.id === id);
    if (!row) throw new Error('Marketplace ausente no seed.');
    return row;
  };
  for (const row of configuration.marketplaces)
    marketUrl(row.website_url, row.allowed_hosts);
  for (const row of configuration.scraping_profiles) {
    market(row.marketplace_id);
    profileSchema.parse({
      version: 1,
      rules: row.rules,
      waitTimeoutMs: row.wait_timeout_ms,
      validityMinutes: row.validity_minutes,
    });
  }

  validateDiscoveryConfiguration(configuration, market);
  for (const row of configuration.offer_sharing_settings)
    if (new Set(row.channels.map((c) => c.id)).size !== row.channels.length)
      throw new Error('Redes repetidas no seed.');
}
function validateDiscoveryConfiguration(
  configuration: z.output<typeof configurationSchema>,
  market: (
    id: string,
  ) => z.output<typeof configurationSchema>['marketplaces'][number],
) {
  for (const row of configuration.discovery_profiles) {
    const m = market(row.marketplace_id);
    if (row.config.pagination.urlTemplate)
      marketUrl(
        row.config.pagination.urlTemplate.replaceAll(
          '{page}',
          String(row.config.pagination.startPage),
        ),
        m.allowed_hosts,
      );
  }
  for (const row of configuration.discovery_sources) {
    marketUrl(row.url, market(row.marketplace_id).allowed_hosts);
    if (
      !configuration.discovery_profiles.some(
        (p) =>
          p.id === row.profile_id && p.marketplace_id === row.marketplace_id,
      )
    )
      throw new Error('Perfil de vitrine ausente ou de outro marketplace.');
  }
  for (const row of configuration.extension_catalog_settings) {
    const m = market(row.marketplace_id);
    if (row.config.recipe) validateRecipe(row.config.recipe, m);
  }
}

type SeedChange = { table: Table; row: Row; exists: boolean };
async function seedChanges(
  c: Pick<Database, 'query'>,
  seed: z.input<typeof seedSchema>,
) {
  const changes: SeedChange[] = [];
  for (const table of tables) {
    const definition = definitions[table],
      rows = (
        await c.query(
          'SELECT ' +
            definition.columns.map(quote).join(',') +
            ' FROM ' +
            quote(table),
        )
      ).rows as Row[];
    for (const row of (seed.config[table] ?? []) as Row[]) {
      const key = definition.key,
        current = rows.find((r) => r[key] === row[key]);
      if (current && canonical(current) === canonical(row)) continue;
      const baseline = ((seed.baseline[table] ?? []) as Row[]).find(
        (r) => r[key] === row[key],
      );
      if (current && (!baseline || canonical(current) !== canonical(baseline)))
        throw new Error(
          'Configuração divergente preservada; seed cancelado: ' +
            table +
            '/' +
            row[key],
        );
      changes.push({ table, row, exists: !!current });
    }
  }

  return changes;
}
async function writeSeedChange(
  c: Pick<Database, 'query'>,
  { table, row, exists }: SeedChange,
) {
  const definition = definitions[table],
    columns = [...definition.columns];
  const args = columns.map((column) =>
    (definition.json as readonly string[]).includes(column)
      ? JSON.stringify(row[column])
      : row[column],
  );
  if (exists) {
    const updates = columns
      .filter((column) => column !== definition.key)
      .map((column) => quote(column) + '=$' + (columns.indexOf(column) + 1));
    if (
      [
        'scraping_profiles',
        'discovery_profiles',
        'discovery_sources',
        'extension_catalog_settings',
        'review_ai_settings',
        'offer_sharing_settings',
        'meta_pixel_settings',
      ].includes(table)
    )
      updates.push('version=version+1');
    if (table === 'review_ai_settings')
      updates.push(
        'category_version=category_version+1',
        'product_version=product_version+1',
      );
    updates.push('updated_at=clock_timestamp()');
    await c.query(
      'UPDATE ' +
        quote(table) +
        ' SET ' +
        updates.join(',') +
        ' WHERE ' +
        quote(definition.key) +
        '=$' +
        (columns.indexOf(definition.key) + 1),
      args,
    );
  } else
    await c.query(
      'INSERT INTO ' +
        quote(table) +
        ' (' +
        columns.map(quote).join(',') +
        ') VALUES (' +
        columns.map((_, i) => '$' + (i + 1)).join(',') +
        ')',
      args,
    );
}
