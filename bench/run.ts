// Benchmark: baseline (one pinned provider+effort, default Opus 5.5 @ medium) vs the router,
// on bench/tasks.ts. Writes bench/results/<stamp>.json; render with bench/report.ts.
//
//   npx tsx bench/run.ts --config examples/cli.config.yaml [--baseline claude-opus@medium] [--only id,id] [--skip-baseline]

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app.js';
import { estimateTokens } from '../src/router/state.js';
import type { CompletionResult, Effort } from '../src/providers/types.js';
import type { App } from '../src/app.js';
import { TASKS, type BenchTask } from './tasks.js';

export interface BenchRun {
  providerId: string;
  effort: string;
  ok: boolean;
  passed: boolean;
  latencyMs: number;
  /** What you actually pay at the margin (subscription/free = 0 unless the CLI reports a cost). */
  marginalUsd: number;
  /** API-list-price equivalent (CLI-reported cost when available, else tokens x catalog prices). */
  listUsd: number;
  costSource: 'reported' | 'estimated' | 'none';
  error?: string;
  chars: number;
}

export interface BenchRow {
  task: string;
  expected: BenchTask['expected'];
  baseline?: BenchRun;
  routed?: BenchRun & { assessment: { source: string; level: number; required: number; kind: string } };
}

function listCost(app: App, providerId: string, r: CompletionResult, prompt: string): { usd: number; source: BenchRun['costSource'] } {
  if (r.costUsd !== undefined) return { usd: r.costUsd, source: 'reported' };
  const p = app.config.providers[providerId];
  const pricing = p?.pricing ?? (p && app.catalog?.pricing(p.catalogId ?? p.model));
  if (!pricing) return { usd: 0, source: 'none' };
  const inTok = r.usage?.inputTokens ?? estimateTokens(prompt) + 2000; // + agent system prompt
  const outTok = r.usage?.outputTokens ?? estimateTokens(r.text);
  return { usd: (inTok * pricing.input + outTok * pricing.output) / 1e6, source: 'estimated' };
}

function marginal(app: App, providerId: string, list: number, reported: boolean): number {
  const billing = app.config.providers[providerId]?.billing ?? 'metered';
  if (billing === 'free') return 0;
  // Subscription CLIs (Claude Code) report API-equivalent cost; that's the quota burned, so count it.
  return billing === 'subscription' && !reported ? 0 : list;
}

async function runBaseline(app: App, t: BenchTask, providerId: string, effort: Effort, cwd: string): Promise<BenchRun> {
  const provider = app.providers.get(providerId);
  if (!provider) throw new Error(`baseline provider ${providerId} not configured`);
  const started = Date.now();
  try {
    const r = await provider.complete({ messages: [{ role: 'user', content: t.prompt }], effort, cwd, timeoutMs: 300_000 });
    const c = listCost(app, providerId, r, t.prompt);
    return {
      providerId, effort, ok: true, passed: t.check(r.text), latencyMs: r.latencyMs,
      listUsd: c.usd, marginalUsd: marginal(app, providerId, c.usd, c.source === 'reported'), costSource: c.source, chars: r.text.length,
    };
  } catch (err) {
    return { providerId, effort, ok: false, passed: false, latencyMs: Date.now() - started, listUsd: 0, marginalUsd: 0, costSource: 'none', error: String(err), chars: 0 };
  }
}

async function runRouted(app: App, t: BenchTask, cwd: string): Promise<NonNullable<BenchRow['routed']>> {
  const started = Date.now();
  const res = await app.router.run({ prompt: t.prompt, sessionId: `bench-${t.id}` }, { approve: true, cwd });
  const a = res.decision.assessment;
  const assessment = { source: a.source, level: a.level, required: a.requiredIntelligence, kind: a.kind };
  const last = res.attempts.at(-1);
  if (!res.result || !last) {
    return {
      providerId: last?.providerId ?? 'none', effort: last?.effort ?? '-', ok: false, passed: false, latencyMs: Date.now() - started,
      listUsd: 0, marginalUsd: 0, costSource: 'none', error: res.attempts.map((x) => x.error).join(' | '), chars: 0, assessment,
    };
  }
  const c = listCost(app, last.providerId, res.result, t.prompt);
  return {
    providerId: last.providerId, effort: last.effort, ok: true, passed: t.check(res.result.text), latencyMs: Date.now() - started,
    listUsd: c.usd, marginalUsd: marginal(app, last.providerId, c.usd, c.source === 'reported'), costSource: c.source,
    chars: res.result.text.length, assessment,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'examples/cli.config.yaml' },
      baseline: { type: 'string', default: 'claude-opus@medium' },
      only: { type: 'string' },
      'skip-baseline': { type: 'boolean' },
      'skip-routed': { type: 'boolean' },
      /** Reuse baseline runs from an earlier result file instead of re-running them. */
      'baseline-from': { type: 'string' },
      out: { type: 'string' },
    },
  });
  const [bp, be = 'medium'] = values.baseline!.split('@');
  const app = await buildApp({ configPath: values.config, ephemeral: true });
  const only = values.only?.split(',');
  const tasks = TASKS.filter((t) => !only || only.includes(t.id));
  // Empty working dir: no project CLAUDE.md / AGENTS.md leaking into either side.
  const cwd = mkdtempSync(join(tmpdir(), 'jev-bench-'));
  const rows: BenchRow[] = [];
  const prior = values['baseline-from']
    ? new Map((JSON.parse(readFileSync(values['baseline-from'], 'utf8')).rows as BenchRow[]).map((r) => [r.task, r.baseline]))
    : undefined;

  for (const t of tasks) {
    const row: BenchRow = { task: t.id, expected: t.expected };
    if (prior?.get(t.id)) row.baseline = prior.get(t.id);
    else if (!values['skip-baseline']) row.baseline = await runBaseline(app, t, bp!, be as Effort, cwd);
    if (!values['skip-routed']) row.routed = await runRouted(app, t, cwd);
    rows.push(row);
    const b = row.baseline, r = row.routed;
    console.error(
      `${t.id.padEnd(18)} base ${b ? `${b.passed ? 'PASS' : 'fail'} $${b.listUsd.toFixed(4)}` : '-'}  ` +
        `routed ${r ? `${r.passed ? 'PASS' : 'fail'} ${r.providerId}@${r.effort} list $${r.listUsd.toFixed(4)} marginal $${r.marginalUsd.toFixed(4)} [${r.assessment.source} L${r.assessment.level}]` : '-'}` +
        `${r?.error ? ` ERR ${r.error.slice(0, 120)}` : ''}${b?.error ? ` BASE-ERR ${b.error.slice(0, 120)}` : ''}`,
    );
  }

  mkdirSync('bench/results', { recursive: true });
  const out = values.out ?? `bench/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), config: values.config, baseline: values.baseline, catalog: app.catalogInfo, rows }, null, 2));
  console.error(`wrote ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
