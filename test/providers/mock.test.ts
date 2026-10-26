import { describe, expect, it, vi } from 'vitest';
import { ProviderConfigSchema, type MockProviderConfig } from '../../src/config/schema.js';
import { MockProvider, ProviderError } from '../../src/providers/index.js';

function mockConfig(overrides: Record<string, unknown> = {}): MockProviderConfig {
  const parsed = ProviderConfigSchema.parse({ kind: 'mock', ...overrides });
  if (parsed.kind !== 'mock') throw new Error('expected a mock config');
  return parsed;
}

const user = (content: string) => ({ role: 'user' as const, content });

describe('MockProvider', () => {
  it('echoes the last user message with its id', async () => {
    const provider = new MockProvider('m1', mockConfig());
    const result = await provider.complete({
      messages: [{ role: 'system', content: 'sys' }, user('first'), { role: 'assistant', content: 'a' }, user('last')],
    });
    expect(result).toMatchObject({ text: '[mock:m1] last', providerId: 'm1', model: 'mock', costUsd: 0 });
  });

  it('returns the configured reply verbatim', async () => {
    const provider = new MockProvider('m1', mockConfig({ reply: 'canned' }));
    expect((await provider.complete({ messages: [user('x')] })).text).toBe('canned');
  });

  it('waits for the configured latency before answering', async () => {
    const sleep = vi.fn(async () => {});
    const provider = new MockProvider('m1', mockConfig({ latencyMs: 250 }), { sleep });
    await provider.complete({ messages: [user('x')] });
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('fails when the random draw falls under failRate', async () => {
    const provider = new MockProvider('m1', mockConfig({ failRate: 0.5 }), { random: () => 0.2 });
    const err = await provider.complete({ messages: [user('x')] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true });
  });

  it('succeeds when the random draw is at or above failRate', async () => {
    const provider = new MockProvider('m1', mockConfig({ failRate: 0.5 }), { random: () => 0.5 });
    await expect(provider.complete({ messages: [user('x')] })).resolves.toMatchObject({ text: '[mock:m1] x' });
  });

  it('never fails at failRate 0', async () => {
    const provider = new MockProvider('m1', mockConfig(), { random: () => 0 });
    await expect(provider.complete({ messages: [user('x')] })).resolves.toBeDefined();
  });
});
