import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { HistoryStore } from './history.mjs';
import { createCodexSession } from './runtime/codex/session.mjs';
import { SessionManager } from './sessions.mjs';
import { buildServer } from './http.mjs';

const port=4317;
const path=resolve(process.env.PACC_DATA_PATH||join(homedir(),'.pacc','history.sqlite'));
const manager=new SessionManager({createSession:createCodexSession});
manager.booting=true;
let app,restored=false,closing=false;
async function close(){
  if(closing)return;closing=true;
  try{manager.close({persist:restored});}catch(error){console.error(error.message);}
  if(app){app.websocketServer?.clients.forEach(socket=>socket.terminate());await app.close();}
}
process.once('SIGINT',close);process.once('SIGTERM',close);
try {
  // Bind before opening the database: a second local instance cannot overwrite it.
  app=await buildServer(manager,{port,staticRoot:fileURLToPath(new URL('../../../dist/',import.meta.url))});
  await app.listen({host:'127.0.0.1',port});
  manager.store=new HistoryStore(path);
  if(closing){manager.store.close();throw Error('Startup cancelled');}
  const initialized=manager.restore();restored=true;
  if(!initialized){
    const cwd=await realpath(process.env.PACC_WORKSPACE||process.cwd());
    const projectId=await manager.register(cwd,undefined,{allowDirectory:true});
    await manager.addSession(projectId,'Current conversation',process.env.PACC_WORKSPACE_WRITE==='1'?'existing':'read-only');
  }
  manager.flush();
  manager.booting=false;
  if(manager.store.migrationBackup)console.log('Pre-migration backup: '+manager.store.migrationBackup);
  console.log('PACC: http://127.0.0.1:'+port);
  console.log('History: '+path);
}catch(error){await close();console.error(error.message);process.exitCode=1;}
