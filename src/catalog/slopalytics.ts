import { UsageDataSchema, type UsageData, type UsageRow } from './schema.js';
import type { Catalog, CatalogPricing, CatalogUsage, CatalogVariant } from './types.js';

export const SLOPALYTICS_URL = 'https://slopalytics.com';

/** Minimal fetch shape so tests can inject a stub. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchSlopalyticsOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Receives non-fatal problems, e.g. usage data being unavailable. */
  onWarning?: (message: string) => void;
}

export class SlopalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlopalyticsError';
  }
}

/** Fewer parsed variants than this means the bundle format changed, not that the site lost models. */
const MIN_VARIANTS = 20;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Usage rows for these are aggregates, not models; they are not priced or ranked. */
const EXCLUDED_USAGE_MODELS = new Set(['Other models', 'Unreported model', 'Mixed models']);
const USAGE_TOTAL_KEYS = ['terminal', 'completed', 'failed', 'interrupted', 'input', 'cached', 'timedTurns', 'durationMs'] as const;

const VARIANT_LITERAL_RE = /\{id:`[^`]+`,family:`[^`]+`,[^}]*\}/g;

type FieldValue = string | number | boolean | null;
type Fields = Record<string, FieldValue>;

/** Parses `key:value,...` where values are `backtick strings`, numbers, null, !0 (true) or !1 (false). No eval. */
function parseFields(body: string): Fields | undefined {
  const field = /([A-Za-z_]\w*):(?:`([^`]*)`|(null)|!([01])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))/y;
  const fields: Fields = {};
  let pos = 0;
  while (pos < body.length) {
    field.lastIndex = pos;
    const match = field.exec(body);
    if (!match) return undefined;
    const [, key, text, isNull, boolDigit, num] = match;
    if (key === undefined) return undefined;
    fields[key] = text !== undefined ? text : isNull ? null : boolDigit !== undefined ? boolDigit === '0' : Number(num);
    pos = field.lastIndex;
    if (pos < body.length) {
      if (body[pos] !== ',') return undefined;
      pos += 1;
    }
  }
  return fields;
}

const asText = (value: FieldValue | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
const asNumber = (value: FieldValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const asFlag = (value: FieldValue | undefined): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

/** Converts one `{id:...,family:...}` literal from the bundle. Returns undefined when it has no intelligence score. */
export function parseVariantLiteral(literal: string): CatalogVariant | undefined {
  const f = parseFields(literal.slice(1, -1));
  if (!f) return undefined;
  const id = asText(f.id);
  const family = asText(f.family);
  const intelligence = asNumber(f.intelligence);
  if (!id || !family || intelligence === undefined) return undefined;
  return {
    id,
    family,
    name: asText(f.name) ?? family,
    lab: asText(f.lab),
    effort: asText(f.effort) ?? 'default',
    intelligence,
    costPerTask: asNumber(f.cost),
    tokensPerTask: asNumber(f.tokens),
    timeSec: asNumber(f.time),
    speed: asNumber(f.speed),
    inputPrice: asNumber(f.inputPrice),
    outputPrice: asNumber(f.outputPrice),
    context: asNumber(f.context),
    open: asFlag(f.open),
    deprecated: asFlag(f.deprecated),
  };
}

/** Extracts benchmark variants from the Slopalytics JS bundle; deduplicated by id, first occurrence wins. */
export function parseBenchmarkBundle(bundle: string): CatalogVariant[] {
  const byId = new Map<string, CatalogVariant>();
  for (const literal of bundle.match(VARIANT_LITERAL_RE) ?? []) {
    const variant = parseVariantLiteral(literal);
    if (variant && !byId.has(variant.id)) byId.set(variant.id, variant);
  }
  return [...byId.values()];
}

/** Sums daily usage rows per model. Ratios are undefined when their denominator is zero. */
export function aggregateUsage(rows: readonly UsageRow[]): CatalogUsage[] {
  type Totals = Pick<UsageRow, (typeof USAGE_TOTAL_KEYS)[number]>;
  const totals = new Map<string, Totals>();
  for (const row of rows) {
    if (EXCLUDED_USAGE_MODELS.has(row.model)) continue;
    const sum = totals.get(row.model) ?? { terminal: 0, completed: 0, failed: 0, interrupted: 0, input: 0, cached: 0, timedTurns: 0, durationMs: 0 };
    for (const key of USAGE_TOTAL_KEYS) sum[key] += row[key];
    totals.set(row.model, sum);
  }
  return [...totals]
    .map(([model, t]) => ({
      model,
      turns: t.terminal,
      completed: t.completed,
      failed: t.failed,
      interrupted: t.interrupted,
      completionRate: ratio(t.completed, t.terminal),
      cacheHitRate: ratio(t.cached, t.input),
      avgDurationSec: t.timedTurns > 0 ? t.durationMs / t.timedTurns / 1000 : undefined,
    }))
    .sort((a, b) => b.turns - a.turns);
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

export function summarizeUsage(data: UsageData): { pricing: Record<string, CatalogPricing>; usage: CatalogUsage[] } {
  const pricing = Object.fromEntries(
    Object.entries(data.prices.rates).map(([name, [input, cacheRead, cacheWrite, output]]) => [
      name,
      { input, cacheRead, cacheWrite, output },
    ]),
  );
  return { pricing, usage: aggregateUsage(data.metrics) };
}

async function getText(fetch: FetchLike, url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new SlopalyticsError(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function fetchBenchmarks(fetch: FetchLike, root: string, timeoutMs: number): Promise<CatalogVariant[]> {
  const html = await getText(fetch, `${root}/`, timeoutMs);
  const asset = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  if (!asset) throw new SlopalyticsError('index page has no /assets/index-*.js script');
  const bundle = await getText(fetch, new URL(asset, `${root}/`).href, timeoutMs);
  const variants = parseBenchmarkBundle(bundle);
  if (variants.length < MIN_VARIANTS) {
    throw new SlopalyticsError(`parsed ${variants.length} benchmark variants (expected >= ${MIN_VARIANTS}); bundle format may have changed`);
  }
  return variants;
}

async function fetchUsage(fetch: FetchLike, root: string, timeoutMs: number): Promise<UsageData> {
  const text = await getText(fetch, `${root}/data/t3-usage.json`, timeoutMs);
  return UsageDataSchema.parse(JSON.parse(text));
}

const EMPTY_USAGE = { pricing: {}, usage: [] };

/**
 * Builds a Catalog from the live site. Benchmarks are required; usage and pricing are optional
 * (a failure there is reported through onWarning and yields empty pricing/usage).
 */
export async function fetchSlopalytics(opts: FetchSlopalyticsOptions = {}): Promise<Catalog> {
  const root = (opts.baseUrl ?? SLOPALYTICS_URL).replace(/\/+$/, '');
  const fetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warn = opts.onWarning ?? (() => {});
  const [variants, usage] = await Promise.all([
    fetchBenchmarks(fetch, root, timeoutMs),
    fetchUsage(fetch, root, timeoutMs).then(summarizeUsage, (err: unknown) => {
      warn(`usage data unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return EMPTY_USAGE;
    }),
  ]);
  return {
    source: root,
    fetchedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    variants,
    pricing: usage.pricing,
    usage: usage.usage,
  };
}
