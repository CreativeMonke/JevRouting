#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApp } from './app.js';
import type { Effort } from './providers/types.js';
import type { RoutingDecision, TaskInput } from './router/types.js';
import { createJevServer } from './server.js';

const HELP = `jev — cost/intelligence-aware model router (Jev System One + Slopalytics catalog)

Usage:
  jev route  [options] <prompt...>     classify, pick a model+effort, run it, print the answer
  jev decide [options] <prompt...>     classify and print the routing plan only (no model call)
  jev serve  [--port 4100] [--host 127.0.0.1]
                                       OpenAI-compatible proxy: POST /v1/chat/completions (model "jev-auto")
  jev catalog [refresh|show] [--family <slug>]
  jev providers                        list configured providers

Options:
  -c, --config <file>     config file (default: $JEV_CONFIG, ./jev.config.yaml, ~/.config/jev-routing/config.yaml)
  -s, --session <id>      session id (enables cache-aware stickiness across calls)
  -p, --provider <id>     force a provider
  -e, --effort <level>    force an effort (low|medium|high|xhigh|max)
      --facts <json>      deterministic facts, e.g. '{"diffLines":420,"consecutiveTestFailures":2}'
      --stdin             read the prompt from stdin
      --approve           run even if the task is flagged high risk
      --json              machine-readable output
      --no-refresh        never refresh the catalog from the network
  -h, --help
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fmtUsd(n: number) {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

function printDecision(d: RoutingDecision) {
  const a = d.assessment;
  const err = a.jev?.error ? ` (Jev unavailable: ${a.jev.error})` : a.jev ? ` (${a.jev.model}, ${a.jev.latencyMs}ms)` : '';
  console.error(
    `assessment: ${a.source}${err}\n` +
      `  kind=${a.kind} level=${a.level} needs I≥${a.requiredIntelligence} risk=${a.risk.toFixed(2)} ` +
      `agentic=${a.agentic.toFixed(2)} history=${a.needsHistory.toFixed(2)}${a.requireApproval ? ' APPROVAL REQUIRED' : ''}`,
  );
  for (const adj of a.adjustments) console.error(`  · ${adj}`);
  console.error('candidates:');
  for (const c of d.candidates.slice(0, 8)) {
    console.error(
      `  ${c.eligible ? '✓' : '✗'} ${`${c.providerId}@${c.effort}`.padEnd(30)} I=${c.intelligence.toFixed(1).padStart(4)} ` +
        `p=${c.pSuccess.toFixed(2)} cost=${fmtUsd(c.attemptCost).padStart(8)} (list ${fmtUsd(c.listCost)}) ` +
        `~${c.expectedMinutes.toFixed(1)}min${c.cacheWarm ? ' warm' : ''}${!c.eligible && c.reasons.length ? ` — ${c.reasons.join('; ')}` : ''}`,
    );
  }
  console.error(`plan: ${d.plan.map((p) => `${p.providerId}@${p.effort}`).join(' → ')}${d.pruneContext ? ' (history pruned)' : ''}`);
}

async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      session: { type: 'string', short: 's' },
      provider: { type: 'string', short: 'p' },
      effort: { type: 'string', short: 'e' },
      facts: { type: 'string' },
      stdin: { type: 'boolean' },
      approve: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-refresh': { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      family: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }

  const app = await buildApp({
    configPath: values.config,
    catalogRefresh: cmd === 'catalog' && rest[0] === 'refresh' ? 'force' : values['no-refresh'] ? 'never' : 'auto',
  });
  for (const w of app.catalogInfo?.warnings ?? []) console.error(`catalog: ${w}`);

  switch (cmd) {
    case 'route':
    case 'decide': {
      const prompt = values.stdin ? await readStdin() : rest.join(' ');
      if (!prompt.trim()) throw new Error('empty prompt');
      const task: TaskInput = {
        prompt,
        sessionId: values.session,
        forceProvider: values.provider,
        forceEffort: values.effort as Effort | undefined,
        facts: values.facts ? JSON.parse(values.facts) : undefined,
      };
      if (cmd === 'decide') {
        const d = await app.router.decide(task);
        if (values.json) console.log(JSON.stringify(d, null, 2));
        else printDecision(d);
        return;
      }
      const r = await app.router.run(task, { approve: values.approve, cwd: process.cwd() });
      if (values.json) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        printDecision(r.decision);
        for (const at of r.attempts) {
          console.error(`attempt ${at.providerId}@${at.effort}: ${at.ok ? `ok (${at.latencyMs}ms)` : `failed — ${at.error}`}`);
        }
        if (r.needsApproval) console.error('Task flagged high risk. Re-run with --approve to execute.');
        if (r.result) console.log(r.result.text);
      }
      if (!r.result) process.exitCode = r.needsApproval ? 3 : 2;
      return;
    }
    case 'serve': {
      const port = Number(values.port ?? process.env.JEV_PORT ?? 4100);
      const host = values.host ?? process.env.JEV_HOST ?? '127.0.0.1';
      const server = createJevServer({
        router: app.router,
        providerIds: [...app.providers.keys()],
        // Empty JEV_SERVER_KEY is rejected by createJevServer rather than silently disabling auth.
        apiKey: process.env.JEV_SERVER_KEY,
      });
      server.listen(port, host, () => {
        console.error(`jev proxy on http://${host}:${port}/v1 (model "jev-auto"; providers: ${[...app.providers.keys()].join(', ')})`);
        console.error(`catalog: ${app.catalogInfo?.origin ?? 'disabled'}`);
      });
      return;
    }
    case 'catalog': {
      if (!app.catalog) throw new Error('catalog disabled in config');
      const info = app.catalogInfo;
      if (values.family) {
        console.log(JSON.stringify({ variants: app.catalog.variants(values.family), pricing: app.catalog.pricing(values.family), usage: app.catalog.usage(values.family) }, null, 2));
        return;
      }
      console.log(`origin=${info?.origin} age=${info?.ageHours?.toFixed(1) ?? '?'}h`);
      for (const [id, p] of Object.entries(app.config.providers)) {
        const fam = p.catalogId ?? p.model;
        const vs = app.catalog.variants(fam);
        console.log(`  ${id.padEnd(26)} ${fam.padEnd(24)} ${vs.length ? vs.map((v) => `${v.effort}:${v.intelligence?.toFixed(1)}/$${v.costPerTask?.toFixed(3) ?? '?'}`).join(' ') : '(no catalog data)'}`);
      }
      return;
    }
    case 'providers': {
      for (const [id, p] of Object.entries(app.config.providers)) {
        console.log(`${p.enabled ? '●' : '○'} ${id.padEnd(26)} ${p.kind.padEnd(8)} ${p.model.padEnd(36)} ${p.billing}`);
      }
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});

