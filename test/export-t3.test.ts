import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadExport, priceCall, readCalls, t3Usage, turnsFromExport } from '../bench/conversation.js';
import { envSecrets, exportT3, secretScrubber } from '../scripts/export-t3-thread.js';

const ROOT = 'thread-root';
const CHILD = 'thread:delegated-task:abc';
const SECRET = 'oc_sk_0123456789abcdef_SECRETSECRETSECRET';

/** A minimal T3 state DB with the projection tables the exporter reads. */
function fakeT3Db(): string {
  const dir = mkdtempSync(join(tmpdir(), 't3-'));
  const path = join(dir, 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    create table orchestration_v2_projection_threads (thread_id text primary key, project_id text, title text, created_at text, updated_at text, payload_json text);
    create table orchestration_v2_projection_runs (run_id text primary key, thread_id text, ordinal integer, status text, payload_json text);
    create table orchestration_v2_projection_provider_turns (provider_turn_id text primary key, thread_id text, ordinal integer, started_at text, payload_json text);
    create table orchestration_v2_projection_turn_items (turn_item_id text primary key, thread_id text, ordinal integer, type text, payload_json text);
  `);
  const ins = (sql: string, ...v: Array<string | number>) => db.prepare(sql).run(...v);
  ins('insert into orchestration_v2_projection_threads values (?,?,?,?,?,?)', ROOT, 'p', 'Root', 't', 't', JSON.stringify({ id: ROOT }));
  ins('insert into orchestration_v2_projection_threads values (?,?,?,?,?,?)', CHILD, 'p', 'Child', 't', 't', JSON.stringify({ lineage: { parent: ROOT }, modelSelection: { model: 'claude-haiku-5-5' } }));
  ins('insert into orchestration_v2_projection_runs values (?,?,?,?,?)', 'r1', ROOT, 1, 'completed', '{}');
  const usage = { inputTokens: 1000, cachedInputTokens: 700, cacheCreationTokens: 200, outputTokens: 50 };
  ins('insert into orchestration_v2_projection_provider_turns values (?,?,?,?,?)', 'pt1', ROOT, 1, '2026-01-01T00:00:00Z', JSON.stringify({ turnTokenUsage: usage }));
  ins('insert into orchestration_v2_projection_provider_turns values (?,?,?,?,?)', 'pt2', CHILD, 1, '2026-01-01T00:00:00Z', JSON.stringify({ turnTokenUsage: usage }));
  const item = (id: string, thread: string, ord: number, type: string, payload: object) =>
    ins('insert into orchestration_v2_projection_turn_items values (?,?,?,?,?)', id, thread, ord, type, JSON.stringify(payload));
  item('u2', ROOT, 3, 'user_message', { createdBy: 'user', startedAt: '2026-01-01T00:02:00Z', text: 'second' });
  item('u1', ROOT, 1, 'user_message', { createdBy: 'user', startedAt: '2026-01-01T00:00:00Z', text: `here is my key ${SECRET}` });
  item('a1', ROOT, 2, 'command_execution', { text: `$ grep ${SECRET.slice(0, 12)} .env` });
  item('c1', CHILD, 1, 'assistant_message', { text: 'child says hi' });
  db.close();
  return path;
}

describe('T3 full export', () => {
  it('exports root + child threads with every item in order, redacting secrets and fragments', () => {
    const exp = exportT3(fakeT3Db(), ROOT, [SECRET]);
    expect(exp.root.items.map((i) => i.turn_item_id)).toEqual(['u1', 'a1', 'u2']);
    expect(exp.children.map((c) => c.threadId)).toEqual([CHILD]);
    expect(exp.children[0]!.items).toHaveLength(1);
    const dump = JSON.stringify(exp);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(SECRET.slice(0, 12)); // fragment from a grep command
    expect(dump).toContain('[REDACTED]');
  });

  it('scrubber removes fragments of at least 6 chars and nothing shorter', () => {
    const scrub = secretScrubber(['abcdefghij']);
    expect(scrub('x abcdefghij y')).toBe('x [REDACTED] y');
    expect(scrub('x cdefgh y')).toBe('x [REDACTED] y');
    expect(scrub('x abcde y')).toBe('x abcde y');
  });

  it('reads secret values from dotenv by name', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'env-')), '.env');
    writeFileSync(f, 'JEV_API_KEY=abc123456\nCLOUDFLARE_AUTH_TOKEN="tok_987654321"\nJEV_LOCAL_URL=http://x\n');
    expect(envSecrets(f)).toEqual(['abc123456', 'tok_987654321']);
  });

  it('replay reads turns with full text, T3 usage, and gzipped exports', () => {
    const exp = exportT3(fakeT3Db(), ROOT, []);
    const f = join(mkdtempSync(join(tmpdir(), 'exp-')), 'e.json.gz');
    writeFileSync(f, gzipSync(JSON.stringify(exp)));
    const loaded = loadExport(f);
    const turns = turnsFromExport(loaded);
    expect(turns.map((t) => t.text)).toEqual([expect.stringContaining('here is my key'), 'second']);
    expect(t3Usage(loaded.root.providerTurns[0]!.payload.turnTokenUsage)).toEqual({ input: 100, cacheRead: 700, cacheWrite: 200, output: 50 });
    expect(t3Usage(undefined)).toBeUndefined();
  });
});

describe('replay pricing', () => {
  const p = { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 };
  const u = { input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 };
  it('a cold switch turns cache reads into (1h, 2x input) cache writes for Anthropic', () => {
    expect(priceCall(u, p, 'anthropic', false)).toBeCloseTo(0.2);
    expect(priceCall(u, p, 'anthropic', true)).toBeCloseTo(8);
    expect(priceCall(u, p, 'other', true)).toBeCloseTo(5);
  });

  it('transcript calls are deduped by message id and user texts extracted', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'tr-')), 's.jsonl');
    const usage = { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 };
    writeFileSync(
      f,
      [
        { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hello' } },
        { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', usage } },
        { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { id: 'm1', usage } },
        { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', message: { id: 'm2', usage } },
      ].map((x) => JSON.stringify(x)).join('\n'),
    );
    const { calls, userTexts } = readCalls(f);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
    expect(userTexts[0]!.text).toBe('hello');
  });
});
