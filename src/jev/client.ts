import type { JevQuestions, JevRequest, JevResponse, JevState } from './types.js';

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export interface JevClientOptions {
  /** e.g. https://opencode.ai/zen/v1 or https://api.typesafe.ai/v1 */
  baseUrl: string;
  apiKey?: string;
  /** Pinned model id, e.g. jev-1.13-free (OpenCode Zen) or jev-1.13.0 (TypeSafe). */
  model: string;
  timeoutMs?: number;
  /** Retries on 5xx / network errors (not on 4xx). */
  maxRetries?: number;
  /** Consecutive failures that open the breaker. 0 disables it. */
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  headers?: Record<string, string>;
  /**
   * systemone: POST {baseUrl}/systemone (TypeSafe, OpenCode Zen, LiteLLM, self-hosted Clef).
   * workers-ai: POST {baseUrl}/ai/run/@cf/cloudflare/{model} with Cloudflare's {result} envelope
   *   (baseUrl = https://api.cloudflare.com/client/v4/accounts/<account id>).
   */
  transport?: 'systemone' | 'workers-ai';
  /** Label used in logs / pool errors. */
  name?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SystemOneCall<Q extends JevQuestions> {
  state: JevState;
  questions: Q;
  model?: string;
}

export interface SystemOneResult<Q extends JevQuestions> extends JevResponse<Q> {
  latencyMs: number;
  requestId?: string;
  costUsd?: number;
}

/** Thin, dependency-free client for the Jev System One endpoint. */
export class JevClient {
  private readonly opts: Required<Omit<JevClientOptions, 'apiKey' | 'headers' | 'name'>> &
    Pick<JevClientOptions, 'apiKey' | 'headers' | 'name'>;
  private failures = 0;
  private openUntil = 0;
  /** Set from a 429's Retry-After so we stop hammering a rate-limited backend. */
  private limitedUntil = 0;

  constructor(opts: JevClientOptions) {
    this.opts = {
      timeoutMs: 3000,
      maxRetries: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      transport: 'systemone',
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
    };
  }

  get model(): string {
    return this.opts.model;
  }

  get name(): string {
    return this.opts.name ?? `${this.opts.baseUrl}#${this.opts.model}`;
  }

  /** True while the breaker is open or the backend told us to back off (429 Retry-After). */
  get circuitOpen(): boolean {
    const now = this.opts.now();
    return now < this.openUntil || now < this.limitedUntil;
  }

  async systemOne<const Q extends JevQuestions>(call: SystemOneCall<Q>): Promise<SystemOneResult<Q>> {
    if (this.circuitOpen) {
      const why = this.opts.now() < this.limitedUntil ? 'rate limited' : 'circuit breaker open';
      throw new JevError(`Jev ${why} (${this.name})`);
    }
    const body: JevRequest = {
      model: call.model ?? this.opts.model,
      state: call.state,
      questions: call.questions,
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const res = await this.post(body);
        this.failures = 0;
        return res as SystemOneResult<Q>;
      } catch (err) {
        lastErr = err;
        if (err instanceof JevError && err.status === 429) {
          this.limitedUntil = this.opts.now() + Math.min(err.retryAfterSec ?? 60, 6 * 3600) * 1000;
          throw err;
        }
        const retryable =
          !(err instanceof JevError) || err.status === undefined || err.status >= 500;
        if (!retryable) break;
      }
    }
    this.recordFailure();
    throw lastErr;
  }

  private recordFailure() {
    if (this.opts.circuitBreakerThreshold <= 0) return;
    this.failures++;
    if (this.failures >= this.opts.circuitBreakerThreshold) {
      this.openUntil = this.opts.now() + this.opts.circuitBreakerCooldownMs;
      this.failures = 0;
    }
  }

  private async post(body: JevRequest): Promise<SystemOneResult<JevQuestions>> {
    const started = this.opts.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    let res: Response;
    let text: string;
    try {
      const url =
        this.opts.transport === 'workers-ai'
          ? `${this.opts.baseUrl}/ai/run/@cf/cloudflare/${encodeURIComponent(body.model)}`
          : `${this.opts.baseUrl}/systemone`;
      res = await this.opts.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.headers,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      // The timeout must cover the body too: a backend that sends headers then stalls would hang routing.
      text = await res.text();
    } catch (err) {
      const msg = ctrl.signal.aborted ? `Jev request timed out after ${this.opts.timeoutMs}ms` : String(err);
      throw new JevError(msg);
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }

    if (!res.ok) {
      const ra = Number(res.headers.get('retry-after'));
      throw new JevError(
        `Jev ${res.status}: ${extractMessage(json) ?? res.statusText}`,
        res.status,
        json,
        Number.isFinite(ra) && ra > 0 ? ra : undefined,
      );
    }
    if (this.opts.transport === 'workers-ai' && json && typeof json === 'object' && 'result' in json) {
      json = (json as { result: unknown }).result;
    }
    if (!isJevResponse(json)) {
      throw new JevError('Jev returned an unexpected response shape', res.status, json);
    }
    const cost = Number(res.headers.get('x-cost-usd'));
    return {
      ...json,
      latencyMs: this.opts.now() - started,
      requestId: res.headers.get('x-typesafe-request-id') ?? res.headers.get('x-opencode-log-id') ?? undefined,
      costUsd: Number.isFinite(cost) && res.headers.has('x-cost-usd') ? cost : undefined,
    };
  }
}

function isJevResponse(v: unknown): v is JevResponse {
  return !!v && typeof v === 'object' && 'answers' in v && typeof (v as JevResponse).answers === 'object';
}

function extractMessage(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return typeof v === 'string' ? v.slice(0, 300) : undefined;
  const o = v as Record<string, any>;
  if (typeof o.error?.message === 'string') return o.error.message;
  if (typeof o.message === 'string') return o.message;
  if (Array.isArray(o.detail)) return JSON.stringify(o.detail).slice(0, 300);
  if (typeof o.detail === 'string') return o.detail;
  return undefined;
}
