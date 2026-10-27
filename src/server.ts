import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatMessage, Effort } from './providers/types.js';
import { EFFORTS } from './providers/types.js';
import type { Router, RunResult } from './router/engine.js';
import type { TaskInput } from './router/types.js';

export const AUTO_MODEL = 'jev-auto';

export interface ServerOptions {
  router: Router;
  providerIds: string[];
  /** Require `Authorization: Bearer <key>` when set. */
  apiKey?: string;
  /** Auto-approve risky tasks (default false: respond 409 with the decision). */
  autoApprove?: boolean;
}

interface ChatBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  user?: string;
  reasoning_effort?: string;
  metadata?: Record<string, unknown>;
  jev?: { facts?: TaskInput['facts']; approve?: boolean; dryRun?: boolean };
}

/** OpenAI content may be a string or an array of parts; keep text parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

/** Map an OpenAI-style chat body to a router task. The last user message is the prompt. */
export function taskFromChat(body: ChatBody, headers: IncomingMessage['headers'], providerIds: string[]): TaskInput {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'request body must be a JSON object');
  const msgs = (body.messages ?? []).map((m) => ({ role: m.role, content: textOf(m.content) }));
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === 'user') { lastUser = i; break; }
  if (lastUser === -1) throw new HttpError(400, 'messages must contain a user message');

  const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const history = msgs
    .slice(0, lastUser)
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role === 'user' || m.role === 'assistant');
  const prompt = system ? `${system}\n\n${msgs[lastUser]!.content}` : msgs[lastUser]!.content;

  const header = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const sessionId =
    header('x-jev-session-id') ?? header('x-litellm-session-id') ?? header('x-claude-code-session-id') ??
    (typeof body.metadata?.session_id === 'string' ? body.metadata.session_id : undefined) ?? body.user;

  const task: TaskInput = { prompt, history, sessionId, facts: body.jev?.facts };
  const model = body.model ?? AUTO_MODEL;
  if (model !== AUTO_MODEL) {
    if (!providerIds.includes(model)) throw new HttpError(404, `unknown model "${model}" (use "${AUTO_MODEL}" or a provider id)`);
    task.forceProvider = model;
  }
  if (body.reasoning_effort && (EFFORTS as readonly string[]).includes(body.reasoning_effort)) {
    task.forceEffort = body.reasoning_effort as Effort;
  }
  return task;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

async function readJson(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function decisionSummary(r: RunResult) {
  const d = r.decision;
  return {
    assessment: {
      source: d.assessment.source,
      level: d.assessment.level,
      requiredIntelligence: d.assessment.requiredIntelligence,
      kind: d.assessment.kind,
      risk: d.assessment.risk,
      requireApproval: d.assessment.requireApproval,
      adjustments: d.assessment.adjustments,
      jev: d.assessment.jev,
    },
    plan: d.plan,
    pruneContext: d.pruneContext,
    attempts: r.attempts,
    top: d.candidates.slice(0, 5).map((c) => ({
      provider: c.providerId, effort: c.effort, intelligence: c.intelligence, pSuccess: c.pSuccess,
      cost: c.attemptCost, warm: c.cacheWarm, eligible: c.eligible,
    })),
  };
}

/** Constant-time bearer check (hash both sides so lengths match). */
export function bearerMatches(header: string | undefined, key: string): boolean {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${key}`));
}

export function createJevServer(opts: ServerOptions): Server {
  if (opts.apiKey === '') throw new Error('server apiKey is an empty string; unset it to disable auth or set a real key');
  const { router, providerIds } = opts;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });

    if (opts.apiKey !== undefined && !bearerMatches(req.headers.authorization, opts.apiKey)) {
      throw new HttpError(401, 'invalid API key');
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const now = Math.floor(Date.now() / 1000);
      return send(res, 200, {
        object: 'list',
        data: [AUTO_MODEL, ...providerIds].map((id) => ({ id, object: 'model', created: now, owned_by: 'jev-routing' })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/jev/decide') {
      const body = (await readJson(req)) as ChatBody;
      const decision = await router.decide(taskFromChat(body, req.headers, providerIds));
      return send(res, 200, decision);
    }

    if (req.method === 'POST' && url.pathname === '/v1/jev/feedback') {
      const b = (await readJson(req)) as { providerId?: string; effort?: string; ok?: boolean; sessionId?: string };
      if (!b.providerId || !b.effort || typeof b.ok !== 'boolean') throw new HttpError(400, 'providerId, effort, ok required');
      router.feedback(b.providerId, b.effort, b.ok, b.sessionId);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = (await readJson(req)) as ChatBody;
      const task = taskFromChat(body, req.headers, providerIds);
      const r = await router.run(task, { approve: opts.autoApprove || body.jev?.approve, dryRun: body.jev?.dryRun });
      if (r.needsApproval) {
        throw new HttpError(409, 'task flagged as high risk; resend with jev.approve=true', { jev: decisionSummary(r) });
      }
      if (!r.result) {
        if (body.jev?.dryRun) return send(res, 200, { jev: decisionSummary(r) });
        throw new HttpError(502, 'all providers failed', { jev: decisionSummary(r) });
      }
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = `${r.result.providerId}/${r.result.model}`;
      const usage = {
        prompt_tokens: r.result.usage?.inputTokens ?? 0,
        completion_tokens: r.result.usage?.outputTokens ?? 0,
        total_tokens: (r.result.usage?.inputTokens ?? 0) + (r.result.usage?.outputTokens ?? 0),
      };
      res.setHeader('x-jev-provider', r.result.providerId);
      res.setHeader('x-jev-effort', r.attempts.at(-1)?.effort ?? '');
      if (r.result.costUsd !== undefined) res.setHeader('x-jev-cost-usd', String(r.result.costUsd));

      if (body.stream) {
        // Providers are non-streaming; emit the whole completion as one SSE chunk for client compatibility.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: r.result.text }, null));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
        return;
      }
      return send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.result.text } as ChatMessage, finish_reason: 'stop' }],
        usage,
        jev: decisionSummary(r),
      });
    }

    throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error' }, ...(err instanceof HttpError ? err.extra : {}) });
      else res.end();
    });
  });
}
