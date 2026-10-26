import { spawn, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CliProviderConfig } from '../config/schema.js';
import { expandArgs, resolveCliSpec, type CliSpec } from './cli-args.js';
import { isLimitMessage, parseCliOutput, stripAnsi, tail, type CliFailure } from './cli-output.js';
import { startDeadline, type Deadline } from './deadline.js';
import { normalizeEffort, resolveFamily } from './effort.js';
import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 300_000;

/** The slice of ChildProcess the provider uses, so tests can substitute a fake. */
export interface CliChild {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => CliChild;

export interface CliDeps {
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });

export class CliProvider implements Provider {
  readonly kind = 'cli';
  readonly id: string;
  readonly family: string;
  readonly model: string;
  private readonly cfg: CliProviderConfig;
  private readonly spec: CliSpec;
  private readonly spawnFn: SpawnFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(id: string, cfg: CliProviderConfig, deps: CliDeps = {}) {
    this.id = id;
    this.cfg = cfg;
    this.model = cfg.model;
    this.family = resolveFamily(cfg);
    this.spec = resolveCliSpec(cfg);
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.env = { ...(deps.env ?? process.env), ...cfg.env };
    this.now = deps.now ?? Date.now;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const startedAt = this.now();
    const args = expandArgs(this.spec.args, {
      model: this.model,
      prompt: flattenPrompt(req.messages),
      effort: normalizeEffort(req.effort, this.cfg),
      sessionId: req.sessionId,
    });
    const deadline = startDeadline(this.id, req.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.signal);
    try {
      const run = await this.run(args, req.cwd, deadline);
      const parsed = parseCliOutput(this.spec.output, run.stdout);
      const failure = parsed.failure ?? this.runFailure(run, parsed.text);
      if (failure) throw new ProviderError(failure.message, this.id, failure.retryable);
      return {
        text: parsed.text,
        providerId: this.id,
        model: this.model,
        latencyMs: this.now() - startedAt,
        usage: parsed.usage,
        costUsd: parsed.costUsd,
        raw: parsed.raw,
      };
    } finally {
      deadline.dispose();
    }
  }

  /** Failures the agent did not report itself: a non-zero exit, or no text at all. */
  private runFailure(run: CliRun, text: string): CliFailure | undefined {
    const combined = `${run.stdout}\n${run.stderr}`;
    if (run.code !== 0) {
      return {
        message: `${this.spec.command} exited with code ${run.code}: ${tail(run.stderr || run.stdout)}`,
        retryable: isLimitMessage(combined),
      };
    }
    if (!text) {
      return { message: `returned no text: ${tail(combined) || 'empty output'}`, retryable: isLimitMessage(combined) };
    }
    return undefined;
  }

  private run(args: string[], cwd: string | undefined, deadline: Deadline): Promise<CliRun> {
    return new Promise<CliRun>((resolve, reject) => {
      if (deadline.signal.aborted) return reject(deadline.abortError());
      const { command } = this.spec;
      const child = this.spawnFn(command, args, { cwd, env: this.env, shell: false, windowsHide: true });
      const output = { stdout: '', stderr: '' };
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        output.stdout += chunk;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        output.stderr += chunk;
      });
      deadline.signal.addEventListener(
        'abort',
        () => {
          // Reject before killing: a fake or fast child may emit 'close' synchronously from kill().
          reject(deadline.abortError());
          child.kill();
        },
        { once: true },
      );
      child.once('error', (err) => {
        reject(new ProviderError(`failed to start ${command}: ${err.message}`, this.id, false, err));
      });
      child.once('close', (code) => {
        resolve({ code, stdout: stripAnsi(output.stdout), stderr: stripAnsi(output.stderr) });
      });
    });
  }
}

/**
 * Flattens a chat into one prompt for a CLI agent: system text first, then prior turns as a
 * User/Assistant transcript, then the current user message last.
 */
export function flattenPrompt(messages: readonly ChatMessage[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const turns = messages.filter((m) => m.role !== 'system');
  const current = turns.pop();
  const transcript = turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
  return [...system, transcript, current?.content ?? ''].filter(Boolean).join('\n\n');
}
