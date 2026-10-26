import { catalogPaths, defaultCacheDir, readCatalogFile } from './cache.js';
import { usageNameForFamily } from './names.js';
import { refreshCatalog, type RefreshOptions } from './refresh.js';
import { bundledSnapshot } from './snapshot.js';
import type { Catalog, CatalogPricing, CatalogUsage, CatalogVariant } from './types.js';

export const DEFAULT_MAX_AGE_HOURS = 24;

/** Cached prompt reads are ~10% of fresh input price; cache writes are 125% (Anthropic list pricing). */
const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_RATIO = 1.25;

/** Ordered low to high. "default" is looked up as "medium". */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type RefreshPolicy = 'auto' | 'force' | 'never';
/** Where the returned catalog came from: fresh cache, a live refresh, a stale cache after a failed refresh, or the bundled snapshot. */
export type CatalogOrigin = 'cache' | 'network' | 'stale-cache' | 'snapshot';

export interface LoadOptions {
  maxAgeHours?: number;
  /** auto: refresh when the cache is stale or missing. force: always refresh. never: no network. */
  refresh?: RefreshPolicy;
}

export interface LoadResult {
  catalog: Catalog;
  origin: CatalogOrigin;
  ageHours: number;
  warnings: string[];
}

export interface CatalogStoreOptions extends RefreshOptions {
  /** Used when there is no usable cache and no refresh succeeded. Defaults to the bundled snapshot. */
  snapshot?: Catalog;
}

/**
 * Local catalog cache with lookups. Call load() first; lookups read the catalog it returned.
 */
export class CatalogStore {
  private catalog: Catalog | undefined;
  private readonly cacheDir: string;

  constructor(private readonly options: CatalogStoreOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
  }

  async load(opts: LoadOptions = {}): Promise<LoadResult> {
    const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
    const refresh = opts.refresh ?? 'auto';
    const warnings: string[] = [];
    const note = (message: string): void => {
      warnings.push(message);
      this.options.onWarning?.(message);
    };

    const cached = await this.readCache(note);
    if (cached && refresh !== 'force' && this.ageHours(cached) <= maxAgeHours) {
      return this.adopt(cached, 'cache', warnings);
    }

    if (refresh !== 'never') {
      try {
        const catalog = await refreshCatalog({ ...this.options, cacheDir: this.cacheDir, onWarning: note });
        return this.adopt(catalog, 'network', warnings);
      } catch (err) {
        note(`refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (cached) return this.adopt(cached, 'stale-cache', warnings);
    return this.adopt(this.options.snapshot ?? (await bundledSnapshot()), 'snapshot', warnings);
  }

  /** All variants of a family, lowest effort first. */
  variants(family: string): CatalogVariant[] {
    return this.requireCatalog()
      .variants.filter((v) => v.family === family)
      .sort((a, b) => (effortRank(a.effort) ?? Infinity) - (effortRank(b.effort) ?? Infinity));
  }

  /** The variant at exactly this effort, else the nearest effort (ties go to the higher effort). */
  variant(family: string, effort: string): CatalogVariant | undefined {
    const candidates = this.variants(family);
    const exact = candidates.filter((v) => v.effort === effort);
    if (exact.length > 0) return preferCurrent(exact);
    return nearestEffort(candidates, effort);
  }

  /** USD per 1M tokens: the usage-data price list if present, else derived from a variant's list price. */
  pricing(family: string): CatalogPricing | undefined {
    const catalog = this.requireCatalog();
    const name = usageNameForFamily(family);
    if (Object.hasOwn(catalog.pricing, name)) return catalog.pricing[name];

    const priced = this.variants(family).find(
      (v): v is CatalogVariant & { inputPrice: number; outputPrice: number } =>
        v.inputPrice !== undefined && v.outputPrice !== undefined,
    );
    if (!priced) return undefined;
    return {
      input: priced.inputPrice,
      cacheRead: priced.inputPrice * CACHE_READ_RATIO,
      cacheWrite: priced.inputPrice * CACHE_WRITE_RATIO,
      output: priced.outputPrice,
    };
  }

  /** Real-world T3 Code telemetry for a family, if Slopalytics reports it. */
  usage(family: string): CatalogUsage | undefined {
    const name = usageNameForFamily(family);
    return this.requireCatalog().usage.find((u) => u.model === name);
  }

  /** Variants not beaten on both cost (lower) and intelligence (higher) by another. Variants without both values are skipped. */
  paretoFrontier(variants: readonly CatalogVariant[]): CatalogVariant[] {
    const points = variants.filter(hasCostAndIntelligence);
    return points
      .filter((v) => !points.some((u) => dominates(u, v)))
      .sort((a, b) => a.costPerTask - b.costPerTask || b.intelligence - a.intelligence);
  }

  private requireCatalog(): Catalog {
    if (!this.catalog) throw new Error('CatalogStore: no catalog loaded; call load() first');
    return this.catalog;
  }

  private adopt(catalog: Catalog, origin: CatalogOrigin, warnings: string[]): LoadResult {
    this.catalog = catalog;
    return { catalog, origin, ageHours: this.ageHours(catalog), warnings };
  }

  private async readCache(note: (message: string) => void): Promise<Catalog | undefined> {
    try {
      return await readCatalogFile(catalogPaths(this.cacheDir).catalog);
    } catch (err) {
      note(`ignoring unreadable cache: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private ageHours(catalog: Catalog): number {
    const fetchedMs = Date.parse(catalog.fetchedAt);
    if (Number.isNaN(fetchedMs)) return Infinity;
    return ((this.options.now ?? Date.now)() - fetchedMs) / 3_600_000;
  }
}

function effortRank(effort: string): number | undefined {
  const index = EFFORT_ORDER.indexOf(effort === 'default' ? 'medium' : effort);
  return index === -1 ? undefined : index;
}

function nearestEffort(candidates: CatalogVariant[], effort: string): CatalogVariant | undefined {
  const target = effortRank(effort);
  if (target === undefined) return undefined;
  const scored = candidates.flatMap((v) => {
    const rank = effortRank(v.effort);
    return rank === undefined ? [] : [{ v, rank, distance: Math.abs(rank - target) }];
  });
  scored.sort((a, b) => a.distance - b.distance || b.rank - a.rank);
  const [top] = scored;
  if (!top) return undefined;
  return preferCurrent(scored.filter((s) => s.rank === top.rank).map((s) => s.v));
}

/** Among same-effort variants (e.g. a thinking and a non-thinking id), prefer one that is not deprecated. */
function preferCurrent(variants: CatalogVariant[]): CatalogVariant | undefined {
  return variants.find((v) => !v.deprecated) ?? variants[0];
}

type Scored = CatalogVariant & { costPerTask: number; intelligence: number };

const hasCostAndIntelligence = (v: CatalogVariant): v is Scored => v.costPerTask !== undefined && v.intelligence !== undefined;

/** u beats v: no more expensive, no less intelligent, and better on at least one axis. */
function dominates(u: Scored, v: Scored): boolean {
  const noWorse = u.costPerTask <= v.costPerTask && u.intelligence >= v.intelligence;
  const strictlyBetter = u.costPerTask < v.costPerTask || u.intelligence > v.intelligence;
  return noWorse && strictlyBetter;
}
