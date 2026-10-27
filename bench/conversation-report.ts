// Render bench/conversation.ts output: cumulative cost over the conversation (actual vs routed)
// as an SVG line chart, plus a per-turn markdown table.
//
//   npx tsx bench/conversation-report.ts bench/results/conversation.json [--svg docs/conversation-replay.svg] [--readme README.md]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { TurnResult } from './conversation.js';

interface Result {
  when: string;
  baseline: string;
  summary: { turns: number; calls: number; actualUsd: number; routedUsd: number; avgJevLatencyMs: number };
  turns: TurnResult[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(2)}`);

export function renderSvg(r: Result): string {
  const W = 880;
  const H = 470;
  const left = 64;
  const right = 150;
  const top = 128;
  const bottom = 70;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const n = r.turns.length;

  let ca = 0;
  let cr = 0;
  const pts = r.turns.map((t) => ({ t, a: (ca += t.actualUsd), r: (cr += t.routedUsd) }));
  const maxY = Math.max(ca, cr);
  const step = maxY > 20 ? 5 : maxY > 8 ? 2 : 1;
  const yMax = Math.ceil(maxY / step) * step;
  const x = (i: number) => left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const path = (key: 'a' | 'r') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
  const s = r.summary;
  const saved = 1 - s.routedUsd / s.actualUsd;

  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">`);
  o.push(`<title id="t">This conversation, replayed through JevRouting</title>`);
  o.push(`<desc id="d">${s.turns} user turns and ${s.calls} API calls. Actual cost on ${esc(r.baseline)}: ${usd(s.actualUsd)}. Routed with the same tokens: ${usd(s.routedUsd)}.</desc>`);
  o.push(`<style>
  .bg{fill:#fcfcfb} .t1{fill:#0b0b0b} .t2{fill:#52514e} .t3{fill:#8a8984} .grid{stroke:#e6e5e1}
  .base{stroke:#eb6834} .route{stroke:#2a78d6} .baseF{fill:#eb6834} .routeF{fill:#2a78d6} .ring{stroke:#fcfcfb}
  .hero{font-size:28px;font-weight:650} .lab{font-size:12px} .small{font-size:11px}
  @media (prefers-color-scheme: dark){
    .bg{fill:#1a1a19} .t1{fill:#f0efec} .t2{fill:#c3c2b7} .t3{fill:#8f8e86} .grid{stroke:#2c2c2a}
    .base{stroke:#d95926} .route{stroke:#3987e5} .baseF{fill:#d95926} .routeF{fill:#3987e5} .ring{stroke:#1a1a19}
  }
</style>`);
  o.push(`<rect class="bg" width="${W}" height="${H}" rx="8"/>`);
  o.push(`<text class="t2 lab" x="24" y="30">This conversation (the overnight build of this repo), replayed turn by turn · same tokens, re-priced · Jev = local Clef</text>`);
  const hero = (hx: number, big: string, label: string) =>
    o.push(`<text class="t1 hero" x="${hx}" y="72">${esc(big)}</text><text class="t2 lab" x="${hx}" y="92">${esc(label)}</text>`);
  hero(24, usd(s.actualUsd), `actual · ${r.baseline}`);
  hero(230, usd(s.routedUsd), 'routed by JevRouting');
  hero(436, `−${Math.round(saved * 100)}%`, 'cost');
  hero(600, `${s.turns} / ${s.calls}`, 'user turns / API calls');

  for (let v = 0; v <= yMax + 1e-9; v += step) {
    o.push(`<line class="grid" x1="${left}" x2="${left + plotW}" y1="${y(v)}" y2="${y(v)}"/>`);
    o.push(`<text class="t3 small" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">$${v}</text>`);
  }
  pts.forEach((_, i) => {
    if (i % 2 === 0 || i === n - 1) o.push(`<text class="t3 small" x="${x(i)}" y="${top + plotH + 18}" text-anchor="middle">${i + 1}</text>`);
  });
  o.push(`<text class="t3 small" x="${left + plotW / 2}" y="${top + plotH + 36}" text-anchor="middle">user turn → cumulative USD (API list prices)</text>`);

  o.push(`<path class="base" d="${path('a')}" fill="none" stroke-width="2"/>`);
  o.push(`<path class="route" d="${path('r')}" fill="none" stroke-width="2"/>`);
  pts.forEach((p, i) => {
    const tip = `#${p.t.turn} "${p.t.prompt.slice(0, 70)}" · ${p.t.calls} calls → ${p.t.decision.providerId}@${p.t.decision.effort} (${p.t.decision.source}, L${p.t.decision.level}) · actual ${usd(p.t.actualUsd)} vs routed ${usd(p.t.routedUsd)}${p.t.switched ? ' · cold switch' : ''}`;
    o.push(`<g><title>${esc(tip)}</title><circle class="baseF ring" cx="${x(i)}" cy="${y(p.a)}" r="4" stroke-width="2"/><circle class="routeF ring" cx="${x(i)}" cy="${y(p.r)}" r="4" stroke-width="2"/><rect x="${x(i) - 10}" y="${top}" width="20" height="${plotH}" fill="transparent"/></g>`);
  });
  const last = pts.at(-1)!;
  o.push(`<text class="t1 lab" x="${x(n - 1) + 10}" y="${y(last.a) + 4}">${esc(r.baseline)} ${usd(last.a)}</text>`);
  o.push(`<text class="t1 lab" x="${x(n - 1) + 10}" y="${y(last.r) + 4}">JevRouting ${usd(last.r)}</text>`);
  o.push(`<line class="base" x1="${left}" x2="${left + 18}" y1="112" y2="112" stroke-width="2"/><text class="t2 lab" x="${left + 24}" y="116">actual (${esc(r.baseline)})</text>`);
  o.push(`<line class="route" x1="${left + 190}" x2="${left + 208}" y1="112" y2="112" stroke-width="2"/><text class="t2 lab" x="${left + 214}" y="116">routed (same tokens, routed model's prices; model switches pay a cold cache write)</text>`);
  o.push(`<text class="t3 small" x="24" y="${H - 12}">Upper bound on savings: assumes the routed model would have used the same tokens and succeeded. Hover a turn for its decision.</text>`);
  o.push('</svg>');
  return o.join('\n');
}

