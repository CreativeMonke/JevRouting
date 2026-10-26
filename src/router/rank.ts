import { familyFromModelId } from '../catalog/names.js';
import type { CatalogPricing, CatalogVariant } from '../catalog/types.js';
import type { JevRoutingConfig, ProviderConfig } from '../config/schema.js';
import { EFFORTS, type Effort } from '../providers/types.js';
import type { OutcomeStore } from './outcomes.js';
import type { SessionStore } from './session.js';
import { estimateTokens } from './state.js';
import type { Assessment, Candidate, CatalogLookup, TaskInput } from './types.js';

/** Expected output tokens by output-size level (before effort verbosity). */
const OUTPUT_TOKENS = [80, 400, 1500, 5000];
/** Fraction of an Artificial Analysis benchmark task an agentic job of this size resembles. */
const AGENTIC_SCALE = [0.15, 0.35, 0.7, 1.2];
/** Fallback median output tokens/task across the catalog (Oct 2026 ≈ 30k). */
const DEFAULT_MEDIAN_TOKENS = 30_000;

const DEFAULT_TTL_SEC: Record<string, number> = {
  anthropic: 300,
  openai: 1800,
  google: 300,
  deepseek: 14_400,
};
const DEFAULT_COST_MULTIPLIER = { metered: 1, subscription: 0.15, free: 0.02 } as const;

/** Slopalytics family slug for a provider: explicit catalogId, else derived from the model id. */
export function catalogFamily(p: ProviderConfig): string {
  return p.catalogId ?? familyFromModelId(p.model);
}

export function inferFamilyKind(p: ProviderConfig): string {
  if (p.family) return p.family;
  const m = p.model.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return 'anthropic';
  if (/gpt|\bo\d/.test(m)) return 'openai';
  if (/gemini|gemma/.test(m)) return 'google';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/glm/.test(m)) return 'zhipu';
  return 'other';
}

