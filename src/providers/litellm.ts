import { z } from 'zod';
import type { LiteLLMProviderConfig } from '../config/schema.js';
import { describeError, startDeadline, type Deadline } from './deadline.js';
import { normalizeEffort, resolveFamily } from './effort.js';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type CompletionUsage,
  type Provider,
} from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:4000/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const COST_HEADER = 'x-litellm-response-cost';
/** LiteLLM routes requests with the same session id to the same deployment, keeping its prompt cache warm. */
const SESSION_HEADER = 'x-litellm-session-id';

export interface LiteLLMDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

const ChatCompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
    })
    .nullish(),
});

const ErrorBodySchema = z.object({ error: z.object({ message: z.string() }).optional() });

interface HttpResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  text: string;
}

export class LiteLLMProvider implements Provider {
  readonly kind = 'litellm';
  readonly id: string;
  readonly family: string;
  readonly model: string;
  private readonly cfg: LiteLLMProviderConfig;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(id: string, cfg: LiteLLMProviderConfig, deps: LiteLLMDeps = {}) {
    const env = deps.env ?? process.env;
    this.id = id;
    this.cfg = cfg;
    this.model = cfg.model;
    this.family = resolveFamily(cfg);
    this.baseUrl = (cfg.baseUrl ?? env.LITELLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = cfg.apiKey ?? env.LITELLM_API_KEY;
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const startedAt = this.now();
    const deadline = startDeadline(this.id, req.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, req.signal);
    try {
      const response = await this.post(req, deadline);
      if (!response.ok) throw httpError(this.id, response.status, response.text);
      const json = parseJson(response.text, this.id);
      const body = parseChatCompletion(json, this.id);
      return {
        text: body.choices[0]?.message.content ?? '',
        providerId: this.id,
        model: this.model,
        latencyMs: this.now() - startedAt,
        usage: toUsage(body.usage),
        costUsd: parseCost(response.headers.get(COST_HEADER)),
        raw: json,
      };
    } finally {
      deadline.dispose();
    }
  }

  private async post(req: CompletionRequest, deadline: Deadline): Promise<HttpResponse> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(req),
        body: JSON.stringify(this.body(req)),
        signal: deadline.signal,
      });
      return { ok: res.ok, status: res.status, headers: res.headers, text: await res.text() };
    } catch (err) {
      if (deadline.signal.aborted) throw deadline.abortError();
      throw new ProviderError(`${this.id} network error: ${describeError(err)}`, this.id, true, err);
    }
  }

  private headers(req: CompletionRequest): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.cfg.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (req.sessionId) headers[SESSION_HEADER] = req.sessionId;
    return headers;
  }

  private body(req: CompletionRequest): Record<string, unknown> {
    const effort = normalizeEffort(req.effort, this.cfg);
    return {
      model: this.model,
      messages: req.messages,
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      ...this.cfg.extraBody,
    };
  }
}

function httpError(providerId: string, status: number, body: string): ProviderError {
  const retryable = status === 429 || status >= 500;
  return new ProviderError(`${providerId} HTTP ${status}: ${errorMessage(body)}`, providerId, retryable);
}

function errorMessage(body: string): string {
  try {
    const message = ErrorBodySchema.parse(JSON.parse(body)).error?.message;
    if (message) return message;
  } catch {
    // Not a JSON error body; fall through to the raw text.
  }
  return body.slice(0, 300) || 'empty response body';
}

function parseJson(text: string, providerId: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ProviderError(`${providerId} returned a non-JSON body`, providerId, false, err);
  }
}

function parseChatCompletion(json: unknown, providerId: string): z.infer<typeof ChatCompletionSchema> {
  const parsed = ChatCompletionSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError(`${providerId} returned an unexpected chat completion shape`, providerId, false, parsed.error);
  }
  return parsed.data;
}

function toUsage(usage: z.infer<typeof ChatCompletionSchema>['usage']): CompletionUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
  };
}

function parseCost(header: string | null): number | undefined {
  if (header === null) return undefined;
  const cost = Number(header);
  return Number.isFinite(cost) ? cost : undefined;
}
