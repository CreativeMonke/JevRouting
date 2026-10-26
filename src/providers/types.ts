export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Conversation to send. The last entry is the current user turn. */
  messages: ChatMessage[];
  effort?: Effort;
  /** Stable session id; used for cache affinity headers / CLI session reuse. */
  sessionId?: string;
  /** Working directory for CLI-backed agents. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface CompletionResult {
  text: string;
  providerId: string;
  model: string;
  latencyMs: number;
  usage?: CompletionUsage;
  costUsd?: number;
  raw?: unknown;
}

export interface Provider {
  readonly id: string;
  readonly kind: string;
  /** Model family, used for cache-aware stay/switch decisions (anthropic, openai, google, deepseek, ...). */
  readonly family: string;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly retryable = true,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
