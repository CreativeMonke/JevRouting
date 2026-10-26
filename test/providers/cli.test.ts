import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConfigSchema, type CliProviderConfig } from '../../src/config/schema.js';
import { CliProvider, expandArgs, flattenPrompt, ProviderError, type CliChild, type SpawnFn } from '../../src/providers/index.js';

class FakeChild extends EventEmitter implements CliChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.emit('close', null);
    return true;
  });
}

interface Script {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Never close, so only the timeout or an abort can end the run. */
  hang?: boolean;
}

/** Fake spawn: records each call and replays a scripted process result. */
function fakeSpawn(script: Script = {}) {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    if (!script.hang) {
      setImmediate(() => {
        child.stdout.end(script.stdout ?? '');
        child.stderr.end(script.stderr ?? '');
        void Promise.all([finished(child.stdout), finished(child.stderr)]).then(() =>
          child.emit('close', script.code ?? 0),
        );
      });
    }
    return child;
  };
  return { spawn, calls, children };
}

function cliConfig(overrides: Record<string, unknown>): CliProviderConfig {
  const parsed = ProviderConfigSchema.parse({ kind: 'cli', ...overrides });
  if (parsed.kind !== 'cli') throw new Error('expected a cli config');
  return parsed;
}

const user = (content: string) => ({ role: 'user' as const, content });

describe('expandArgs', () => {
  it('fills placeholders and drops a flag whose value is missing', () => {
    const template = ['-p', '{prompt}', '--effort', '{effort}', '--model={model}'];
    expect(expandArgs(template, { prompt: 'hi', model: 'm' })).toEqual(['-p', 'hi', '--model=m']);
    expect(expandArgs(template, { prompt: 'hi', model: 'm', effort: 'high' })).toEqual([
      '-p',
      'hi',
      '--effort',
      'high',
      '--model=m',
    ]);
  });

  it('never treats an inserted value as a placeholder', () => {
    expect(expandArgs(['{prompt}'], { prompt: '{model}' })).toEqual(['{model}']);
  });

  it('ignores placeholder names that are not own properties', () => {
    expect(expandArgs(['{constructor}'], {})).toEqual([]);
  });
});

describe('flattenPrompt', () => {
  it('puts system text first, the transcript next and the current user turn last', () => {
    const prompt = flattenPrompt([
      { role: 'system', content: 'Be brief.' },
      user('first question'),
      { role: 'assistant', content: 'first answer' },
      user('second question'),
    ]);
    expect(prompt).toBe('Be brief.\n\nUser: first question\n\nAssistant: first answer\n\nsecond question');
  });

  it('returns only the user message when there is no history', () => {
    expect(flattenPrompt([user('solo')])).toBe('solo');
  });
});

