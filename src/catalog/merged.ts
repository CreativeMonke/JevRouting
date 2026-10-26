import type { CatalogLookup } from '../router/types.js';
import { usageNameForFamily } from './names.js';
import type { SecondaryModel } from './secondary.js';
import type { CatalogStore } from './store.js';
import type { Catalog, CatalogPricing, CatalogUsage, CatalogVariant } from './types.js';

/**
 * Router-facing catalog: Slopalytics first (benchmarks, real-usage prices, reliability),
 * secondary sources only where Slopalytics has nothing.
 */
export class MergedCatalog implements CatalogLookup {
  private readonly median: number | undefined;

  constructor(
    private readonly store: CatalogStore,
    private readonly catalog: Catalog,
    private readonly secondary: Record<string, SecondaryModel> = {},
  ) {
    const tokens = catalog.variants
      .map((v) => v.tokensPerTask)
      .filter((t): t is number => typeof t === 'number' && t > 0)
      .sort((a, b) => a - b);
    this.median = tokens.length ? tokens[Math.floor(tokens.length / 2)] : undefined;
  }

  variant(family: string, effort: string): CatalogVariant | undefined {
    const v = this.store.variant(family, effort);
    if (v) return v;
    const s = this.secondary[family];
    if (s?.intelligence === undefined) return undefined;
    return {
      id: family,
      family,
      name: family,
      effort: 'default',
      intelligence: s.intelligence,
      inputPrice: s.pricing?.input,
      outputPrice: s.pricing?.output,
      context: s.context,
    };
  }

  variants(family: string): CatalogVariant[] {
    const vs = this.store.variants(family);
    if (vs.length) return vs;
    const v = this.variant(family, 'medium');
    return v ? [v] : [];
  }

  pricing(family: string): CatalogPricing | undefined {
    // Slopalytics usage prices (what T3 telemetry is costed with) win; then models.dev (real cache prices);
    // then Slopalytics list prices with estimated cache ratios.
    const usageName = usageNameForFamily(family);
    if (Object.hasOwn(this.catalog.pricing, usageName)) return this.catalog.pricing[usageName];
    return this.secondary[family]?.pricing ?? this.store.pricing(family);
  }

  usage(family: string): CatalogUsage | undefined {
    return this.store.usage(family);
  }

  medianTokensPerTask(): number | undefined {
    return this.median;
  }
}
