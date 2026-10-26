import { catalogPaths, defaultCacheDir, withLock, writeCatalogAtomic } from './cache.js';
import { fetchSlopalytics, type FetchSlopalyticsOptions } from './slopalytics.js';
import type { Catalog } from './types.js';

/** A lock older than this is assumed to be left behind by a crashed refresh. */
const DEFAULT_LOCK_STALE_MS = 2 * 60_000;

export interface RefreshOptions extends FetchSlopalyticsOptions {
  /** Directory holding catalog.json; defaults to `$XDG_CACHE_HOME/jev-routing`. */
  cacheDir?: string;
  lockStaleMs?: number;
}

/**
 * Fetches Slopalytics and replaces the cached catalog under a lock.
 * Throws when the benchmarks cannot be fetched or another refresh holds the lock; the cache is left untouched in both cases.
 */
export async function refreshCatalog(opts: RefreshOptions = {}): Promise<Catalog> {
  const paths = catalogPaths(opts.cacheDir ?? defaultCacheDir());
  return withLock(paths.lock, opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS, async () => {
    const catalog = await fetchSlopalytics(opts);
    await writeCatalogAtomic(paths.catalog, catalog);
    return catalog;
  });
}
