import type { MockProviderConfig } from '../config/schema.js';
import { resolveFamily } from './effort.js';
import {
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
} from './types.js';

export interface MockDeps {
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MockProvider implements Provider {
  readonly kind = 'mock';
  readonly id: string;
  readonly family: string;
  readonly model: string;
  private readonly cfg: MockProviderConfig;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(id: string, cfg: MockProviderConfig, deps: MockDeps = {}) {
    this.id = id;
    this.cfg = cfg;
    this.model = cfg.model;
    this.family = resolveFamily(cfg);
    this.random = deps.random ?? Math.random;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const startedAt = this.now();
    await this.sleep(this.cfg.latencyMs);
    if (this.random() < this.cfg.failRate) {
      throw new ProviderError(`${this.id} mock failure`, this.id, true);
    }
    return {
      text: this.cfg.reply ?? `[mock:${this.id}] ${lastUserMessage(req.messages)}`,
      providerId: this.id,
      model: this.model,
      latencyMs: this.now() - startedAt,
      costUsd: 0,
    };
  }
}

function lastUserMessage(messages: readonly ChatMessage[]): string {
  return messages.findLast((m) => m.role === 'user')?.content ?? '';
}
