// Agent Client Protocol (ACP) provider: JSON-RPC 2.0 over an agent's stdio.
// Works with any ACP agent; the `antigravity` preset uses the agy ACP server T3 Code bundles,
// which reuses T3's Google session (the bare `agy` CLI may still demand a browser sign-in).
//
// Flow per completion: initialize -> authenticate (optional) -> session/new ->
// session/set_config_option (model) -> session/prompt, collecting agent_message_chunk text.

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpProviderConfig } from '../config/schema.js';
import { flattenPrompt } from './cli.js';
import { describeError, startDeadline } from './deadline.js';
import { normalizeEffort, resolveFamily } from './effort.js';
import { ProviderError, type CompletionRequest, type CompletionResult, type Provider } from './types.js';

const DEFAULT_TIMEOUT_MS = 300_000;

export type AcpSpawn = (command: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

const defaultSpawn: AcpSpawn = (command, args, opts) => nodeSpawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });

/** Newest agy ACP server bundled with T3 Code (override with AGY_ACP_SERVER). */
export function findAntigravityAcpServer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AGY_ACP_SERVER) return env.AGY_ACP_SERVER;
  const base = join(homedir(), '.t3/tools/antigravity-acp', `${process.platform}-${process.arch}`, 'versions');
  try {
    return readdirSync(base)
      .map((v) => join(base, v, 'agy_acp_server.par'))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

interface Rpc {
  request(method: string, params: unknown): Promise<any>;
  close(): void;
}

/** Minimal newline-delimited JSON-RPC client. Agent->client requests (permissions, fs) are declined. */
function rpc(child: ChildProcessWithoutNullStreams, onUpdate: (u: any) => void): Rpc {
  let buf = '';
  let nextId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const fail = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === 'session/update') {
        onUpdate(msg.params?.update);
      } else if (msg.method && msg.id !== undefined) {
        // We run headless: never grant tool permissions or file access.
        const result = msg.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : null;
        const reply = result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } };
        child.stdin.write(`${JSON.stringify(reply)}\n`);
      }
    }
  });
  child.on('exit', (code) => fail(new Error(`ACP agent exited (code ${code})`)));
  child.on('error', (e) => fail(e));
  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

export class AcpProvider implements Provider {
  readonly kind = 'acp';
  readonly family: string;
  readonly model: string;
  private readonly spawnFn: AcpSpawn;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly id: string,
    private readonly cfg: AcpProviderConfig,
    deps: { spawn?: AcpSpawn; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.model = cfg.model;
    this.family = resolveFamily(cfg);
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.env = { ...(deps.env ?? process.env), ...cfg.env };
  }

  private command(): { command: string; args: string[]; authMethod?: string } {
    if (this.cfg.command) return { command: this.cfg.command, args: this.cfg.args ?? [], authMethod: this.cfg.authMethod };
    if (this.cfg.preset === 'antigravity') {
      const server = findAntigravityAcpServer(this.env);
      if (!server) throw new ProviderError('antigravity ACP server not found (install T3 Code or set AGY_ACP_SERVER)', this.id, false);
      return { command: server, args: this.cfg.args ?? [], authMethod: this.cfg.authMethod ?? 'oauth-personal' };
    }
    throw new ProviderError('acp provider needs `command` or a preset', this.id, false);
  }

  /** Model id for this effort: `model` may contain {effort}, e.g. gemini-3.8-flash-{effort}. */
  modelFor(effort: CompletionRequest['effort']): string {
    const e = normalizeEffort(effort, this.cfg) ?? 'medium';
    return this.model.replace('{effort}', e);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const { command, args, authMethod } = this.command();
    const deadline = startDeadline(this.id, req.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.signal);
    let text = '';
    let usedTokens: number | undefined;
    const child = this.spawnFn(command, args, { cwd: req.cwd, env: this.env });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr = (stderr + d).slice(-2000)));
    const client = rpc(child, (u) => {
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text;
      if (u?.sessionUpdate === 'usage_update' && typeof u.used === 'number') usedTokens = u.used;
    });
    const aborted = new Promise<never>((_, reject) =>
      deadline.signal.addEventListener('abort', () => reject(deadline.abortError()), { once: true }),
    );
    const model = this.modelFor(req.effort);
    try {
      const run = async () => {
        await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        if (authMethod) await client.request('authenticate', { methodId: authMethod });
        const session = await client.request('session/new', { cwd: req.cwd ?? process.cwd(), mcpServers: [] });
        const sessionId: string = session.sessionId;
        const options: Array<{ id: string; options?: Array<{ value: string }> }> = session.configOptions ?? [];
        const modelOpt = options.find((o) => o.id === (this.cfg.modelConfigId ?? 'model'));
        if (modelOpt && modelOpt.options?.some((o) => o.value === model)) {
          await client.request('session/set_config_option', { sessionId, configId: modelOpt.id, value: model });
        }
        return client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: flattenPrompt(req.messages) }] });
      };
      const result = await Promise.race([run(), aborted]);
      if (result?.stopReason && !['end_turn', 'max_tokens'].includes(result.stopReason)) {
        throw new ProviderError(`${this.id} stopped: ${result.stopReason}`, this.id, result.stopReason !== 'refusal');
      }
      if (!text.trim()) throw new ProviderError(`${this.id} returned an empty answer`, this.id, true);
      return {
        text: text.trim(),
        providerId: this.id,
        model,
        latencyMs: Date.now() - started,
        usage: usedTokens !== undefined ? { inputTokens: usedTokens } : undefined,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const msg = describeError(err);
      // "Authentication required" / quota errors are retryable elsewhere and trigger a cooldown in the router.
      throw new ProviderError(`${this.id}: ${msg}${stderr ? ` — ${stderr.slice(-300)}` : ''}`, this.id, true, err);
    } finally {
      deadline.dispose();
      client.close();
    }
  }
}
