import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ChatRequestBody {
  model: string;
  messages: { role: string; content: string }[];
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: ChatRequestBody | undefined;
}

export interface MockLiteLLM {
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:52311/v1 */
  url: string;
  requests: RecordedRequest[];
  /** The next chat call for `model` answers with `status` instead of a completion. Queues per call. */
  failNext(model: string, status: number): void;
  /** Every chat call for `model` waits `ms` before answering. Pass 0 to clear. */
  delay(model: string, ms: number): void;
  close(): Promise<void>;
}

export interface MockLiteLLMOptions {
  models?: string[];
}

const DEFAULT_MODELS = ['claude-opus-5-5', 'gpt-6-1-sol', 'gemini-3-pro'];

/** A local stand-in for a LiteLLM proxy: echoes the model and last message, records requests. */
export async function startMockLiteLLM(opts: MockLiteLLMOptions = {}): Promise<MockLiteLLM> {
  const models = opts.models ?? DEFAULT_MODELS;
  const requests: RecordedRequest[] = [];
  const failures = new Map<string, number[]>();
  const delays = new Map<string, number>();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendJson(res, 500, { error: { message: String(err) } }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as ChatRequestBody) : undefined;
    requests.push({ method: req.method ?? '', path, headers: req.headers, body });

    if (req.method === 'GET' && path === '/v1/models') {
      sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
      return;
    }
    if (req.method === 'POST' && path === '/v1/chat/completions' && body) {
      await answerChat(res, body);
      return;
    }
    sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });
  }

  async function answerChat(res: ServerResponse, body: ChatRequestBody): Promise<void> {
    const wait = delays.get(body.model) ?? 0;
    if (wait > 0) await sleep(wait);
    const status = failures.get(body.model)?.shift();
    if (status !== undefined) {
      sendJson(res, status, { error: { message: `mock failure for ${body.model}`, type: 'mock_error' } });
      return;
    }
    const last = body.messages.at(-1)?.content ?? '';
    sendJson(
      res,
      200,
      {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `${body.model}: ${last}` },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
      { 'x-litellm-response-cost': '0.00042' },
    );
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    failNext(model, status) {
      failures.set(model, [...(failures.get(model) ?? []), status]);
    },
    delay(model, ms) {
      delays.set(model, ms);
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
