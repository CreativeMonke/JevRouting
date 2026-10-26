import type { CatalogPricing, CatalogVariant } from '../../src/catalog/types.js';
import type { CatalogLookup } from '../../src/router/types.js';

const ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Minimal in-memory catalog with real Oct-2026 Slopalytics numbers for a few families. */
export function fakeCatalog(extra: CatalogVariant[] = []): CatalogLookup {
  const v = (family: string, effort: string, intelligence: number, costPerTask: number, tokensPerTask: number, timeSec: number, inputPrice: number, outputPrice: number): CatalogVariant => ({
    id: `${family}-${effort}`, family, name: family, effort, intelligence, costPerTask, tokensPerTask, timeSec, inputPrice, outputPrice, speed: 80,
  });
  const variants: CatalogVariant[] = [
    v('claude-opus-5-5', 'medium', 51.2, 1.34, 25_000, 220, 4, 20),
    v('claude-opus-5-5', 'high', 53.6, 1.82, 35_584, 278, 4, 20),
    v('claude-opus-5-5', 'max', 57.6, 5.98, 119_166, 774, 4, 20),
    v('claude-sonnet-5-5', 'low', 35.9, 0.345, 14_253, 150, 2, 10),
    v('claude-sonnet-5-5', 'medium', 40.8, 0.483, 20_937, 180, 2, 10),
    v('claude-sonnet-5-5', 'high', 46.8, 0.884, 37_327, 260, 2, 10),
    v('claude-haiku-5-5', 'low', 30, 0.03, 17_000, 60, 0.1, 0.5),
    v('claude-haiku-5-5', 'medium', 34, 0.06, 30_000, 90, 0.1, 0.5),
    v('glm-5-3-flash', 'max', 41.8, 0.284, 68_673, 1080, 0.15, 0.5),
    ...extra,
  ];
  const pricing: Record<string, CatalogPricing> = {
    'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
    'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  };
  return {
    variant(family, effort) {
      const fam = variants.filter((x) => x.family === family);
      if (!fam.length) return undefined;
      const want = ORDER.indexOf(effort === 'default' ? 'medium' : effort);
      return fam.reduce((best, x) =>
        Math.abs(ORDER.indexOf(x.effort) - want) < Math.abs(ORDER.indexOf(best.effort) - want) ? x : best,
      );
    },
    pricing: (f) => pricing[f],
    usage: () => undefined,
    medianTokensPerTask: () => 30_000,
  };
}
