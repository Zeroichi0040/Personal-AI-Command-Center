import { CodexClient } from './client.mjs';

function runTurn(client, threadId, text, onDelta, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Subscribe before sending the request: completion can precede the RPC reply.
    let turnId, acknowledged = false;
    const early = [];
    const clean = () => { clearTimeout(timer); client.off('notification', receive); client.off('disconnect', failed); };
    const failed = error => { clean(); reject(error); };
    const receive = ({ method, params }) => {
      if (params?.threadId !== threadId) return;
      if (method !== 'item/agentMessage/delta' && method !== 'turn/completed') return;
      if (!acknowledged) { early.push({ method, params }); return; }
      const eventTurnId = method === 'turn/completed' ? params.turn?.id : params.turnId;
      if (eventTurnId !== turnId) return;
      if (method === 'item/agentMessage/delta') { if (typeof params.delta === 'string') onDelta(params.delta); return; }
      clean();
      if (params.turn.status === 'completed') resolve();
      else reject(new Error(`Turn ended with status ${params.turn.status ?? 'unknown'}`));
    };
    const timer = setTimeout(() => failed(new Error('Turn timed out; no automatic retry')), timeoutMs);
    client.on('notification', receive); client.once('disconnect', failed);
    client.request('turn/start', { threadId, input: [{ type: 'text', text }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } }).then(result => {
      turnId = result?.turn?.id;
      if (typeof turnId !== 'string') { failed(new Error('Missing turn ID')); return; }
      acknowledged = true;
      for (const event of early) receive(event);
    }, failed);
  });
}

export async function smoke({ executable, args, cwd, live = false, onDelta = () => {}, onStep = () => {}, timeoutMs = 180_000 } = {}) {
  const options = { executable, args };
  let client = new CodexClient(options);
  try {
    await client.initialize(); onStep('Handshake OK');
    const { account } = await client.request('account/read', { refreshToken: false });
    // No API-key fallback: this experiment is specifically for ChatGPT-plan access.
    const auth = { type: account?.type ?? null, plan: account?.planType ?? null };
    onStep(`Account mode: ${auth.type ?? 'not signed in'}; plan: ${auth.plan ?? 'not reported'}`);
    if (auth.type !== 'chatgpt') throw new Error('ChatGPT account required. Run codex login using ChatGPT and retry.');
    if (!live) return { auth };
    const result = await client.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string') throw new Error('Missing thread ID');
    await runTurn(client, threadId, 'Remember the codeword PACC-731. Reply with only OK. Do not use tools.', onDelta, timeoutMs);
    onStep('First turn completed');
    // Reconnect to prove native persistence rather than just in-process memory.
    client.close(); client = new CodexClient(options);
    await client.initialize();
    const resumed = await client.request('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
    if (resumed?.thread?.id !== threadId) throw new Error('Resume returned a different thread');
    let answer = '';
    await runTurn(client, threadId, 'What codeword did I ask you to remember? Reply with just the codeword. Do not use tools.', delta => { answer += delta; onDelta(delta); }, timeoutMs);
    if (!answer.includes('PACC-731')) throw new Error('Resume completed but recall check failed');
    onStep('Native thread resume and recall OK');
    return { auth, threadId, resumed: true };
  } finally { client.close(); }
}
