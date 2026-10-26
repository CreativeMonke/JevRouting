// Model catalog: benchmark + price + reliability data, cached locally and
// refreshed (default: daily) from Slopalytics.

/** One model family at one reasoning effort (Slopalytics "variant"). */
export interface CatalogVariant {
  /** Slopalytics variant id, e.g. "gpt-6-1-sol-high". */
  id: string;
  /** Family slug, model id with dots as dashes, e.g. "gpt-6-1-sol". */
  family: string;
  name: string;
  lab?: string;
  /** "low" | "medium" | "high" | "xhigh" | "max" | "default" | "none" ... */
  effort: string;
  /** Artificial Analysis Intelligence Index. */
  intelligence?: number;
  /** USD per benchmark task at API list prices. */
  costPerTask?: number;
  /** Avg output tokens per task. */
  tokensPerTask?: number;
  /** Avg seconds per task. */
  timeSec?: number;
  /** Output tokens/sec. */
  speed?: number;
  /** USD per 1M tokens. */
  inputPrice?: number;
  outputPrice?: number;
  context?: number;
  open?: boolean;
  deprecated?: boolean;
}

/** USD per 1M tokens (Slopalytics usage "prices.rates": fresh, cacheRead, cacheWrite, output). */
export interface CatalogPricing {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Real-world T3 Code telemetry for a model (aggregated over the usage window). */
export interface CatalogUsage {
  /** Display name used by Slopalytics usage data, e.g. "Opus 5.5". */
  model: string;
  turns: number;
  completed: number;
  failed: number;
  interrupted: number;
  /** completed / terminal */
  completionRate?: number;
  /** cached / input */
  cacheHitRate?: number;
  avgDurationSec?: number;
}

export interface Catalog {
  source: string;
  fetchedAt: string;
  variants: CatalogVariant[];
  /** Keyed by Slopalytics usage display name. */
  pricing: Record<string, CatalogPricing>;
  usage: CatalogUsage[];
}
