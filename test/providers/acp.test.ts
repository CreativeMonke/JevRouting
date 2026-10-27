import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import { AcpProvider } from '../../src/providers/acp.js';
import { ProviderError } from '../../src/providers/types.js';

const agent = new URL('../helpers/fake-acp-agent.mjs', import.meta.url).pathname;
const make = (mode = 'ok', model = 'm-{effort}') => {
  const cfg = parseConfig({ jev: {}, providers: { a: { kind: 'acp', command: process.execPath, args: [agent], model, authMethod: 'oauth-personal' } } }).providers.a;
  return new AcpProvider('a', cfg as any, { env: { ...process.env, FAKE_ACP_MODE: mode } });
};
const msg = (content: string) => ({ messages: [{ role: 'user' as const, content }], timeoutMs: 10_000 });

describe('AcpProvider', () => {
  it('authenticates, selects the model for the effort, and collects streamed text + usage', async () => {
    const r = await make().complete({ ...msg('hello'), effort: 'high' });
    expect(r.text).toBe('[m-high] echo: hello');
    expect(r.model).toBe('m-high');
    expect(r.usage?.inputTokens).toBe(1234);
  });
  it('declines permission requests and still answers', async () => {
    const r = await make('permission').complete(msg('hi'));
    expect(r.text).toContain('echo: hi');
  });
  it('maps auth failure to a retryable error (router cools the provider down)', async () => {
    const err = await make('noauth').complete(msg('hi')).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Authentication required/);
  });
  it('refusal is a non-retryable failure; a crashing agent is retryable', async () => {
    const refused = await make('refuse').complete(msg('hi')).catch((e) => e);
    expect(refused.retryable).toBe(false);
    const crashed = await make('crash').complete(msg('hi')).catch((e) => e);
    expect(crashed.message).toMatch(/exited/);
    expect(crashed.retryable).toBe(true);
  });
});
