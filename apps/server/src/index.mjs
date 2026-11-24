import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CodexClient } from './runtime/codex/client.mjs';
import { Conversation } from './conversation.mjs';
import { buildServer } from './http.mjs';

const port = 4317;
const cwd = await realpath(process.env.PACC_WORKSPACE || process.cwd());
if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory');
const writable = process.env.PACC_WORKSPACE_WRITE === '1';
let conversation;
const client = new CodexClient({ serverRequest: request => conversation.requestApproval(request) });
conversation = new Conversation({client,cwd,writable});
let app;
try {
  await conversation.initialize();
  app = await buildServer(conversation,{port,staticRoot:fileURLToPath(new URL('../../../dist/',import.meta.url))});
  await app.listen({host:'127.0.0.1',port});
  console.log('PACC: http://127.0.0.1:' + port);
  console.log('Workspace: ' + cwd + ' (' + (writable ? 'workspace-write' : 'read-only') + ')');
} catch (error) { client.close(); if (app) await app.close(); console.error(error.message); process.exitCode=1; }
let closing=false;
async function close() { if(closing)return; closing=true; client.close(); if(app) { app.websocketServer?.clients.forEach(socket=>socket.terminate()); await app.close(); } }
process.once('SIGINT',close); process.once('SIGTERM',close);
