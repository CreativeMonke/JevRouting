import { z } from 'zod';
import type { Catalog, CatalogPricing, CatalogUsage, CatalogVariant } from './types.js';

const PricingSchema: z.ZodType<CatalogPricing> = z.object({
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
});

const VariantSchema: z.ZodType<CatalogVariant> = z.object({
  id: z.string(),
  family: z.string(),
  name: z.string(),
  lab: z.string().optional(),
  effort: z.string(),
  intelligence: z.number().optional(),
  costPerTask: z.number().optional(),
  tokensPerTask: z.number().optional(),
  timeSec: z.number().optional(),
  speed: z.number().optional(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
  context: z.number().optional(),
  open: z.boolean().optional(),
  deprecated: z.boolean().optional(),
});

const CatalogUsageSchema: z.ZodType<CatalogUsage> = z.object({
  model: z.string(),
  turns: z.number(),
  completed: z.number(),
  failed: z.number(),
  interrupted: z.number(),
  completionRate: z.number().optional(),
  cacheHitRate: z.number().optional(),
  avgDurationSec: z.number().optional(),
});

/** Validates a catalog read from the cache or the bundled snapshot. Unknown keys are dropped. */
export const CatalogSchema: z.ZodType<Catalog> = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  variants: z.array(VariantSchema),
  pricing: z.record(z.string(), PricingSchema),
  usage: z.array(CatalogUsageSchema),
});

/** One daily row of Slopalytics t3-usage.json `metrics`; only the fields we aggregate. */
const UsageRowSchema = z.object({
  model: z.string(),
  terminal: z.number(),
  input: z.number(),
  cached: z.number(),
  completed: z.number(),
  failed: z.number(),
  interrupted: z.number(),
  timedTurns: z.number(),
  durationMs: z.number(),
});

/** Slopalytics t3-usage.json: `prices.rates` is [fresh input, cache read, cache write, output] USD/1M. */
export const UsageDataSchema = z.object({
  prices: z.object({
    rates: z.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()])),
  }),
  metrics: z.array(UsageRowSchema),
});

export type UsageData = z.infer<typeof UsageDataSchema>;
export type UsageRow = z.infer<typeof UsageRowSchema>;
