// Replay a real agent conversation through the router, decision by decision.
//
// Turns come from a T3 Code thread export (bench/conversation/t3-export-*.json); full user
// texts and exact per-call token usage come from the Claude Code session transcript of the
// same conversation. For every user turn we ask the router (with Jev = local Clef) which
// provider×effort it would have used, then re-price the *same* tokens that turn actually
// consumed at that model's prices. A model switch between turns turns the first call's
// cache reads into cache writes (cold cache on the new model), so switching isn't free.
//
//   npx tsx bench/conversation.ts --transcript ~/.claude/projects/<proj>/<session>.jsonl \
//     [--config jev.config.yaml] [--out bench/results/conversation.json]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseArgs } from 'node:util';
import { buildApp, type App } from '../src/app.js';
import { Router } from '../src/router/engine.js';
import { OutcomeStore } from '../src/router/outcomes.js';
import { SessionStore } from '../src/router/session.js';
import { inferFamilyKind } from '../src/router/rank.js';
import { redact } from '../src/router/state.js';
import type { CatalogPricing } from '../src/catalog/types.js';

interface ExportItem {
  position: number;
  type: string;
  createdBy: string | null;
  creationSource: string | null;
  updatedAt: string;
  text: string | null;
}

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface Call extends Usage {
  ts: number;
}

export interface TurnResult {
  turn: number;
  at: string;
  prompt: string;
  calls: number;
  tokens: Usage;
  decision: {
    source: string;
    jevModel?: string;
    jevLatencyMs?: number;
    level: number;
    required: number;
    kind: string;
    agentic: number;
    risk: number;
    providerId: string;
    effort: string;
  };
  actualUsd: number;
  routedUsd: number;
  switched: boolean;
}

const zero = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

