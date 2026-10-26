import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema, ProviderConfigSchema, type ProviderConfig } from '../../src/config/schema.js';
import { CliProvider, createProvider, createProviders, LiteLLMProvider, MockProvider } from '../../src/providers/index.js';
import { startMockLiteLLM, type MockLiteLLM } from '../helpers/mock-litellm.js';

function parse(input: unknown): ProviderConfig {
  return ProviderConfigSchema.parse(input);
}

describe('createProvider', () => {
  let proxy: MockLiteLLM;

  beforeEach(async () => {
    proxy = await startMockLiteLLM();
  });

  afterEach(async () => {
    await proxy.close();
  });

  it('builds the provider class for each kind', () => {
    expect(createProvider('l', parse({ kind: 'litellm', model: 'claude-opus-5-5' }))).toBeInstanceOf(LiteLLMProvider);
    expect(createProvider('c', parse({ kind: 'cli', preset: 'claude-code', model: 'x' }))).toBeInstanceOf(CliProvider);
    expect(createProvider('m', parse({ kind: 'mock' }))).toBeInstanceOf(MockProvider);
  });

  it('exposes id, kind, model and the inferred family', () => {
    const provider = createProvider('opus', parse({ kind: 'litellm', model: 'opencode/claude-opus-5-5' }));
    expect(provider).toMatchObject({ id: 'opus', kind: 'litellm', model: 'opencode/claude-opus-5-5', family: 'anthropic' });
  });

  it('prefers an explicit family over the inferred one', () => {
    const provider = createProvider('x', parse({ kind: 'mock', model: 'claude-x', family: 'deepseek' }));
    expect(provider.family).toBe('deepseek');
  });

  it('passes the env through to the LiteLLM provider', async () => {
    const provider = createProvider('l', parse({ kind: 'litellm', model: 'gemini-3-pro' }), {
      LITELLM_BASE_URL: proxy.url,
    });
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('gemini-3-pro: hi');
  });
});

describe('createProviders', () => {
  it('builds a map of enabled providers and skips disabled ones', () => {
    const config = ConfigSchema.parse({
      jev: {},
      providers: {
        opus: { kind: 'litellm', model: 'claude-opus-5-5' },
        codex: { kind: 'litellm', model: 'gpt-6-1-sol', enabled: false },
        echo: { kind: 'mock' },
      },
    });

    const providers = createProviders(config.providers);

    expect([...providers.keys()]).toEqual(['opus', 'echo']);
    expect(providers.get('opus')).toBeInstanceOf(LiteLLMProvider);
    expect(providers.get('echo')).toBeInstanceOf(MockProvider);
    expect(providers.has('codex')).toBe(false);
  });
});
