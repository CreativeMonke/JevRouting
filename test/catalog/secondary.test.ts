import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadSecondary, parseArtificialAnalysis, parseModelsDev } from '../../src/catalog/secondary.js';

const modelsDev = {
  someReseller: { models: { 'glm-5.3-flash': { cost: { input: 0.9, output: 2 } } } },
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.15, output: 0.5, cache_read: 0.03 }, limit: { context: 1_000_000 } } } },
  anthropic: { models: { 'claude-haiku-5-5': { cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 } } } },
  junk: { models: { 'no-cost': {} } },
};

describe('secondary sources', () => {
  it('models.dev prefers first-party providers and keeps cache prices', () => {
    const m = parseModelsDev(modelsDev);
    expect(m['glm-5-3-flash']!.pricing).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.15 });
    expect(m['claude-haiku-5-5']!.pricing!.cacheWrite).toBe(0.125);
    expect(m['no-cost']).toBeUndefined();
  });

  it('parses Artificial Analysis intelligence', () => {
    const m = parseArtificialAnalysis({ data: [{ slug: 'mystery-model-2', evaluations: { artificial_analysis_intelligence_index: 44.1 }, pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 4 } }] });
    expect(m['mystery-model-2']!.intelligence).toBe(44.1);
  });

  it('caches per source, refreshes when stale, falls back to stale cache on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-sec-'));
    let t = Date.parse('2026-10-27T00:00:00Z');
    const fetch = vi.fn(async () => new Response(JSON.stringify(modelsDev), { status: 200 }));
    const sources = { modelsDev: { enabled: true, url: 'https://md/api.json' }, artificialAnalysis: { enabled: false, url: 'x' } };
    const base = { cacheDir: dir, sources, maxAgeHours: 24, refresh: 'auto' as const, fetch, now: () => t };
    expect(Object.keys((await loadSecondary(base)).models)).toContain('glm-5-3-flash');
    await loadSecondary(base);
    expect(fetch).toHaveBeenCalledTimes(1); // fresh cache hit
    t += 25 * 3600_000;
    fetch.mockImplementationOnce(async () => new Response('nope', { status: 500 }));
    const stale = await loadSecondary(base);
    expect(stale.warnings.join()).toMatch(/models-dev refresh failed/);
    expect(stale.models['glm-5-3-flash']).toBeDefined();
  });

  it('warns when AA is enabled without a key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-sec-'));
    const r = await loadSecondary({
      cacheDir: dir, maxAgeHours: 24, refresh: 'never', fetch: vi.fn(),
      sources: { modelsDev: { enabled: false, url: '' }, artificialAnalysis: { enabled: true, url: '' } },
    });
    expect(r.warnings.join()).toMatch(/AA_API_KEY/);
  });
});
