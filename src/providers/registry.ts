import type { ProviderConfig } from '../config/schema.js';
import { CliProvider } from './cli.js';
import { LiteLLMProvider } from './litellm.js';
import { MockProvider } from './mock.js';
import type { Provider } from './types.js';

export function createProvider(id: string, cfg: ProviderConfig, env?: NodeJS.ProcessEnv): Provider {
  switch (cfg.kind) {
    case 'litellm':
      return new LiteLLMProvider(id, cfg, { env });
    case 'cli':
      return new CliProvider(id, cfg, { env });
    case 'mock':
      return new MockProvider(id, cfg);
  }
}

/** Builds every enabled provider, keyed by its config id. */
export function createProviders(record: Record<string, ProviderConfig>, env?: NodeJS.ProcessEnv): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const [id, cfg] of Object.entries(record)) {
    if (cfg.enabled) providers.set(id, createProvider(id, cfg, env));
  }
  return providers;
}