export function renderTable(r: Result): string {
  const rows = r.turns.map(
    (t) =>
      `| ${t.turn} | ${t.prompt.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 60)}… | ${t.calls} | ${t.decision.source === 'jev' ? `Clef L${t.decision.level}` : `heuristic L${t.decision.level}`} | ${t.decision.providerId}@${t.decision.effort}${t.switched ? ' ↺' : ''} | ${usd(t.actualUsd)} | ${usd(t.routedUsd)} |`,
  );
  const s = r.summary;
  return [
    `| # | User turn | API calls | Jev | Routed to | Actual (${r.baseline}) | Routed |`,
    '|---:|---|---:|---|---|---:|---:|',
    ...rows,
    `| | **Total** | **${s.calls}** | | | **${usd(s.actualUsd)}** | **${usd(s.routedUsd)}** (−${Math.round(100 * (1 - s.routedUsd / s.actualUsd))}%) |`,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { svg: { type: 'string', default: 'docs/conversation-replay.svg' }, readme: { type: 'string' } },
  });
  const r = JSON.parse(readFileSync(positionals[0] ?? 'bench/results/conversation.json', 'utf8')) as Result;
  mkdirSync(dirname(values.svg!), { recursive: true });
  writeFileSync(values.svg!, renderSvg(r));
  const table = renderTable(r);
  console.log(table);
  if (values.readme) {
    const md = readFileSync(values.readme, 'utf8');
    const block = `<!-- CONVERSATION-TABLE:START -->\n${table}\n<!-- CONVERSATION-TABLE:END -->`;
    writeFileSync(values.readme, md.replace(/<!-- CONVERSATION-TABLE:START -->[\s\S]*?<!-- CONVERSATION-TABLE:END -->/, block));
    console.error(`updated ${values.readme}`);
  }
}
