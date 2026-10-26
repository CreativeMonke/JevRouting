import { JevClient, JevError, type JevClientOptions, type SystemOneCall, type SystemOneResult } from './client.js';
import type { JevQuestions } from './types.js';

/** Anything that can answer System One questions (a single client or a failover pool). */
export interface SystemOneClient {
  readonly model: string;
  readonly circuitOpen: boolean;
  systemOne<const Q extends JevQuestions>(call: SystemOneCall<Q>): Promise<SystemOneResult<Q>>;
}

/**
 * Ordered failover across Jev-compatible backends (OpenCode Zen jev-1.13-free,
 * Cloudflare Workers AI Clef, TypeSafe direct, self-hosted Clef...). Backends that
 * are rate limited or have an open breaker are skipped without a network call.
 */
export class JevPool implements SystemOneClient {
  readonly clients: JevClient[];

  constructor(backends: Array<JevClient | JevClientOptions>) {
    if (!backends.length) throw new Error('JevPool needs at least one backend');
    this.clients = backends.map((b) => (b instanceof JevClient ? b : new JevClient(b)));
  }

  get model(): string {
    return (this.clients.find((c) => !c.circuitOpen) ?? this.clients[0]!).model;
  }

  get circuitOpen(): boolean {
    return this.clients.every((c) => c.circuitOpen);
  }

  async systemOne<const Q extends JevQuestions>(call: SystemOneCall<Q>): Promise<SystemOneResult<Q>> {
    const errors: string[] = [];
    for (const c of this.clients) {
      if (c.circuitOpen) {
        errors.push(`${c.name}: skipped (unavailable)`);
        continue;
      }
      try {
        // Each backend has its own model id; never forward one backend's model to another.
        const { model: _ignored, ...rest } = call;
        return await c.systemOne(rest as SystemOneCall<Q>);
      } catch (err) {
        errors.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
        // 422 = our request is malformed; another backend with the same schema would reject it too.
        if (err instanceof JevError && err.status === 422) break;
      }
    }
    throw new JevError(`all Jev backends failed — ${errors.join(' | ')}`);
  }
}
