import { describe, expect, it } from 'vitest';
import { ProviderConfigSchema } from '../../src/config/schema.js';
import { CliProvider } from '../../src/providers/index.js';

/** Opt-in: spawns the real opencode CLI and calls a free OpenRouter model. Run with JEV_LIVE=1. */
describe.runIf(process.env.JEV_LIVE === '1')('opencode (live)', () => {
  it('answers a trivial prompt', async () => {
    const cfg = ProviderConfigSchema.parse({
      kind: 'cli',
      preset: 'opencode',
      model: 'openrouter/openrouter/free',
    });
    if (cfg.kind !== 'cli') throw new Error('expected a cli config');
    const provider = new CliProvider('opencode-free', cfg);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'reply with exactly: pong' }],
      timeoutMs: 120_000,
    });

    expect(result.text.toLowerCase()).toContain('pong');
  }, 150_000);
});
