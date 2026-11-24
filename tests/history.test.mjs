import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {HistoryStore} from '../apps/server/src/history.mjs';
import {SessionManager} from '../apps/server/src/sessions.mjs';
import {Conversation} from '../apps/server/src/conversation.mjs';

test('SQLite persists history and FTS across reopen; deleting session removes search results',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pacc-history-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'history.sqlite');let store=new HistoryStore(path);
  const project={id:'p',name:'Project',root:dir};
  const session={id:'s',projectId:'p',saved:{threadId:'native',status:'completed',messages:[{id:'m',kind:'user',text:'unique PACC codeword'}]}};
  store.save([project],[session]);store.close();store=new HistoryStore(path);
  try{assert.deepEqual(store.load().sessions,[session]);assert.equal(store.search('PACC codeword')[0].sessionId,'s');assert.doesNotThrow(()=>store.search('" OR *'));store.save([project],[]);assert.deepEqual(store.search('PACC'),[]);}finally{store.close();}
});
test('restore offline, never recreate worktree or replay; explicit reconnect requires acknowledgement',async()=>{
  const store=new HistoryStore(':memory:');const root=join(tmpdir(),'test-project'),cwd=join(tmpdir(),'test-worktree');
  const saved={threadId:'native',status:'running',messages:[{id:'m',kind:'user',text:'old prompt'}]};
  store.save([{id:'p',root,name:'Project'}],[{id:'s',projectId:'p',name:'Work',mode:'isolated',cwd,writable:true,branch:'pacc/s',saved}]);
  let created=0,resumed=0;
  class Fake extends EventEmitter{
    active(){return false;}
    snapshot(){return {connected:true,status:'idle',threadId:'native',messages:saved.messages};}
    async resume(data){assert.deepEqual(data,saved);resumed++;}
  }
  const workspace={directory:async p=>p,repoRoot:async p=>p,inspect:async()=>({branch:'pacc/s'}),overlaps:()=>false,createWorktree:()=>{throw Error('must not recreate');}};
  const m=new SessionManager({store,workspace,createSession:()=>{created++;return {conversation:new Fake(),close:()=>{}};}});
  assert.equal(m.restore(),true);assert.equal(created,0);
  const s=m.snapshot().sessions[0];assert.equal(s.conversation.status,'offline');assert.deepEqual(s.conversation.queue,[]);assert.deepEqual(s.conversation.approvals,[]);
  await assert.rejects(m.reconnect('s',false),/Confirm/);assert.equal(created,0);
  await m.reconnect('s',true);assert.equal(created,1);assert.equal(resumed,1);assert.equal(m.snapshot().sessions[0].conversation.connected,true);m.close();
});
test('native resume uses same ID and no turn/start or replay',async()=>{
  class Client extends EventEmitter{
    calls=[];async initialize(){}
    async request(method,p){this.calls.push({method,p});if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='model/list')return {data:[]};if(method==='thread/resume')return {thread:{id:p.threadId,status:{type:'idle'},turns:[]}};throw Error(method);}
  }
  const client=new Client(),c=new Conversation({client,cwd:process.cwd()});
  await c.resume({threadId:'native',status:'completed',messages:[{id:'m',kind:'user',text:'old'}]});
  assert.equal(c.threadId,'native');assert.equal(c.status,'idle');assert.equal(c.messages.length,1);assert.deepEqual(c.queue,[]);assert.equal(c.pending.size,0);
  assert.equal(client.calls.find(x=>x.method==='thread/resume').p.sandbox,'read-only');assert.equal(client.calls.some(x=>x.method==='turn/start'),false);
});

test('missing workspace leaves history available without launching a runtime',async()=>{
  const store=new HistoryStore(':memory:');
  store.save([{id:'p',root:'/missing',name:'Missing'}],[{id:'s',projectId:'p',name:'Saved',mode:'read-only',cwd:'/missing',writable:false,saved:{threadId:'native',status:'completed',messages:[{id:'m',kind:'user',text:'preserved text'}]}}]);
  let created=0;
  const m=new SessionManager({store,workspace:{directory:async()=>{throw Error('missing directory');}},createSession:()=>{created++;}});
  m.restore();
  await assert.rejects(m.reconnect('s',false),/missing directory/);
  assert.equal(created,0);assert.equal(m.snapshot().sessions[0].conversation.connected,false);
  assert.equal((await m.dispatch({action:'searchHistory',query:'preserved'})).results.length,1);
  assert.equal((await m.dispatch({action:'exportSession',sessionId:'s'})).export.messages[0].text,'preserved text');m.close();
});
test('failed checkpoint prevents dispatching a model turn',async()=>{
  class Client extends EventEmitter{
    calls=[];async initialize(){}
    async request(method,p){this.calls.push(method);if(method==='account/read')return {account:{type:'chatgpt'}};if(method==='model/list')return {data:[]};if(method==='thread/start')return {thread:{id:'native'}};throw Error(method);}
  }
  const client=new Client(),c=new Conversation({client,cwd:process.cwd()});
  await c.initialize();
  c.checkpoint=()=>{if(c.threadId)throw Error('database unavailable');};
  await c.send({text:'do not replay'});
  assert.equal(c.status,'uncertain');assert.equal(client.calls.includes('turn/start'),false);
});
