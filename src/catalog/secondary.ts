// Secondary catalog sources. Slopalytics stays primary; these only fill gaps:
//  - models.dev: public pricing (incl. cache read/write) and context for ~every model.
//  - Artificial Analysis API: intelligence index for models Slopalytics doesn't list (needs a key).
// Each source is cached on disk with the same daily TTL as the main catalog.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogPricing } from './types.js';

export interface SecondaryModel {
  family: string;
  pricing?: CatalogPricing;
  context?: number;
  intelligence?: number;
  source: 'models.dev' | 'artificial-analysis';
}

export interface SecondaryData {
  fetchedAt: string;
  models: Record<string, SecondaryModel>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** First-party providers win over resellers when models.dev lists the same model many times. */
const FIRST_PARTY = ['anthropic', 'openai', 'google', 'deepseek', 'zhipuai', 'zai', 'xai', 'moonshotai', 'mistral', 'alibaba', 'minimax'];

export const toFamily = (id: string) =>
  (id.split('/').pop() ?? id).toLowerCase().replace(/(:free|-free)$/, '').replace(/\./g, '-');

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Parse models.dev api.json: { [provider]: { models: { [id]: { cost: {input, output, cache_read, cache_write}, limit: {context} } } } } */
export function parseModelsDev(json: unknown): Record<string, SecondaryModel> {
  const out: Record<string, SecondaryModel & { rank: number }> = {};
  if (!json || typeof json !== 'object') return {};
  for (const [provider, p] of Object.entries(json as Record<string, { models?: Record<string, any> }>)) {
    const rank = FIRST_PARTY.indexOf(provider);
    const r = rank === -1 ? FIRST_PARTY.length : rank;
    for (const [id, m] of Object.entries(p?.models ?? {})) {
      const input = num(m?.cost?.input);
      const output = num(m?.cost?.output);
      if (input === undefined || output === undefined) continue;
      const family = toFamily(id);
      const prev = out[family];
      if (prev && prev.rank <= r) continue;
      out[family] = {
        family,
        rank: r,
        source: 'models.dev',
        context: num(m?.limit?.context),
        pricing: {
          input,
          output,
          cacheRead: num(m?.cost?.cache_read) ?? input * 0.1,
          // No cache-write price usually means writes are free (implicit caching) or billed as input.
          cacheWrite: num(m?.cost?.cache_write) ?? input,
        },
      };
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, { rank: _r, ...v }]) => [k, v]));
}

/** Parse Artificial Analysis /api/v2/data/llms/models. */
export function parseArtificialAnalysis(json: unknown): Record<string, SecondaryModel> {
  const out: Record<string, SecondaryModel> = {};
  const data = (json as { data?: any[] })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const slug = typeof m?.slug === 'string' ? m.slug : undefined;
    const intelligence = num(m?.evaluations?.artificial_analysis_intelligence_index);
    if (!slug || intelligence === undefined) continue;
    const input = num(m?.pricing?.price_1m_input_tokens);
    const output = num(m?.pricing?.price_1m_output_tokens);
    out[toFamily(slug)] = {
      family: toFamily(slug),
      source: 'artificial-analysis',
      intelligence,
      pricing: input !== undefined && output !== undefined ? { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 } : undefined,
    };
  }
  return out;
}

export interface SecondarySourceConfig {
  modelsDev: { enabled: boolean; url: string };
  artificialAnalysis: { enabled: boolean; apiKey?: string; url: string };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

async function fetchJson(fetchFn: FetchLike, url: string, headers: Record<string, string> = {}, timeoutMs = 20_000) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Load (or refresh when stale) each enabled secondary source. Failures fall back to stale cache, then nothing. */
export async function loadSecondary(opts: {
  cacheDir: string;
  sources: SecondarySourceConfig;
  maxAgeHours: number;
  refresh: 'auto' | 'force' | 'never';
  fetch?: FetchLike;
  now?: () => number;
}): Promise<{ models: Record<string, SecondaryModel>; warnings: string[] }> {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetch ?? fetch;
  const warnings: string[] = [];
  await mkdir(opts.cacheDir, { recursive: true });

  const one = async (name: string, enabled: boolean, load: () => Promise<Record<string, SecondaryModel>>) => {
    if (!enabled) return {};
    const file = join(opts.cacheDir, `${name}.json`);
    const cached = await readJson<SecondaryData>(file);
    const age = cached ? (now() - Date.parse(cached.fetchedAt)) / 3_600_000 : Infinity;
    if (cached && opts.refresh !== 'force' && age <= opts.maxAgeHours) return cached.models;
    if (opts.refresh !== 'never') {
      try {
        const models = await load();
        await writeAtomic(file, { fetchedAt: new Date(now()).toISOString(), models } satisfies SecondaryData);
        return models;
      } catch (err) {
        warnings.push(`${name} refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return cached?.models ?? {};
  };

  const aa = opts.sources.artificialAnalysis;
  const aaEnabled = aa.enabled && !!aa.apiKey;
  if (aa.enabled && !aa.apiKey) warnings.push('artificialAnalysis enabled but no apiKey (set AA_API_KEY)');

  const [md, aaModels] = await Promise.all([
    one('models-dev', opts.sources.modelsDev.enabled, async () => parseModelsDev(await fetchJson(fetchFn, opts.sources.modelsDev.url))),
    one('artificial-analysis', aaEnabled, async () =>
      parseArtificialAnalysis(await fetchJson(fetchFn, aa.url, { 'x-api-key': aa.apiKey! })),
    ),
  ]);

  // AA intelligence merged onto models.dev pricing (models.dev has real cache prices).
  const merged: Record<string, SecondaryModel> = { ...aaModels };
  for (const [k, v] of Object.entries(md)) {
    merged[k] = { ...v, intelligence: aaModels[k]?.intelligence, pricing: v.pricing ?? aaModels[k]?.pricing };
  }
  return { models: merged, warnings };
}
