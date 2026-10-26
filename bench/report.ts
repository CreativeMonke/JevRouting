// Render a benchmark result (bench/run.ts output) as an SVG dumbbell chart + markdown table.
//
//   npx tsx bench/report.ts bench/results/run1.json [--svg docs/cost-comparison.svg]
//
// Dumbbell on a log axis: per task, the baseline cost and the routed cost, joined.
// (Costs span ~4 orders of magnitude; bars on a log axis would misrepresent magnitude.)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { BenchRow } from './run.js';

interface Result {
  when: string;
  baseline: string;
  rows: BenchRow[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

export function summarize(r: Result) {
  const rows = r.rows.filter((x) => x.baseline && x.routed);
  const sum = (f: (x: BenchRow) => number) => rows.reduce((a, x) => a + f(x), 0);
  const base = sum((x) => x.baseline!.listUsd);
  const routed = sum((x) => x.routed!.listUsd);
  const routedMarginal = sum((x) => x.routed!.marginalUsd);
  return {
    n: rows.length,
    base,
    routed,
    routedMarginal,
    savings: base > 0 ? 1 - routed / base : 0,
    basePass: rows.filter((x) => x.baseline!.passed).length,
    routedPass: rows.filter((x) => x.routed!.passed).length,
    baseMs: sum((x) => x.baseline!.latencyMs),
    routedMs: sum((x) => x.routed!.latencyMs),
    rows,
  };
}

export function renderSvg(r: Result): string {
  const s = summarize(r);
  const W = 880;
  const left = 150;
  const right = 210;
  const top = 132;
  const rowH = 30;
  const plotW = W - left - right;
  const H = top + s.rows.length * rowH + 84;

  const vals = s.rows.flatMap((x) => [x.baseline!.listUsd, x.routed!.listUsd]).filter((v) => v > 0);
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...vals, 0.001))));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...vals, 0.01))));
  const x = (v: number) => left + ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * plotW;

  const ticks: number[] = [];
  for (let t = lo; t <= hi * 1.0001; t *= 10) ticks.push(t);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">`);
  out.push(`<title id="t">Cost per task: ${esc(r.baseline)} vs JevRouting</title>`);
  out.push(`<desc id="d">Across ${s.n} tasks, ${esc(r.baseline)} cost ${usd(s.base)} at API list prices and passed ${s.basePass}/${s.n}; JevRouting cost ${usd(s.routed)} and passed ${s.routedPass}/${s.n}.</desc>`);
  out.push(`<style>
  .bg{fill:#fcfcfb} .t1{fill:#0b0b0b} .t2{fill:#52514e} .t3{fill:#8a8984} .grid{stroke:#e6e5e1} .axis{stroke:#c9c8c2}
  .base{fill:#eb6834} .route{fill:#2a78d6} .link{stroke:#b9b8b2} .ring{stroke:#fcfcfb}
  .hero{font-size:28px;font-weight:650} .lab{font-size:12px} .small{font-size:11px}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19} .t1{fill:#f0efec} .t2{fill:#c3c2b7} .t3{fill:#8f8e86} .grid{stroke:#2c2c2a} .axis{stroke:#4a4a46}
    .base{fill:#d95926} .route{fill:#3987e5} .link{stroke:#5a5a55} .ring{stroke:#1a1a19}
  }
</style>`);
  out.push(`<rect class="bg" width="${W}" height="${H}" rx="8"/>`);

  // Headline numbers
  out.push(`<text class="t2 lab" x="24" y="30">Cost per task at API list prices · ${s.n} auto-checked coding tasks · ${esc(r.when.slice(0, 10))}</text>`);
  const hero = (hx: number, big: string, label: string, cls = 't1') =>
    out.push(`<text class="${cls} hero" x="${hx}" y="72">${esc(big)}</text><text class="t2 lab" x="${hx}" y="92">${esc(label)}</text>`);
  hero(24, usd(s.base), `${r.baseline} · ${s.basePass}/${s.n} passed`);
  hero(250, usd(s.routed), `JevRouting · ${s.routedPass}/${s.n} passed`);
  hero(476, `−${Math.round(s.savings * 100)}%`, 'cost vs baseline');
  hero(660, `${(s.routedMs / Math.max(1, s.baseMs)).toFixed(2)}×`, 'wall time vs baseline');

  // Legend (two series, also direct-labeled on the first row)
  const ly = 116;
  out.push(`<circle class="base" cx="${left}" cy="${ly - 4}" r="5"/><text class="t2 lab" x="${left + 10}" y="${ly}">${esc(r.baseline)}</text>`);
  out.push(`<circle class="route" cx="${left + 170}" cy="${ly - 4}" r="5"/><text class="t2 lab" x="${left + 180}" y="${ly}">JevRouting (model@effort it picked)</text>`);

  // Grid + axis
  for (const t of ticks) {
    const gx = x(t);
    out.push(`<line class="grid" x1="${gx}" x2="${gx}" y1="${top - 6}" y2="${top + s.rows.length * rowH}"/>`);
    out.push(`<text class="t3 small" x="${gx}" y="${top + s.rows.length * rowH + 18}" text-anchor="middle">${usd(t)}</text>`);
  }
  out.push(`<text class="t3 small" x="${left + plotW / 2}" y="${top + s.rows.length * rowH + 38}" text-anchor="middle">USD per task (log scale)</text>`);

  s.rows.forEach((row, i) => {
    const cy = top + i * rowH + rowH / 2;
    const b = row.baseline!;
    const ro = row.routed!;
    const bx = x(b.listUsd);
    const rx = x(ro.listUsd);
    out.push(`<text class="t1 lab" x="${left - 12}" y="${cy + 4}" text-anchor="end">${esc(row.task)}</text>`);
    out.push(`<line class="link" x1="${Math.min(bx, rx)}" x2="${Math.max(bx, rx)}" y1="${cy}" y2="${cy}" stroke-width="2"/>`);
    const dot = (cx: number, cls: string, tip: string, passed: boolean) =>
      out.push(`<g><title>${esc(tip)}</title><circle class="${cls} ring" cx="${cx}" cy="${cy}" r="6" stroke-width="2"/>${passed ? '' : `<text class="t1 small" x="${cx}" y="${cy - 9}" text-anchor="middle">✗</text>`}</g>`);
    dot(bx, 'base', `${row.task} — ${r.baseline}: ${usd(b.listUsd)}, ${b.passed ? 'passed' : 'failed'}, ${(b.latencyMs / 1000).toFixed(1)}s`, b.passed);
    dot(rx, 'route', `${row.task} — ${ro.providerId}@${ro.effort}: ${usd(ro.listUsd)} list (${usd(ro.marginalUsd)} marginal), ${ro.passed ? 'passed' : 'failed'}, ${(ro.latencyMs / 1000).toFixed(1)}s`, ro.passed);
    out.push(`<text class="t2 small" x="${W - right + 16}" y="${cy + 4}">${esc(`${ro.providerId}@${ro.effort}`)} · ${usd(ro.listUsd)}</text>`);
  });
  out.push(`<text class="t3 small" x="24" y="${H - 26}">✗ = failed the task's automatic check. Both sides run through the same agent CLIs from an empty directory.</text>`);
  out.push(`<text class="t3 small" x="24" y="${H - 11}">Costs are CLI-reported (API-equivalent) where available, else tokens × catalog prices. Routed wall time includes the Jev call.</text>`);
  out.push('</svg>');
  return out.join('\n');
}