/** Assistant API calls with usage, deduped by message id (transcripts repeat one per content block). */
export function readCalls(transcript: string): { calls: Call[]; userTexts: Array<{ ts: number; text: string }> } {
  const byId = new Map<string, Call>();
  const userTexts: Array<{ ts: number; text: string }> = [];
  for (const line of readFileSync(transcript, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(e.timestamp);
    if (e.type === 'assistant' && e.message?.usage && e.message?.id) {
      const u = e.message.usage;
      byId.set(e.message.id, {
        ts,
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
      });
    } else if (e.type === 'user') {
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '';
      if (text) userTexts.push({ ts, text });
    }
  }
  return { calls: [...byId.values()].sort((a, b) => a.ts - b.ts), userTexts };
}

interface FullExport {
  root: { items: Array<{ type: string; payload: Record<string, any> }>; providerTurns: Array<{ payload: Record<string, any> }> };
  children: Array<{
    thread: { title: string; payload: { modelSelection?: { model?: string } } };
    providerTurns: Array<{ payload: { turnTokenUsage?: Record<string, number | string | boolean> } }>;
  }>;
}

export function loadExport(path: string): FullExport {
  const raw = readFileSync(path);
  return JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
}

/** User turns from the full T3 export, with complete text. Server-sent "continue" resumes start real work, so they count. */
export function turnsFromExport(exp: FullExport): Array<{ ts: number; text: string }> {
  return exp.root.items
    .filter((i) => i.type === 'user_message' && i.payload.createdBy === 'user')
    .map((i) => ({ ts: Date.parse(i.payload.startedAt ?? i.payload.updatedAt), text: String(i.payload.text ?? '') }))
    .sort((a, b) => a.ts - b.ts);
}

/** T3's own usage for a provider turn, in the same shape as transcript calls (inputTokens is the total). */
export function t3Usage(u: Record<string, number | string | boolean> | undefined): Usage | undefined {
  if (!u || typeof u.inputTokens !== 'number') return undefined;
  const cached = Number(u.cachedInputTokens ?? 0);
  const write = Number(u.cacheCreationTokens ?? 0);
  return { input: Math.max(0, u.inputTokens - cached - write), cacheRead: cached, cacheWrite: write, output: Number(u.outputTokens ?? 0) };
}

/** USD for one call. Anthropic cache writes in this session were 1h TTL (2x input), others use their write price. */
export function priceCall(u: Usage, p: CatalogPricing, family: string, coldSwitch: boolean): number {
  const write = family === 'anthropic' ? p.input * 2 : p.cacheWrite || p.input;
  const cacheRead = coldSwitch ? 0 : u.cacheRead;
  const cacheWrite = u.cacheWrite + (coldSwitch ? u.cacheRead : 0);
  return (u.input * p.input + cacheRead * p.cacheRead + cacheWrite * write + u.output * p.output) / 1e6;
}

function pricingFor(app: App, providerId: string): { p: CatalogPricing; family: string } {
  const cfg = app.config.providers[providerId];
  if (!cfg) throw new Error(`unknown provider ${providerId}`);
  const p = cfg.pricing ?? app.catalog?.pricing(cfg.catalogId ?? cfg.model);
  if (!p) throw new Error(`no pricing for ${providerId}`);
  return { p, family: inferFamilyKind(cfg) };
}

async function main() {
  const { values } = parseArgs({
    options: {
      transcript: { type: 'string' },
      config: { type: 'string', default: 'jev.config.yaml' },
      export: { type: 'string', default: 'bench/conversation/t3-thread-full.json.gz' },
      baseline: { type: 'string', default: 'claude-opus' },
      out: { type: 'string', default: 'bench/results/conversation.json' },
      /** Decisions are cached here per turn so an interrupted replay resumes. */
      cache: { type: 'string', default: 'bench/results/conversation.decisions.json' },
      'jev-timeout-ms': { type: 'string', default: '600000' },
      'as-metered': { type: 'boolean', default: true },
    },
  });
  if (!values.transcript) throw new Error('--transcript <session.jsonl> required');

  const jevTimeout = Number(values['jev-timeout-ms']);
  const app = await buildApp({
    configPath: values.config,
    catalogRefresh: 'never',
    ephemeral: true,
    // A replay wants a real Jev answer for every turn, even if local Clef is slow under memory pressure.
    mutateConfig: (cfg) => {
      cfg.jev.timeoutMs = jevTimeout;
      for (const b of cfg.jev.backends) b.timeoutMs = jevTimeout;
      // The replay compares API list prices, so the router must optimise list prices too:
      // subscription seats are treated as metered (free models stay free).
      if (values['as-metered']) for (const p of Object.values(cfg.providers)) if (p.billing === 'subscription') p.billing = 'metered';
    },
  });
  // Replay clock: session cache warmth is judged at the turn's real timestamp, so a model used
  // minutes ago is warm (within its TTL) and the overnight gap genuinely goes cold.
  let clock = 0;
  const sessions = new SessionStore({ now: () => clock });
  const router = new Router({ config: app.config, providers: app.providers, catalog: app.catalog, sessions, outcomes: new OutcomeStore(), log: () => {} });
  const cache: Record<string, Awaited<ReturnType<typeof app.router.decide>>> = existsSync(values.cache!)
    ? JSON.parse(readFileSync(values.cache!, 'utf8'))
    : {};
  const { calls } = readCalls(values.transcript);
  const exp = loadExport(values.export!);
  const turns = turnsFromExport(exp);
  const base = pricingFor(app, values.baseline!);

  const results: TurnResult[] = [];
  const history: Array<{ role: 'user'; content: string }> = [];
  let prevProvider: string | undefined = values.baseline;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const end = turns[i + 1]?.ts ?? Infinity;
    const turnCalls = calls.filter((c) => c.ts >= t.ts && c.ts < end);
    if (!turnCalls.length) continue;
    const prompt = redact(t.text);
    const tokens = turnCalls.reduce((acc, c) => ({
      input: acc.input + c.input, cacheRead: acc.cacheRead + c.cacheRead, cacheWrite: acc.cacheWrite + c.cacheWrite, output: acc.output + c.output,
    }), zero());
    const first = turnCalls[0]!;

    const key = `${t.ts}`;
    clock = first.ts;
    const task = {
      prompt,
      history: [...history],
      sessionId: 'conversation-replay',
      facts: { contextTokens: first.input + first.cacheRead + first.cacheWrite },
    };
    let d: Awaited<ReturnType<typeof router.decide>>;
    const cached = cache[key];
    if (cached && cached.assessment.source === 'jev') {
      // Reuse Clef's answer; re-rank against the current session cache state.
      d = await router.decide(task, { assessment: cached.assessment });
    } else {
      const started = Date.now();
      d = await router.decide(task);
      if (d.assessment.jev) d.assessment.jev.latencyMs ||= Date.now() - started;
      cache[key] = d;
      writeFileSync(values.cache!, JSON.stringify(cache));
    }
    const step = d.plan[0]!;
    const routed = pricingFor(app, step.providerId);
    const switched = step.providerId !== prevProvider;

    const actualUsd = turnCalls.reduce((s, c) => s + priceCall(c, base.p, base.family, false), 0);
    const routedUsd = turnCalls.reduce((s, c, k) => s + priceCall(c, routed.p, routed.family, switched && k === 0), 0);

    const a = d.assessment;
    results.push({
      turn: results.length + 1,
      at: new Date(t.ts).toISOString(),
      prompt: prompt.slice(0, 160),
      calls: turnCalls.length,
      tokens,
      decision: {
        source: a.source, jevModel: a.jev?.model, jevLatencyMs: a.jev?.latencyMs, level: a.level, required: a.requiredIntelligence,
        kind: a.kind, agentic: a.agentic, risk: a.risk, providerId: step.providerId, effort: step.effort,
      },
      actualUsd,
      routedUsd,
      switched,
    });
    console.error(
      `#${String(results.length).padStart(2)} ${prompt.slice(0, 48).replace(/\s+/g, ' ').padEnd(48)} calls=${String(turnCalls.length).padStart(3)} ` +
        `→ ${`${step.providerId}@${step.effort}`.padEnd(30)} [${a.source}${a.jev?.model ? `:${a.jev.model}` : ''} L${a.level}] ` +
        `actual $${actualUsd.toFixed(2)} routed $${routedUsd.toFixed(2)}${switched ? ' (cold switch)' : ''}`,
    );
    history.push({ role: 'user', content: prompt });
    prevProvider = step.providerId;
    // The turn's work warmed this provider's cache up to the turn's last call.
    const last = turnCalls.at(-1)!;
    clock = last.ts;
    sessions.record('conversation-replay', step.providerId, last.input + last.cacheRead + last.cacheWrite, true);
  }

  const total = (f: (r: TurnResult) => number) => results.reduce((s, r) => s + f(r), 0);

  // Cross-check: T3's own per-run usage for the main thread vs the transcript calls we priced.
  const t3Main = exp.root.providerTurns.map((p) => t3Usage(p.payload.turnTokenUsage)).filter((u): u is Usage => !!u);
  const sumU = (us: Usage[]) => us.reduce((a, u) => ({ input: a.input + u.input, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite, output: a.output + u.output }), zero());
  const t3Totals = sumU(t3Main);
  const transcriptTotals = sumU(results.map((r) => r.tokens));

  // Subagents (delegated through T3): priced at the model they actually ran on; identical on both sides.
  const subagents = exp.children.map((c) => {
    const model = c.thread.payload.modelSelection?.model ?? 'unknown';
    const usage = sumU(c.providerTurns.map((p) => t3Usage(p.payload.turnTokenUsage)).filter((u): u is Usage => !!u));
    const p = app.catalog?.pricing(model.replace(/^opencode\//, '').replace(/-free$/, '').replace(/\./g, '-'));
    const free = /-free$/.test(model);
    const usd = p && !free ? priceCall(usage, p, /claude/.test(model) ? 'anthropic' : 'other', false) : 0;
    return { title: c.thread.title, model, usage, usd };
  });
  const subagentUsd = subagents.reduce((a, x) => a + x.usd, 0);

  const summary = {
    turns: results.length,
    calls: total((r) => r.calls),
    actualUsd: total((r) => r.actualUsd),
    routedUsd: total((r) => r.routedUsd),
    jev: [...new Set(results.map((r) => r.decision.jevModel ?? r.decision.source))],
    avgJevLatencyMs: total((r) => r.decision.jevLatencyMs ?? 0) / Math.max(1, results.length),
    subagents,
    subagentUsd,
    crossCheck: { t3: t3Totals, transcript: transcriptTotals },
  };
  mkdirSync('bench/results', { recursive: true });
  writeFileSync(values.out!, JSON.stringify({ when: new Date().toISOString(), baseline: values.baseline, config: values.config, summary, turns: results }, null, 2));
  console.error(
    `\n${summary.turns} turns, ${summary.calls} API calls: actual (${values.baseline}) $${summary.actualUsd.toFixed(2)} → routed $${summary.routedUsd.toFixed(2)} ` +
      `(${(100 * (1 - summary.routedUsd / summary.actualUsd)).toFixed(0)}% less) · Jev ${summary.jev.join(', ')} avg ${summary.avgJevLatencyMs.toFixed(0)}ms\n` +
      `subagents (same on both sides): ${subagents.map((x) => `${x.title} [${x.model}] $${x.usd.toFixed(2)}`).join('; ')}\n` +
      `cross-check tokens (T3 runs vs transcript turns): cacheRead ${t3Totals.cacheRead} vs ${transcriptTotals.cacheRead}, ` +
      `cacheWrite ${t3Totals.cacheWrite} vs ${transcriptTotals.cacheWrite}, output ${t3Totals.output} vs ${transcriptTotals.output}\nwrote ${values.out}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