describe('CliProvider', () => {
  it('builds the claude-code argv with the prompt and effort and parses claude-json', async () => {
    const { spawn, calls } = fakeSpawn({
      stdout: JSON.stringify({
        result: 'pong',
        total_cost_usd: 0.0123,
        session_id: 'sess-1',
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 5000 },
      }),
    });
    const provider = new CliProvider('claude', cliConfig({ preset: 'claude-code', model: 'claude-opus-5-5' }), {
      spawn,
      env: {},
    });

    const result = await provider.complete({ messages: [user('ping')], effort: 'high' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'claude', options: { shell: false } });
    expect(calls[0]?.args).toEqual([
      '-p',
      'ping',
      '--model',
      'claude-opus-5-5',
      '--output-format',
      'json',
      '--effort',
      'high',
    ]);
    expect(result).toMatchObject({
      text: 'pong',
      providerId: 'claude',
      model: 'claude-opus-5-5',
      costUsd: 0.0123,
      usage: { inputTokens: 5007, outputTokens: 3, cachedInputTokens: 5000 },
      raw: { session_id: 'sess-1' },
    });
  });

  it('drops --effort for claude-code when no effort is requested', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: JSON.stringify({ result: 'ok' }) });
    const provider = new CliProvider('claude', cliConfig({ preset: 'claude-code', model: 'm' }), { spawn, env: {} });
    await provider.complete({ messages: [user('x')] });
    expect(calls[0]?.args).not.toContain('--effort');
  });

  it('turns claude-json is_error into a ProviderError', async () => {
    const { spawn } = fakeSpawn({ stdout: JSON.stringify({ is_error: true, result: 'Model overloaded' }), code: 0 });
    const provider = new CliProvider('claude', cliConfig({ preset: 'claude-code', model: 'm' }), { spawn, env: {} });
    await expect(provider.complete({ messages: [user('x')] })).rejects.toMatchObject({
      message: 'Model overloaded',
      retryable: false,
    });
  });

  it('builds the opencode argv and joins NDJSON text parts', async () => {
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"pong"}}',
      '',
    ].join('\n');
    const { spawn, calls } = fakeSpawn({ stdout });
    const provider = new CliProvider('oc', cliConfig({ preset: 'opencode', model: 'openrouter/openrouter/free' }), {
      spawn,
      env: {},
    });

    const result = await provider.complete({ messages: [user('reply with exactly: pong')] });

    expect(calls[0]?.args).toEqual([
      'run',
      '-m',
      'openrouter/openrouter/free',
      '--format',
      'json',
      'reply with exactly: pong',
    ]);
    expect(result.text).toBe('pong');
  });

  it('surfaces an opencode error event as a ProviderError', async () => {
    const stdout = '{"type":"error","error":{"type":"provider.no-route","message":"Model unavailable"}}\n';
    const { spawn } = fakeSpawn({ stdout, code: 1 });
    const provider = new CliProvider('oc', cliConfig({ preset: 'opencode', model: 'x/y' }), { spawn, env: {} });
    await expect(provider.complete({ messages: [user('x')] })).rejects.toMatchObject({
      message: 'Model unavailable',
      retryable: false,
    });
  });

  it('strips ANSI codes from text output', async () => {
    const { spawn } = fakeSpawn({ stdout: '\u001B[32mpong\u001B[0m\n' });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'gemini-3-pro' }), {
      spawn,
      env: {},
    });
    expect((await provider.complete({ messages: [user('x')] })).text).toBe('pong');
  });

  it('kills the process and throws a retryable ProviderError on timeout', async () => {
    const { spawn, children } = fakeSpawn({ hang: true });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'm' }), { spawn, env: {} });

    const err = await provider.complete({ messages: [user('x')], timeoutMs: 20 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/timed out after 20ms/);
    expect((err as ProviderError).retryable).toBe(true);
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('kills the process when the caller aborts', async () => {
    const { spawn, children } = fakeSpawn({ hang: true });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'm' }), { spawn, env: {} });
    const controller = new AbortController();
    const pending = provider.complete({ messages: [user('x')], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ retryable: false });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('reports a non-zero exit with the stderr tail and is not retryable', async () => {
    const { spawn } = fakeSpawn({ stderr: 'error: unknown flag --bogus', code: 2 });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'm' }), { spawn, env: {} });
    const err = await provider.complete({ messages: [user('x')] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toMatch(/exited with code 2: error: unknown flag --bogus/);
    expect((err as ProviderError).retryable).toBe(false);
  });

  it.each([
    ['a usage limit', 'Error: Usage limit reached for this plan', 1],
    ['a rate limit', 'rate limit exceeded, try again later', 1],
    ['a sign-in prompt', 'Please sign in to continue', 1],
  ])('treats %s on a failed run as retryable', async (_label, stderr, code) => {
    const { spawn } = fakeSpawn({ stderr, code });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'm' }), { spawn, env: {} });
    await expect(provider.complete({ messages: [user('x')] })).rejects.toMatchObject({ retryable: true });
  });

  it('treats an empty reply that mentions a limit as retryable', async () => {
    const { spawn } = fakeSpawn({ stdout: '', stderr: 'Usage limit reached' });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'm' }), { spawn, env: {} });
    await expect(provider.complete({ messages: [user('x')] })).rejects.toMatchObject({ retryable: true });
  });

  it('does not flag a successful reply that merely discusses rate limits', async () => {
    const { spawn } = fakeSpawn({ stdout: 'A rate limit caps requests per window.\n' });
    const provider = new CliProvider('agy', cliConfig({ preset: 'antigravity', model: 'm' }), { spawn, env: {} });
    expect((await provider.complete({ messages: [user('explain')] })).text).toBe('A rate limit caps requests per window.');
  });

  it('uses explicit command, args and output over the preset', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'hello' });
    const provider = new CliProvider(
      'custom',
      cliConfig({
        preset: 'antigravity',
        model: 'm',
        command: 'my-agent',
        args: ['--prompt', '{prompt}', '--sid', '{sessionId}'],
        output: 'text',
      }),
      { spawn, env: {} },
    );
    await provider.complete({ messages: [user('x')], sessionId: 's9' });
    expect(calls[0]).toMatchObject({ command: 'my-agent', args: ['--prompt', 'x', '--sid', 's9'] });
  });

  it('rejects a config with neither a preset nor a command', () => {
    expect(() => new CliProvider('bare', cliConfig({ model: 'm' }))).toThrow(/preset or a command/);
  });

  it('passes the config env over the process env', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: 'ok' });
    const provider = new CliProvider(
      'agy',
      cliConfig({ preset: 'antigravity', model: 'm', env: { FOO: 'bar' } }),
      { spawn, env: { PATH: '/bin' } },
    );
    await provider.complete({ messages: [user('x')], cwd: '/tmp/work' });
    expect(calls[0]?.options).toMatchObject({ cwd: '/tmp/work', env: { PATH: '/bin', FOO: 'bar' } });
  });
});
