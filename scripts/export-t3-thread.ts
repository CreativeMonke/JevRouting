#!/usr/bin/env -S npx tsx
// Export a T3 Code thread *in full* from T3's local state DB (read-only): thread metadata,
// runs, provider turns (with T3's own per-turn token usage), every turn item with its complete
// payload (messages, reasoning, tool calls and results, file changes...), and the same for
// every child thread (delegated subagents). All strings pass through redact().
//
//   npx tsx scripts/export-t3-thread.ts <threadId> [--db ~/.t3/userdata/statev2.sqlite] [--out file.json.gz]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { redact } from '../src/router/state.js';

export interface ExportedThread {
  threadId: string;
  thread: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  providerTurns: Array<Record<string, unknown>>;
  items: Array<Record<string, unknown>>;
}

export interface T3Export {
  exportedAt: string;
  source: string;
  root: ExportedThread;
  children: ExportedThread[];
}

/**
 * Build a scrubber for known secret values (e.g. from .env): removes each value and every
 * fragment of it of at least `minLen` (6) chars, so partial pastes (a grep for a key prefix) go too.
 */
export function secretScrubber(secrets: string[], minLen = 6): (s: string) => string {
  const frags = new Set<string>();
  for (const sec of secrets.filter((x) => x.length >= minLen)) {
    for (let i = 0; i + minLen <= sec.length; i++) for (let j = i + minLen; j <= sec.length; j++) frags.add(sec.slice(i, j));
  }
  // Longest first so a full key is replaced before its fragments.
  const ordered = [...frags].sort((a, b) => b.length - a.length);
  if (!ordered.length) return (s) => s;
  const re = new RegExp(ordered.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return (s) => s.replace(re, '[REDACTED]');
}

/** Secret-looking values from a dotenv file (KEY/TOKEN/SECRET/PASSWORD names). */
export function envSecrets(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => /^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(l)?.[2]?.replace(/^['"]|['"]$/g, ''))
    .filter((v): v is string => !!v);
}

/** Deep-redact every string in a JSON value. */
export function redactDeep<T>(v: T, scrub: (s: string) => string = (s) => s): T {
  if (typeof v === 'string') return scrub(redact(v)) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, scrub)) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, scrub)])) as T;
  }
  return v;
}

const parse = (s: unknown) => (typeof s === 'string' ? JSON.parse(s) : s);

function exportThread(db: DatabaseSync, threadId: string): ExportedThread {
  const t = db.prepare('select * from orchestration_v2_projection_threads where thread_id = ?').get(threadId) as Record<string, unknown> | undefined;
  if (!t) throw new Error(`thread ${threadId} not found`);
  const runs = db.prepare('select * from orchestration_v2_projection_runs where thread_id = ? order by ordinal').all(threadId);
  const providerTurns = db
    .prepare('select * from orchestration_v2_projection_provider_turns where thread_id = ? order by started_at, ordinal')
    .all(threadId);
  const items = db.prepare('select * from orchestration_v2_projection_turn_items where thread_id = ? order by ordinal, turn_item_id').all(threadId);
  const row = (r: Record<string, unknown>) => {
    const { payload_json, ...cols } = r;
    return { ...cols, payload: parse(payload_json) };
  };
  return {
    threadId,
    thread: row(t),
    runs: (runs as Array<Record<string, unknown>>).map(row),
    providerTurns: (providerTurns as Array<Record<string, unknown>>).map(row),
    items: (items as Array<Record<string, unknown>>).map(row),
  };
}

/** Child threads are the ones whose lineage/payload mentions the parent id. */
function childIds(db: DatabaseSync, parentId: string): string[] {
  const rows = db
    .prepare("select thread_id from orchestration_v2_projection_threads where thread_id != ? and payload_json like '%' || ? || '%'")
    .all(parentId, parentId) as Array<{ thread_id: string }>;
  return rows.map((r) => r.thread_id);
}

export function exportT3(dbPath: string, threadId: string, secrets: string[] = []): T3Export {
  const scrub = secretScrubber(secrets);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return redactDeep(
      {
      exportedAt: new Date().toISOString(),
      source: `T3 Code state DB (${dbPath.replace(homedir(), '~')})`,
      root: exportThread(db, threadId),
      children: childIds(db, threadId).map((id) => exportThread(db, id)),
      },
      scrub,
    );
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: join(homedir(), '.t3/userdata/statev2.sqlite') },
      out: { type: 'string', default: 'bench/conversation/t3-thread-full.json.gz' },
      /** dotenv files whose secret values (and fragments) are scrubbed from the export. */
      env: { type: 'string', default: '.env' },
    },
  });
  const id = positionals[0];
  if (!id) throw new Error('usage: export-t3-thread.ts <threadId>');
  const secrets = values.env!.split(',').flatMap(envSecrets);
  const exp = exportT3(values.db!, id, secrets);
  const json = JSON.stringify(exp);
  writeFileSync(values.out!, values.out!.endsWith('.gz') ? gzipSync(json) : json);
  const count = (t: ExportedThread) => `${t.items.length} items, ${t.runs.length} runs, ${t.providerTurns.length} provider turns`;
  console.error(`root ${id}: ${count(exp.root)}`);
  for (const c of exp.children) console.error(`child ${c.threadId.slice(-40)}: ${count(c)}`);
  console.error(`wrote ${values.out} (${(json.length / 1e6).toFixed(1)} MB raw)`);
}
