import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  fetchSlopalytics,
  parseBenchmarkBundle,
  parseVariantLiteral,
  summarizeUsage,
} from '../../src/catalog/index.js';
import { FIXTURE, fakeSite } from './helpers.js';

type UsageRow = Parameters<typeof aggregateUsage>[0][number];

const NOW = Date.parse('2026-10-27T12:00:00Z');

describe('parseVariantLiteral', () => {
  it('parses booleans, leading-dot numbers, exponents, negatives and nulls', () => {
    const variant = parseVariantLiteral(
      '{id:`x-high`,family:`x`,name:`X`,variant:`X (high)`,lab:`acme`,open:!0,deprecated:!1,effort:`high`,' +
        'intelligence:.5,cost:-1.5e-3,tokens:1e6,speed:null,time:12,inputPrice:null,outputPrice:0,context:1e6}',
    );
    expect(variant).toEqual({
      id: 'x-high',
      family: 'x',
      name: 'X',
      lab: 'acme',
      effort: 'high',
      intelligence: 0.5,
      costPerTask: -0.0015,
      tokensPerTask: 1_000_000,
      timeSec: 12,
      speed: undefined,
      inputPrice: undefined,
      outputPrice: 0,
      context: 1_000_000,
      open: true,
      deprecated: false,
    });
  });

  it('keeps commas and braces inside backtick strings out of the field split', () => {
    const variant = parseVariantLiteral("{id:`a`,family:`a`,name:`Model, \"v2\" (max)`,effort:`max`,intelligence:10}");
    expect(variant?.name).toBe('Model, "v2" (max)');
  });

  it('skips entries without an intelligence score', () => {
    expect(parseVariantLiteral('{id:`a`,family:`a`,effort:`high`,intelligence:null,cost:1}')).toBeUndefined();
  });

  it('rejects malformed numbers instead of guessing', () => {
    expect(parseVariantLiteral('{id:`a`,family:`a`,effort:`high`,intelligence:1..2}')).toBeUndefined();
  });

  it('rejects literals with a non-literal value (no code execution)', () => {
    expect(parseVariantLiteral('{id:`a`,family:`a`,effort:`high`,intelligence:process.exit()}')).toBeUndefined();
  });

  it('defaults effort to "default" when missing', () => {
    expect(parseVariantLiteral('{id:`a`,family:`a`,intelligence:3}')?.effort).toBe('default');
  });
});

describe('parseBenchmarkBundle', () => {
  it('parses every variant in the fixture bundle with unique ids', () => {
    const variants = parseBenchmarkBundle(FIXTURE.bundle);
    expect(variants).toHaveLength(42);
    expect(new Set(variants.map((v) => v.id)).size).toBe(variants.length);
    expect(variants.every((v) => v.intelligence !== undefined)).toBe(true);
  });

  it('maps fixture fields onto the catalog contract', () => {
    const fable = parseBenchmarkBundle(FIXTURE.bundle).find((v) => v.id === 'claude-fable-5-1-high');
    expect(fable).toEqual({
      id: 'claude-fable-5-1-high',
      family: 'claude-fable-5-1',
      name: 'Claude Fable 5.1',
      lab: 'anthropic',
      effort: 'high',
      intelligence: 51.1515708852237,
      costPerTask: 3.912526554325558,
      tokensPerTask: 38054.279024684845,
      timeSec: 400.1688382783875,
      speed: 59.009838129825,
      inputPrice: 10,
      outputPrice: 50,
      context: 1_000_000,
      open: false,
      deprecated: false,
    });
  });

  it('leaves cost unset when the site reports null', () => {
    const agnes = parseBenchmarkBundle(FIXTURE.bundle).find((v) => v.id === 'a-x-k2');
    expect(agnes?.costPerTask).toBeUndefined();
    expect(agnes?.intelligence).toBeCloseTo(21.4612645385074);
  });

  it('dedupes by id, keeping the first occurrence', () => {
    const bundle = '{id:`d`,family:`d`,effort:`low`,intelligence:1}{id:`d`,family:`d`,effort:`low`,intelligence:2}';
    expect(parseBenchmarkBundle(bundle)).toEqual([expect.objectContaining({ id: 'd', intelligence: 1 })]);
  });
});

