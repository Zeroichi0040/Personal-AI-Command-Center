import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCodexSession } from './runtime/codex/session.mjs';
import { SessionManager } from './sessions.mjs';
import { buildServer } from './http.mjs';

const port=4317;
const cwd=await realpath(process.env.PACC_WORKSPACE||process.cwd());
const manager=new SessionManager({createSession:createCodexSession});
let app;
try {
  const projectId=await manager.register(cwd,undefined,{allowDirectory:true});
  await manager.addSession(projectId,'Current conversation',process.env.PACC_WORKSPACE_WRITE==='1'?'existing':'read-only');
  app=await buildServer(manager,{port,staticRoot:fileURLToPath(new URL('../../../dist/',import.meta.url))});
  await app.listen({host:'127.0.0.1',port});
  console.log('PACC: http://127.0.0.1:'+port);
  console.log('Workspace: '+cwd);
}catch(error){manager.close();if(app)await app.close();console.error(error.message);process.exitCode=1;}
let closing=false;
async function close(){if(closing)return;closing=true;manager.close();if(app){app.websocketServer?.clients.forEach(socket=>socket.terminate());await app.close();}}
process.once('SIGINT',close);process.once('SIGTERM',close);
