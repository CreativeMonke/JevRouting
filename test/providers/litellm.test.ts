import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderConfigSchema, type LiteLLMProviderConfig } from '../../src/config/schema.js';
import { LiteLLMProvider, ProviderError } from '../../src/providers/index.js';
import { startMockLiteLLM, type MockLiteLLM } from '../helpers/mock-litellm.js';

function litellmConfig(overrides: Record<string, unknown> = {}): LiteLLMProviderConfig {
  const parsed = ProviderConfigSchema.parse({ kind: 'litellm', model: 'claude-opus-5-5', ...overrides });
  if (parsed.kind !== 'litellm') throw new Error('expected a litellm config');
  return parsed;
}

const user = (content: string) => ({ role: 'user' as const, content });

describe('LiteLLMProvider', () => {
  let proxy: MockLiteLLM;

  beforeEach(async () => {
    proxy = await startMockLiteLLM();
  });

  afterEach(async () => {
    await proxy.close();
  });

  it('posts an OpenAI-compatible chat body and parses text, usage and cost', async () => {
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url, apiKey: 'sk-test' }));
    const result = await provider.complete({ messages: [user('hello there')], effort: 'high' });

    expect(result).toMatchObject({
      text: 'claude-opus-5-5: hello there',
      providerId: 'opus',
      model: 'claude-opus-5-5',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
      costUsd: 0.00042,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [recorded] = proxy.requests;
    expect(recorded?.path).toBe('/v1/chat/completions');
    expect(recorded?.headers.authorization).toBe('Bearer sk-test');
    expect(recorded?.body).toEqual({
      model: 'claude-opus-5-5',
      messages: [user('hello there')],
      reasoning_effort: 'high',
    });
  });

  it('normalizes reasoning_effort through the family map and forwards extraBody', async () => {
    const provider = new LiteLLMProvider(
      'ds',
      litellmConfig({ model: 'deepseek-v4', baseUrl: proxy.url, extraBody: { temperature: 0 } }),
    );
    await provider.complete({ messages: [user('x')], effort: 'medium' });
    expect(proxy.requests[0]?.body).toMatchObject({ reasoning_effort: 'high', temperature: 0 });
  });

  it('omits reasoning_effort when no effort is requested', async () => {
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url }));
    await provider.complete({ messages: [user('x')] });
    expect(proxy.requests[0]?.body).not.toHaveProperty('reasoning_effort');
  });

  it('sends the session header only when a session id is given', async () => {
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url }));
    await provider.complete({ messages: [user('a')], sessionId: 'sess-42' });
    await provider.complete({ messages: [user('b')] });
    expect(proxy.requests[0]?.headers['x-litellm-session-id']).toBe('sess-42');
    expect(proxy.requests[1]?.headers['x-litellm-session-id']).toBeUndefined();
  });

  it('reads base url and key from the env when the config omits them', async () => {
    const provider = new LiteLLMProvider('opus', litellmConfig(), {
      env: { LITELLM_BASE_URL: proxy.url, LITELLM_API_KEY: 'from-env' },
    });
    await provider.complete({ messages: [user('x')] });
    expect(proxy.requests[0]?.headers.authorization).toBe('Bearer from-env');
  });

  it('marks 429 as retryable', async () => {
    proxy.failNext('claude-opus-5-5', 429);
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url }));
    const err = await provider.complete({ messages: [user('x')] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true, providerId: 'opus' });
    expect((err as ProviderError).message).toMatch(/HTTP 429/);
  });

  it('marks a 400 as non-retryable and surfaces the proxy message', async () => {
    proxy.failNext('claude-opus-5-5', 400);
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url }));
    const err = await provider.complete({ messages: [user('x')] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: false });
    expect((err as ProviderError).message).toMatch(/HTTP 400: mock failure/);
  });

  it('marks 5xx as retryable', async () => {
    proxy.failNext('claude-opus-5-5', 503);
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url }));
    await expect(provider.complete({ messages: [user('x')] })).rejects.toMatchObject({ retryable: true });
  });

  it('times out with a retryable ProviderError', async () => {
    proxy.delay('claude-opus-5-5', 300);
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url, timeoutMs: 50 }));
    const err = await provider.complete({ messages: [user('x')] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true, providerId: 'opus' });
    expect((err as ProviderError).message).toMatch(/timed out after 50ms/);
  });

  it('treats a caller abort as non-retryable', async () => {
    proxy.delay('claude-opus-5-5', 300);
    const controller = new AbortController();
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: proxy.url }));
    const pending = provider.complete({ messages: [user('x')], signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ retryable: false });
  });

  it('maps connection failures to a retryable network error', async () => {
    const provider = new LiteLLMProvider('opus', litellmConfig({ baseUrl: 'http://127.0.0.1:1/v1' }));
    const err = await provider.complete({ messages: [user('x')] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true });
    expect((err as ProviderError).message).toMatch(/network error/);
  });
});
