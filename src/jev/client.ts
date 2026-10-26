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
  private readonly opts: Required<Omit<JevClientOptions, 'apiKey' | 'headers'>> &
    Pick<JevClientOptions, 'apiKey' | 'headers'>;
  private failures = 0;
  private openUntil = 0;

  constructor(opts: JevClientOptions) {
    this.opts = {
      timeoutMs: 3000,
      maxRetries: 1,
      circuitBreakerThreshold: 3,
      circuitBreakerCooldownMs: 30_000,
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/+$/, ''),
    };
  }

  get model(): string {
    return this.opts.model;
  }

  get circuitOpen(): boolean {
    return this.opts.now() < this.openUntil;
  }

  async systemOne<const Q extends JevQuestions>(call: SystemOneCall<Q>): Promise<SystemOneResult<Q>> {
    if (this.circuitOpen) {
      throw new JevError('Jev circuit breaker open');
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
    try {
      res = await this.opts.fetch(`${this.opts.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.headers,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = ctrl.signal.aborted ? `Jev request timed out after ${this.opts.timeoutMs}ms` : String(err);
      throw new JevError(msg);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
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
