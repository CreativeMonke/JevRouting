import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogStore, catalogPaths, type CatalogVariant, type Catalog } from '../../src/catalog/index.js';
import { FIXTURE, fakeSite } from './helpers.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const HOUR = 3_600_000;
const now = () => NOW;

/** A cache file written by a previous refresh `hours` ago. */
function cachedCatalog(hours: number, variants: CatalogVariant[] = []): Catalog {
  return {
    source: 'https://slopalytics.com',
    fetchedAt: new Date(NOW - hours * HOUR).toISOString(),
    variants,
    pricing: {},
    usage: [],
  };
}

const v = (over: Partial<CatalogVariant> & Pick<CatalogVariant, 'id' | 'effort'>): CatalogVariant => ({
  family: 'fam',
  name: 'Fam',
  intelligence: 40,
  ...over,
});

let dir: string;
let paths: { catalog: string; lock: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jev-catalog-'));
  paths = catalogPaths(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const storeWith = (site: ReturnType<typeof fakeSite>, extra: Partial<ConstructorParameters<typeof CatalogStore>[0]> = {}) =>
  new CatalogStore({ cacheDir: dir, fetch: site.fetch, now, ...extra });

describe('CatalogStore.load freshness', () => {
  it('serves a fresh cache without touching the network', async () => {
    await writeFile(paths.catalog, JSON.stringify(cachedCatalog(2)));
    const site = fakeSite();
    const result = await storeWith(site).load({ maxAgeHours: 24 });
    expect(result.origin).toBe('cache');
    expect(result.ageHours).toBeCloseTo(2);
    expect(site.requests).toEqual([]);
  });

  it('refreshes a stale cache and writes it back', async () => {
    await writeFile(paths.catalog, JSON.stringify(cachedCatalog(25)));
    const site = fakeSite();
    const result = await storeWith(site).load({ maxAgeHours: 24 });
    expect(result.origin).toBe('network');
    expect(result.catalog.variants).toHaveLength(42);
    const written = JSON.parse(await readFile(paths.catalog, 'utf8')) as Catalog;
    expect(written.fetchedAt).toBe(new Date(NOW).toISOString());
  });

  it('refreshes when there is no cache file at all', async () => {
    const site = fakeSite();
    const result = await storeWith(site).load();
    expect(result.origin).toBe('network');
    expect(site.requests.length).toBeGreaterThan(0);
  });

  it('a just-refreshed cache is fresh on the next load', async () => {
    const site = fakeSite();
    const store = storeWith(site);
    await store.load();
    const second = await storeWith(fakeSite()).load();
    expect(second.origin).toBe('cache');
  });

  it('refresh: force ignores a fresh cache', async () => {
    await writeFile(paths.catalog, JSON.stringify(cachedCatalog(1)));
    const site = fakeSite();
    expect((await storeWith(site).load({ refresh: 'force' })).origin).toBe('network');
    expect(site.requests.length).toBeGreaterThan(0);
  });

  it('refresh: never uses a stale cache without any request', async () => {
    await writeFile(paths.catalog, JSON.stringify(cachedCatalog(100)));
    const site = fakeSite();
    const result = await storeWith(site).load({ refresh: 'never' });
    expect(result.origin).toBe('stale-cache');
    expect(site.requests).toEqual([]);
  });

  it('a corrupt cache file is reported and treated as missing', async () => {
    await writeFile(paths.catalog, '{"not": "a catalog"}');
    const result = await storeWith(fakeSite()).load();
    expect(result.origin).toBe('network');
    expect(result.warnings).toEqual([expect.stringContaining('ignoring unreadable cache')]);
  });
});

describe('CatalogStore.load fallbacks', () => {
  it('falls back to the stale cache when the refresh fails', async () => {
    const stale = cachedCatalog(48, [v({ id: 'old', effort: 'high' })]);
    await writeFile(paths.catalog, JSON.stringify(stale));
    const result = await storeWith(fakeSite({ indexStatus: 500 })).load({ maxAgeHours: 24 });
    expect(result.origin).toBe('stale-cache');
    expect(result.catalog.variants.map((x) => x.id)).toEqual(['old']);
    expect(result.warnings).toEqual([expect.stringContaining('refresh failed')]);
  });

  it('falls back to the bundled snapshot when there is no cache and the refresh fails', async () => {
    const result = await storeWith(fakeSite({ indexStatus: 500 })).load();
    expect(result.origin).toBe('snapshot');
    expect(result.catalog.variants.length).toBeGreaterThanOrEqual(20);
    expect(result.warnings).toEqual([expect.stringContaining('refresh failed')]);
  });

  it('uses the snapshot without network when refresh is never and nothing is cached', async () => {
    const site = fakeSite();
    const result = await storeWith(site).load({ refresh: 'never' });
    expect(result.origin).toBe('snapshot');
    expect(site.requests).toEqual([]);
  });

  it('uses an injected snapshot in place of the bundled one', async () => {
    const snapshot = cachedCatalog(0, [v({ id: 'snap', effort: 'low' })]);
    const result = await storeWith(fakeSite({ indexStatus: 500 }), { snapshot }).load();
    expect(result.catalog).toBe(snapshot);
  });

  it('a failed refresh never overwrites the cache file', async () => {
    const stale = JSON.stringify(cachedCatalog(48, [v({ id: 'keep', effort: 'low' })]));
    await writeFile(paths.catalog, stale);
    await storeWith(fakeSite({ indexStatus: 500 })).load({ refresh: 'force' });
    expect(await readFile(paths.catalog, 'utf8')).toBe(stale);
  });
});

describe('atomic write and lock', () => {
  it('leaves only catalog.json behind after a successful refresh (no tmp files, lock released)', async () => {
    await storeWith(fakeSite()).load();
    expect((await readdir(dir)).sort()).toEqual(['catalog.json']);
  });

  it('does not refresh while another process holds a fresh lock', async () => {
    await writeFile(paths.lock, '99999\n');
    const site = fakeSite();
    const result = await storeWith(site).load();
    expect(site.requests).toEqual([]);
    expect(result.origin).toBe('snapshot');
    expect(result.warnings).toEqual([expect.stringContaining('already in progress')]);
    expect(await readFile(paths.lock, 'utf8')).toBe('99999\n');
  });

  it('takes over a lock older than two minutes', async () => {
    await writeFile(paths.lock, '99999\n');
    const old = new Date(Date.now() - 3 * 60_000);
    await utimes(paths.lock, old, old);
    const result = await storeWith(fakeSite()).load();
    expect(result.origin).toBe('network');
    expect((await readdir(dir)).sort()).toEqual(['catalog.json']);
  });

  it('honours a custom lockStaleMs', async () => {
    await writeFile(paths.lock, '99999\n');
    const old = new Date(Date.now() - 10_000);
    await utimes(paths.lock, old, old);
    const result = await storeWith(fakeSite(), { lockStaleMs: 5_000 }).load();
    expect(result.origin).toBe('network');
  });
});

describe('lookups on the fixture site', () => {
  async function loaded(): Promise<CatalogStore> {
    const store = storeWith(fakeSite());
    await store.load({ refresh: 'force' });
    return store;
  }

  it('throws before load()', () => {
    expect(() => new CatalogStore({ cacheDir: dir }).variant('x', 'high')).toThrow(/call load\(\) first/);
  });

  it('variant() returns the exact effort', async () => {
    const store = await loaded();
    expect(store.variant('claude-fable-5-1', 'high')?.id).toBe('claude-fable-5-1-high');
  });

  it('variants() lists a family lowest effort first', async () => {
    const store = await loaded();
    expect(store.variants('claude-fable-5-1').map((x) => x.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('variant() treats "default" as medium', async () => {
    const store = await loaded();
    expect(store.variant('claude-fable-5-1', 'default')?.effort).toBe('medium');
    expect(store.variant('claude-fable-5-1', 'default')?.id).toBe('claude-fable-5-1-medium');
  });

  it('variant() falls back to the nearest effort; ties go to the higher effort', async () => {
    const snapshot = cachedCatalog(0, [
      v({ id: 'f-low', family: 'f', effort: 'low' }),
      v({ id: 'f-high', family: 'f', effort: 'high' }),
      v({ id: 'f-max', family: 'f', effort: 'max' }),
    ]);
    const store = storeWith(fakeSite(), { snapshot });
    await store.load({ refresh: 'never' });
    expect(store.variant('f', 'medium')?.effort).toBe('high'); // 1 away from low and high
    expect(store.variant('f', 'xhigh')?.effort).toBe('max'); // 1 away from high and max; tie goes up
    expect(store.variant('f', 'low')?.effort).toBe('low'); // exact
    expect(store.variant('f', 'none')?.effort).toBe('low'); // nearest is low
  });

  it('variant() returns undefined for unknown families and unknown efforts', async () => {
    const store = await loaded();
    expect(store.variant('no-such-family', 'high')).toBeUndefined();
    expect(store.variant('claude-fable-5-1', 'turbo')).toBeUndefined();
  });

  it('pricing() prefers the usage price list', async () => {
    const store = await loaded();
    expect(store.pricing('claude-opus-5-5')).toEqual({ input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 });
  });

  it('pricing() falls back to a variant list price with cache multipliers', async () => {
    const catalog = cachedCatalog(0, [v({ id: 'f-low', family: 'f', effort: 'low', inputPrice: 2, outputPrice: 10 })]);
    const store = storeWith(fakeSite(), { snapshot: catalog });
    await store.load({ refresh: 'never' });
    const price = store.pricing('f');
    expect(price?.input).toBe(2);
    expect(price?.cacheRead).toBeCloseTo(0.2);
    expect(price?.cacheWrite).toBeCloseTo(2.5);
    expect(price?.output).toBe(10);
    expect(store.pricing('nothing-priced')).toBeUndefined();
  });

  it('usage() finds telemetry by family via the display name', async () => {
    const store = await loaded();
    expect(store.usage('claude-opus-5-5')?.model).toBe('Opus 5.5');
    expect(store.usage('claude-opus-5-5')?.turns).toBeGreaterThan(0);
    expect(store.usage('claude-haiku-9-9')).toBeUndefined();
  });
});

describe('paretoFrontier', () => {
  const point = (id: string, costPerTask: number | undefined, intelligence: number | undefined): CatalogVariant =>
    v({ id, family: 'p', effort: 'high', costPerTask, intelligence });

  it('keeps only points not beaten on both cost and intelligence', async () => {
    const store = new CatalogStore({ cacheDir: dir, snapshot: cachedCatalog(0) });
    await store.load({ refresh: 'never' });
    const frontier = store.paretoFrontier([
      point('cheap-dumb', 0.1, 20),
      point('mid', 1, 40),
      point('mid-worse', 1.5, 35), // dominated by mid
      point('pricey-smart', 5, 55),
      point('pricey-dumber', 6, 50), // dominated by pricey-smart
      point('unpriced', undefined, 90),
      point('no-score', 0.05, undefined),
    ]);
    expect(frontier.map((x) => x.id)).toEqual(['cheap-dumb', 'mid', 'pricey-smart']);
  });

  it('keeps exact ties (neither strictly beats the other)', async () => {
    const store = new CatalogStore({ cacheDir: dir, snapshot: cachedCatalog(0) });
    await store.load({ refresh: 'never' });
    expect(store.paretoFrontier([point('a', 1, 40), point('b', 1, 40)]).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for no input', async () => {
    const store = new CatalogStore({ cacheDir: dir, snapshot: cachedCatalog(0) });
    await store.load({ refresh: 'never' });
    expect(store.paretoFrontier([])).toEqual([]);
  });
});
