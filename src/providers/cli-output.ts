import { z } from 'zod';
import type { CliOutputFormat } from './cli-args.js';
import type { CompletionUsage } from './types.js';

const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*\u0007)/g;
const LIMIT_PATTERN = /\b(?:usage limit|rate limit|sign[ -]?in)\b/i;

export interface CliFailure {
  message: string;
  retryable: boolean;
}

export interface ParsedCliOutput {
  text: string;
  costUsd?: number;
  usage?: CompletionUsage;
  raw?: unknown;
  /** An error the agent reported in its own output, e.g. claude `is_error` or an opencode error event. */
  failure?: CliFailure;
}

const ClaudeJsonSchema = z.object({
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    })
    .optional(),
});

const OpencodeEventSchema = z.object({
  type: z.string(),
  part: z.object({ type: z.string().optional(), text: z.string().optional() }).optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Whether output reads like a usage/rate limit or sign-in prompt rather than an answer. */
export function isLimitMessage(text: string): boolean {
  return LIMIT_PATTERN.test(text);
}

export function tail(text: string, maxChars = 300): string {
  return text.slice(-maxChars).trim();
}

/** Parses stdout without throwing: anything the agent reported as an error comes back as `failure`. */
export function parseCliOutput(format: CliOutputFormat, stdout: string): ParsedCliOutput {
  switch (format) {
    case 'text':
      return { text: stdout.trim() };
    case 'claude-json':
      return parseClaudeJson(stdout);
    case 'opencode-json':
      return parseOpencodeJson(stdout);
  }
}

function failureFrom(message: string): CliFailure {
  return { message, retryable: isLimitMessage(message) };
}

function parseClaudeJson(stdout: string): ParsedCliOutput {
  const json = parseJson(stdout);
  const parsed = ClaudeJsonSchema.safeParse(json);
  if (!parsed.success) return { text: '' };
  const data = parsed.data;
  if (data.is_error) return { text: '', failure: failureFrom(data.result ?? 'claude reported an error') };
  return {
    text: data.result?.trim() ?? '',
    costUsd: data.total_cost_usd,
    usage: data.usage && {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      cachedInputTokens: data.usage.cache_read_input_tokens,
    },
    raw: json,
  };
}

/** `opencode run --format json` emits one JSON event per line; the reply is the concatenated text parts. */
function parseOpencodeJson(stdout: string): ParsedCliOutput {
  const events: unknown[] = [];
  let text = '';
  for (const line of stdout.split('\n')) {
    const event = parseJson(line);
    if (event === undefined) continue;
    events.push(event);
    const parsed = OpencodeEventSchema.safeParse(event);
    if (!parsed.success) continue;
    if (parsed.data.type === 'error') {
      return { text: '', raw: events, failure: failureFrom(parsed.data.error?.message ?? 'opencode reported an error') };
    }
    if (parsed.data.part?.type === 'text') text += parsed.data.part.text ?? '';
  }
  return { text: text.trim(), raw: events };
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
