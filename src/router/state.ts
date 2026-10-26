import type { TaskFacts, TaskInput } from './types.js';

export interface StateOptions {
  contextWindowTurns: number;
  contextBudgetChars: number;
  includeAssistantTurns: boolean;
  /** Max chars of the current prompt sent to Jev (32K-token question limit, keep well under). */
  promptBudgetChars?: number;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|oc_sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Strip secrets before anything leaves the machine for classification. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[REDACTED]'), text);
}

/** Keep head and tail of long text: instructions tend to be at the start, the ask at the end. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head - 20;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars omitted]…\n${text.slice(-tail)}`;
}

/** Facts computed in code: Jev doesn't count or do arithmetic, so we hand it booleans/buckets. */
export function deriveFacts(task: TaskInput): Record<string, string | number | boolean> {
  const f: TaskFacts = task.facts ?? {};
  const promptTokens = estimateTokens(task.prompt);
  const historyTokens = (task.history ?? []).reduce((n, m) => n + estimateTokens(m.content), 0);
  const ctx = f.contextTokens ?? promptTokens + historyTokens;
  const out: Record<string, string | number | boolean> = {
    prompt_length: bucket(promptTokens, [50, 400, 2000], ['very short', 'short', 'medium', 'long']),
    context_size: bucket(ctx, [2_000, 20_000, 100_000], ['small', 'medium', 'large', 'huge']),
    has_prior_conversation: (task.history?.length ?? 0) > 0,
    mentions_code: /```|\b(function|class|def|const|import|SELECT|diff --git)\b/.test(task.prompt),
  };
  if (f.diffLines !== undefined) {
    out.diff_size = bucket(f.diffLines, [30, 300, 1000], ['tiny', 'small', 'large', 'very large']);
  }
  if (f.filesTouched !== undefined) {
    out.files_touched = bucket(f.filesTouched, [1, 5, 20], ['one', 'a few', 'many', 'very many']);
  }
  if (f.consecutiveTestFailures !== undefined) {
    out.repeated_test_failures = f.consecutiveTestFailures >= 2;
  }
  if (f.hasSpecArtifact !== undefined) out.has_written_spec = f.hasSpecArtifact;
  return out;
}

function bucket(n: number, edges: number[], labels: string[]): string {
  const i = edges.findIndex((e) => n <= e);
  return labels[i === -1 ? labels.length - 1 : i]!;
}

/**
 * Compact, sanitised state for Jev: the current ask, a few recent user turns
 * (assistant output excluded by default — code dumps hurt calibration), and
 * pre-computed facts.
 */
export function buildJevState(task: TaskInput, opts: StateOptions): Record<string, unknown> {
  const promptBudget = opts.promptBudgetChars ?? 12_000;
  const prior = (task.history ?? []).filter((m) => opts.includeAssistantTurns || m.role === 'user');
  const recent: string[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0 && recent.length < opts.contextWindowTurns; i--) {
    const m = prior[i]!;
    const text = clip(redact(m.content), Math.max(200, opts.contextBudgetChars - used));
    if (used + text.length > opts.contextBudgetChars) break;
    used += text.length;
    recent.unshift(opts.includeAssistantTurns ? `${m.role}: ${text}` : text);
  }
  const state: Record<string, unknown> = { task: clip(redact(task.prompt), promptBudget) };
  if (recent.length) state.recent_user_turns = recent;
  state.facts = deriveFacts(task);
  return state;
}
