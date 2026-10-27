// Minimal ACP agent for tests: requires authenticate, supports model selection, streams chunks.
// FAKE_ACP_MODE: ok | noauth | refuse | crash | permission
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_ACP_MODE ?? 'ok';
let authed = false;
let model = 'm-medium';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined) return; // response to our permission request
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  const error = (message) => out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } });
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] });
    case 'authenticate': if (mode !== 'noauth') authed = true; return reply({});
    case 'session/new':
      if (!authed) return error('Authentication required');
      return reply({ sessionId: 's1', configOptions: [{ id: 'model', options: [{ value: 'm-low' }, { value: 'm-medium' }, { value: 'm-high' }] }] });
    case 'session/set_config_option': model = m.params.value; return reply({});
    case 'session/prompt': {
      if (mode === 'crash') process.exit(3);
      if (mode === 'permission') out({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {} });
      const text = m.params.prompt[0].text;
      for (const part of [`[${model}] `, `echo: ${text.split('\n').at(-1)}`]) {
        out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } } } });
      }
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1234 } } });
      return reply({ stopReason: mode === 'refuse' ? 'refusal' : 'end_turn' });
    }
    default: return error('unknown');
  }
});