describe('aggregateUsage', () => {
  const row = (over: Partial<UsageRow>): UsageRow => ({
    model: 'Opus 5.5',
    terminal: 0,
    input: 0,
    cached: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    timedTurns: 0,
    durationMs: 0,
    ...over,
  });

  it('sums across days and harnesses per model and derives rates', () => {
    const usage = aggregateUsage([
      row({ terminal: 10, completed: 8, failed: 1, interrupted: 1, input: 1000, cached: 800, timedTurns: 4, durationMs: 40_000 }),
      row({ terminal: 10, completed: 9, failed: 1, input: 1000, cached: 200, timedTurns: 6, durationMs: 60_000 }),
    ]);
    expect(usage).toEqual([
      {
        model: 'Opus 5.5',
        turns: 20,
        completed: 17,
        failed: 2,
        interrupted: 1,
        completionRate: 0.85,
        cacheHitRate: 0.5,
        avgDurationSec: 10,
      },
    ]);
  });

  it('skips aggregate buckets and leaves ratios undefined when denominators are zero', () => {
    const usage = aggregateUsage([
      row({ model: 'Other models', terminal: 99 }),
      row({ model: 'Unreported model', terminal: 99 }),
      row({ model: 'Mixed models', terminal: 99 }),
      row({ model: 'Sonnet 5.5', terminal: 0, completed: 0 }),
    ]);
    expect(usage).toEqual([
      {
        model: 'Sonnet 5.5',
        turns: 0,
        completed: 0,
        failed: 0,
        interrupted: 0,
        completionRate: undefined,
        cacheHitRate: undefined,
        avgDurationSec: undefined,
      },
    ]);
  });
});

describe('summarizeUsage', () => {
  it('maps prices.rates onto CatalogPricing in fresh/cacheRead/cacheWrite/output order', () => {
    const { pricing } = summarizeUsage(JSON.parse(FIXTURE.usage));
    expect(pricing['Opus 5.5']).toEqual({ input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 });
    expect(pricing['Fable 5.1']).toEqual({ input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 });
  });
});

describe('fetchSlopalytics', () => {
  it('fetches index, the asset it names, and usage; returns variants, pricing and usage', async () => {
    const site = fakeSite();
    const catalog = await fetchSlopalytics({ baseUrl: 'https://slopalytics.com/', fetch: site.fetch, now: () => NOW });
    // Usage is fetched concurrently with benchmarks, so compare as a set.
    expect([...site.requests].sort()).toEqual([
      'https://slopalytics.com/',
      'https://slopalytics.com/assets/index-HNlnIsEG.js',
      'https://slopalytics.com/data/t3-usage.json',
    ]);
    expect(catalog.source).toBe('https://slopalytics.com');
    expect(catalog.fetchedAt).toBe('2026-10-27T12:00:00.000Z');
    expect(catalog.variants).toHaveLength(42);
    expect(catalog.pricing['Opus 5.5']?.output).toBe(20);
    expect(catalog.usage.some((u) => u.model === 'Opus 5.5')).toBe(true);
  });

  it('keeps benchmarks and reports a warning when usage fails', async () => {
    const warnings: string[] = [];
    const catalog = await fetchSlopalytics({
      fetch: fakeSite({ usageStatus: 500 }).fetch,
      now: () => NOW,
      onWarning: (m) => warnings.push(m),
    });
    expect(catalog.variants).toHaveLength(42);
    expect(catalog.pricing).toEqual({});
    expect(catalog.usage).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining('usage data unavailable')]);
  });

  it('throws when the index page has no index asset', async () => {
    await expect(
      fetchSlopalytics({ fetch: fakeSite({ index: '<html></html>' }).fetch, now: () => NOW }),
    ).rejects.toThrow(/no \/assets\/index-/);
  });

  it('throws when fewer than 20 variants parse (format changed)', async () => {
    const bundle = Array.from({ length: 19 }, (_, i) => `{id:\`v${i}\`,family:\`f${i}\`,effort:\`low\`,intelligence:1}`).join(',');
    await expect(fetchSlopalytics({ fetch: fakeSite({ bundle }).fetch, now: () => NOW })).rejects.toThrow(
      /parsed 19 benchmark variants/,
    );
  });

  it('throws when the benchmark bundle is unreachable', async () => {
    await expect(fetchSlopalytics({ fetch: fakeSite({ indexStatus: 503 }).fetch })).rejects.toThrow(/HTTP 503/);
  });
});
