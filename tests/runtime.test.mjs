import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CodexClient } from '../apps/server/src/runtime/codex/client.mjs';
import { smoke } from '../apps/server/src/runtime/codex/smoke.mjs';
const fixture = fileURLToPath(new URL('./fixtures/mock-codex.mjs', import.meta.url));
const options = { executable: process.execPath, args: [fixture] };
async function connected(t, opts = {}) { const c = new CodexClient({ ...options, ...opts }); t.after(() => c.close()); await c.initialize(); return c; }
test('handshake and account detection', async t => { const c = await connected(t); assert.equal((await c.request('account/read', {})).account.type, 'chatgpt'); await assert.rejects(c.initialize(), /Already/); });
test('requests before initialize rejected', async t => { const c = new CodexClient(options); t.after(() => c.close()); await assert.rejects(c.request('account/read'), /Initialize/); });
test('unsupported server approval is rejected', async t => { const c = await connected(t); const denial = once(c, 'notification'); await c.request('mock/approval'); assert.equal((await denial)[0].method, 'mock/denied'); });
test('RPC errors propagate', async t => { const c = await connected(t); await assert.rejects(c.request('missing'), { code: -32601 }); });
test('request timeout does not retry', async t => { const c = await connected(t, { timeoutMs: 1000 }); await assert.rejects(c.request('mock/hang'), /timed out/); });
test('child exit rejects outstanding requests', async t => { const c = await connected(t); const hanging = c.request('mock/hang'); const crash = c.request('mock/crash'); await Promise.all([assert.rejects(hanging, /exited/), assert.rejects(crash, /exited/)]); });
test('malformed JSON fails closed', async t => { const c = await connected(t); await assert.rejects(c.request('mock/bad'), /Invalid JSON/); });
test('preflight does not start a turn', async () => { assert.deepEqual(await smoke(options), { auth: { type: 'chatgpt', plan: 'plus' } }); });
test('API key mode rejected', async () => { await assert.rejects(smoke({ ...options, args: [fixture, 'api'] }), /ChatGPT account required/); });
test('live smoke flow with mock: early events, thread filter and reconnect', async () => { let text = ''; const result = await smoke({ ...options, cwd: process.cwd(), live: true, onDelta: x => { text += x; } }); assert.equal(text, 'OKPACC-731'); assert.equal(result.resumed, true); });
