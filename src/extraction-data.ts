import { z } from 'zod';

export const scrapedDataSchema = z.object({
  title: z.string().max(300),
  priceCents: z.number().int().positive().max(100000000).nullable(),
  originalPriceCents: z.number().int().positive().max(100000000).nullable(),
  description: z.string().max(4000), category: z.string().max(80), conditions: z.string().max(1500),
  externalId: z.string().max(100), productUrl: z.url().max(10000), images: z.array(z.url()).max(12),
  specifications: z.array(z.object({ name: z.string().max(150), value: z.string().max(600) })).max(80),
  warnings: z.array(z.string()).max(1000), missing: z.array(z.string()).max(40),
  evidence: z.array(z.object({ field: z.string(), selector: z.string().max(600) })).max(600),
  collectedAt: z.iso.datetime(),
});
