import { createInterface } from 'node:readline';
const mode = process.argv[2];
let initialized = false;
const send = data => console.log(JSON.stringify(data));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, error } = JSON.parse(line);
  const reply = result => send({ id, result });
  if (id === 'approval-1' && error) { send({ method: 'mock/denied', params: {} }); continue; }
  if (method === 'initialize') { reply({ userAgent: 'mock' }); continue; }
  if (method === 'initialized') { initialized = true; continue; }
  if (!initialized) { send({ id, error: { code: -32000 } }); continue; }
  switch (method) {
    case 'account/read': reply({ account: { type: mode === 'api' ? 'apiKey' : 'chatgpt', planType: 'plus' } }); break;
    case 'thread/start': case 'thread/resume':
      if (params.sandbox !== 'read-only' || params.approvalPolicy !== 'never') { send({ id, error: { code: -32602 } }); break; }
      reply({ thread: { id: 'thread-1' } }); break;
    case 'turn/start': {
      if (params.sandboxPolicy?.type !== 'readOnly' || params.approvalPolicy !== 'never') { send({ id, error: { code: -32602 } }); break; }
      const turnId = 'turn-1';
      send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', turnId, delta: 'WRONG' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, delta: params.input[0].text.startsWith('Remember') ? 'OK' : 'PACC-731' } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } } });
      reply({ turn: { id: turnId } }); break;
    }
    case 'mock/approval': send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} }); reply({}); break;
    case 'mock/hang': break;
    case 'mock/crash': process.exit(2); break;
    case 'mock/bad': console.log('not json'); break;
    default: send({ id, error: { code: -32601 } });
  }
}