/** Linear interpolation into a level table for a continuous score. */
function interp(table: number[], x: number): number {
  const c = Math.min(table.length - 1, Math.max(0, x));
  const lo = Math.floor(c);
  const hi = Math.min(table.length - 1, lo + 1);
  return table[lo]! + (table[hi]! - table[lo]!) * (c - lo);
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** P(model of intelligence I is good enough), integrated over Jev's difficulty distribution. */
export function capability(I: number, a: Assessment, spread: number): number {
  const req = a.requiredByLevel;
  const total = a.difficulty.reduce((x, y) => x + y, 0);
  if (!req || total <= 0) return sigmoid((I - a.requiredIntelligence) / spread);
  return a.difficulty.reduce((acc, p, i) => acc + (p / total) * sigmoid((I - req[i]!) / spread), 0);
}

function resolvePricing(p: ProviderConfig, v: CatalogVariant | undefined, catalog: CatalogLookup | undefined, family: string): CatalogPricing | undefined {
  if (p.pricing) return p.pricing;
  const fromUsage = catalog?.pricing(family);
  if (fromUsage) return fromUsage;
  if (v?.inputPrice !== undefined && v.outputPrice !== undefined) {
    return { input: v.inputPrice, cacheRead: v.inputPrice * 0.1, cacheWrite: v.inputPrice * 1.25, output: v.outputPrice };
  }
  return undefined;
}

/** Efforts to consider for a provider, each paired with its catalog variant (deduped by variant id). */
function effortVariants(p: ProviderConfig, family: string, catalog?: CatalogLookup): Array<{ effort: Effort; v?: CatalogVariant }> {
  const efforts = p.efforts ?? [...EFFORTS];
  const seen = new Set<string>();
  const out: Array<{ effort: Effort; v?: CatalogVariant }> = [];
  for (const effort of efforts) {
    const v = catalog?.variant(family, effort);
    if (v) {
      // Only take a variant whose own effort matches, unless the provider pinned efforts explicitly.
      const exact = v.effort === effort || (v.effort === 'default' && effort === 'medium');
      if (!exact && !p.efforts) continue;
      if (seen.has(v.id)) continue;
      seen.add(v.id);
    }
    out.push({ effort, v });
  }
  if (!out.length) out.push({ effort: p.efforts?.[0] ?? 'medium', v: catalog?.variant(family, 'medium') });
  return out;
}

export interface RankContext {
  cfg: JevRoutingConfig;
  catalog?: CatalogLookup;
  sessions?: SessionStore;
  outcomes?: OutcomeStore;
}

export function rankCandidates(task: TaskInput, a: Assessment, ctx: RankContext, pruneContext: boolean): Candidate[] {
  const { cfg, catalog, sessions, outcomes } = ctx;
  const only = new Set(cfg.routing.only);
  const median = catalog?.medianTokensPerTask?.() ?? DEFAULT_MEDIAN_TOKENS;

  const promptTokens = estimateTokens(task.prompt);
  const fullCtx =
    task.facts?.contextTokens ??
    promptTokens + (task.history ?? []).reduce((n, m) => n + estimateTokens(m.content), 0);
  const ctxTokens = pruneContext ? promptTokens : fullCtx;
  const outTokens = interp(OUTPUT_TOKENS, a.outputSize);
  const agenticScale = interp(AGENTIC_SCALE, a.outputSize);
  const fitN = a.modelFit ? Object.keys(a.modelFit).length : 0;

  const out: Candidate[] = [];
  for (const [id, p] of Object.entries(cfg.providers)) {
    if (!p.enabled || (only.size && !only.has(id))) continue;
    const family = catalogFamily(p);
    const kind = inferFamilyKind(p);
    const ttl = p.cacheTtlSec ?? DEFAULT_TTL_SEC[kind] ?? 0;
    const warm = sessions?.isWarm(task.sessionId, id, ttl) ?? false;
    const multiplier = p.costMultiplier ?? DEFAULT_COST_MULTIPLIER[p.billing];
    const usage = catalog?.usage(family);

    for (const { effort, v } of effortVariants(p, family, catalog)) {
      if (task.forceEffort && effort !== task.forceEffort) continue;
      const reasons: string[] = [];
      const intelligence = v?.intelligence ?? p.intelligence;
      if (intelligence === undefined) {
        reasons.push('no intelligence data (catalog or prior)');
      }
      const I = intelligence ?? 0;
      const pricing = resolvePricing(p, v, catalog, family);

      // Prefill: the plan's stay-vs-switch term. Warm cache -> read price; cold -> write price.
      const prefillRate = pricing ? (warm ? pricing.cacheRead : pricing.cacheWrite || pricing.input) : 0;
      const prefill = (ctxTokens * prefillRate) / 1e6;

      const verbosity = Math.min(4, Math.max(0.25, (v?.tokensPerTask ?? median) / median));
      const oneShot = pricing ? prefill + (outTokens * verbosity * pricing.output) / 1e6 : undefined;
      const perTask = v?.costPerTask ?? p.costPerTask;
      const agenticCost = perTask !== undefined ? perTask * agenticScale + prefill : oneShot !== undefined ? oneShot * 8 : undefined;

      let listCost: number;
      if (oneShot === undefined && agenticCost === undefined) {
        listCost = 0;
        if (p.billing === 'metered') reasons.push('no pricing data');
      } else {
        listCost = a.agentic * (agenticCost ?? oneShot!) + (1 - a.agentic) * (oneShot ?? agenticCost!);
      }
      const attemptCost = listCost * multiplier;

      const speed = v?.speed && v.speed > 0 ? v.speed : 60;
      const oneShotMin = (outTokens * verbosity) / speed / 60 + 0.05;
      const agenticMin = v?.timeSec ? (v.timeSec * agenticScale) / 60 : oneShotMin * 8;
      const expectedMinutes = a.agentic * agenticMin + (1 - a.agentic) * oneShotMin;

      const priorRel = usage?.completionRate !== undefined ? Math.min(1, Math.max(0.5, usage.completionRate / 0.97)) : 0.95;
      const reliability = outcomes ? outcomes.reliability(id, effort, priorRel) : priorRel;
      const pSuccess = capability(I, a, cfg.routing.successSpread) * reliability;

      const latencyPenalty = cfg.routing.latencyWeightUsdPerMin * (1 + 3 * a.latencySensitive) * expectedMinutes;
      let objective = (attemptCost + latencyPenalty) / Math.max(pSuccess, 1e-3);
      if (fitN >= 2 && cfg.classifier.modelFitWeight > 0) {
        const pf = a.modelFit?.[id] ?? 1 / fitN;
        const bonus = Math.min(2, Math.max(0.5, 1 + cfg.classifier.modelFitWeight * (pf * fitN - 1)));
        objective /= bonus;
      }

      let eligible = intelligence !== undefined && !reasons.includes('no pricing data');
      if (pSuccess < cfg.routing.minSuccess) {
        eligible = false;
        reasons.push(`P(success) ${pSuccess.toFixed(2)} < ${cfg.routing.minSuccess}`);
      }
      if (p.maxIntelligence !== undefined && a.requiredIntelligence > p.maxIntelligence) {
        eligible = false;
        reasons.push(`task needs ${a.requiredIntelligence} > provider cap ${p.maxIntelligence}`);
      }
      if (warm) reasons.push('warm cache');

      out.push({
        providerId: id,
        effort,
        family,
        intelligence: I,
        pSuccess,
        attemptCost,
        listCost,
        objective,
        expectedMinutes,
        cacheWarm: warm,
        eligible,
        reasons,
      });
    }
  }

  return out.sort((x, y) =>
    x.eligible !== y.eligible ? (x.eligible ? -1 : 1) : x.eligible ? x.objective - y.objective : y.pSuccess - x.pSuccess,
  );
}

/** Winner plus fallbacks on distinct providers (a failing provider usually fails at every effort). */
export function buildPlan(ranked: Candidate[], fallback: string[], maxAttempts = 3): Array<{ providerId: string; effort: Effort }> {
  const plan: Array<{ providerId: string; effort: Effort }> = [];
  const used = new Set<string>();
  for (const c of ranked) {
    if (plan.length >= maxAttempts) break;
    if (used.has(c.providerId)) continue;
    if (!c.eligible && plan.length > 0) break;
    used.add(c.providerId);
    plan.push({ providerId: c.providerId, effort: c.effort });
  }
  for (const id of fallback) {
    if (used.has(id)) continue;
    const c = ranked.find((r) => r.providerId === id);
    plan.push({ providerId: id, effort: c?.effort ?? 'medium' });
    used.add(id);
  }
  return plan;
}