export function renderTable(r: Result): string {
  const s = summarize(r);
  const lines = [
    `| Task | Expected | ${r.baseline} | Routed to | Routed cost | Pass (base / routed) |`,
    '|---|---|---:|---|---:|:---:|',
    ...s.rows.map((x) => `| ${x.task} | ${x.expected} | ${usd(x.baseline!.listUsd)} | ${x.routed!.providerId}@${x.routed!.effort} (Jev L${x.routed!.assessment.level}) | ${usd(x.routed!.listUsd)} | ${x.baseline!.passed ? '✅' : '❌'} / ${x.routed!.passed ? '✅' : '❌'} |`),
    `| **Total** | | **${usd(s.base)}** | | **${usd(s.routed)}** (−${Math.round(s.savings * 100)}%) | ${s.basePass}/${s.n} / ${s.routedPass}/${s.n} |`,
  ];
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { svg: { type: 'string', default: 'docs/cost-comparison.svg' }, readme: { type: 'string' } },
  });
  const file = positionals[0];
  if (!file) throw new Error('usage: report.ts <result.json>');
  const r = JSON.parse(readFileSync(file, 'utf8')) as Result;
  mkdirSync(dirname(values.svg!), { recursive: true });
  writeFileSync(values.svg!, renderSvg(r));
  const table = renderTable(r);
  console.log(table);
  console.error(`wrote ${values.svg}`);
  if (values.readme) {
    const md = readFileSync(values.readme, 'utf8');
    const block = `<!-- BENCH-TABLE:START -->\n${table}\n<!-- BENCH-TABLE:END -->`;
    writeFileSync(values.readme, md.replace(/<!-- BENCH-TABLE:START -->[\s\S]*?<!-- BENCH-TABLE:END -->/, block));
    console.error(`updated ${values.readme}`);
  }
}
