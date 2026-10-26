import { describe, expect, it } from 'vitest';
import { fetchSlopalytics, familyFromModelId } from '../../src/catalog/index.js';

// Hits the real slopalytics.com. Run with: npm run test:live
describe.skipIf(!process.env.JEV_LIVE)('slopalytics (live)', () => {
  it('parses benchmarks and usage from the real site without warnings', async () => {
    const warnings: string[] = [];
    const catalog = await fetchSlopalytics({ onWarning: (m) => warnings.push(m) });

    expect(catalog.variants.length).toBeGreaterThanOrEqual(20);
    expect(catalog.variants.every((v) => v.intelligence !== undefined)).toBe(true);
    expect(Object.keys(catalog.pricing).length).toBeGreaterThan(0);
    expect(catalog.usage.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  }, 60_000);

  it('knows the current Opus family that the provider ids map to', async () => {
    const catalog = await fetchSlopalytics();
    const family = familyFromModelId('anthropic/claude-opus-5-5');
    expect(catalog.variants.some((v) => v.family === family)).toBe(true);
  }, 60_000);
});
