import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionManager} from '../apps/server/src/sessions.mjs';
import {HistoryStore} from '../apps/server/src/history.mjs';

class Fake extends EventEmitter{
  status='idle';calls=[];
  async initialize(){}
  active(){return ['starting','running','stopping'].includes(this.status);}
  snapshot(){return {status:this.status,connected:true,messages:[],queue:[],approvals:[]};}
  async send(data){this.calls.push(data);this.status='running';this.emit('state');}
  complete(status='completed'){this.status=status;this.emit('state');}
  async stop(){this.complete('interrupted');}
}
const workspace={repoRoot:async p=>p,overlaps:(a,b)=>a===b};
function setup(store=new HistoryStore(':memory:')){return new SessionManager({store,workspace,createSession:()=>({conversation:new Fake(),close:()=>{}})});}
async function fixture(m){
  const p=await m.register(join(tmpdir(),'task-project')),s=await m.addSession(p,'Worker');
  const {taskId:t}=await m.dispatch({action:'createTask',projectId:p,title:'Fix bug',description:'Fix reproduction',criteria:'Tests pass',priority:'high'});
  await m.dispatch({action:'assignTask',taskId:t,assignedSessionId:s});
  await m.dispatch({action:'moveTask',taskId:t,status:'ready'});return {p,s,t};
}
test('dispatch once, no queued chat, completed goes to review, done is manual',async()=>{
  const m=setup();try{
    const {s,t}=await fixture(m);
    await assert.rejects(m.dispatch({action:'moveTask',taskId:t,status:'done'}),/Review/);
    await m.dispatch({action:'dispatchTask',taskId:t});
    assert.equal(m.tasks.get(t).status,'in-progress');assert.match(m.session(s).conversation.calls[0].text,/Tests pass/);
    await assert.rejects(m.dispatch({action:'dispatchTask',taskId:t}),/idle/);
    await assert.rejects(m.dispatch({action:'send',sessionId:s,text:'unrelated'}),/task is executing/);
    await assert.rejects(m.dispatch({action:'deleteTask',taskId:t}),/executing/);
    m.session(s).conversation.complete();
    assert.equal(m.tasks.get(t).status,'review');assert.equal(m.tasks.get(t).attempts[0].outcome,'completed');
    await m.dispatch({action:'moveTask',taskId:t,status:'done'});assert.equal(m.tasks.get(t).status,'done');
  }finally{m.close();}
});
test('project assignment and global generation limit enforced',async()=>{
  const m=setup();try{
    const {p,s,t}=await fixture(m),q=await m.register(join(tmpdir(),'other-project')),b=await m.addSession(q,'Other'),c=await m.addSession(p,'Third');
    await assert.rejects(m.dispatch({action:'assignTask',taskId:t,assignedSessionId:b}),/share a project/);
    await m.dispatch({action:'send',sessionId:b,text:'a'});await m.dispatch({action:'send',sessionId:c,text:'b'});
    await assert.rejects(m.dispatch({action:'dispatchTask',taskId:t}),/slots/);assert.equal(m.tasks.get(t).status,'ready');assert.equal(m.session(s).conversation.calls.length,0);
  }finally{m.close();}
});
test('interrupted task retains attempt and requires explicit retry',async()=>{
  const m=setup();try{
    const {s,t}=await fixture(m);await m.dispatch({action:'dispatchTask',taskId:t});await m.dispatch({action:'stop',sessionId:s});
    assert.equal(m.tasks.get(t).status,'review');assert.equal(m.tasks.get(t).attempts[0].outcome,'interrupted');
    await assert.rejects(m.dispatch({action:'dispatchTask',taskId:t}),/Ready/);
    await m.dispatch({action:'moveTask',taskId:t,status:'ready'});await m.dispatch({action:'dispatchTask',taskId:t});assert.equal(m.tasks.get(t).attempts.length,2);
  }finally{m.close();}
});
test('persisted active attempt becomes uncertain review without launching runtime',async()=>{
  const m=setup();try{
    const {t}=await fixture(m);await m.dispatch({action:'dispatchTask',taskId:t});
    const copy=new HistoryStore(':memory:');const state=m.store.load();copy.save(state.projects,state.sessions,state.tasks);
    let launched=0;const next=new SessionManager({store:copy,workspace,createSession:()=>{launched++;}});
    try{next.restore();assert.equal(launched,0);assert.equal(next.tasks.get(t).status,'review');assert.equal(next.tasks.get(t).attempts[0].outcome,'uncertain');assert.equal(next.tasks.get(t).activeAttempt,null);}finally{next.close();}
  }finally{m.close();}
});
test('closing session unassigns tasks, deleting project cannot silently remove them',async()=>{
  const m=setup();try{
    const {p,s,t}=await fixture(m);m.closeSession(s);assert.equal(m.tasks.get(t).sessionId,null);
    assert.throws(()=>m.removeProject(p),/tasks/);await m.dispatch({action:'deleteTask',taskId:t});m.removeProject(p);assert.equal(m.projects.size,0);
  }finally{m.close();}
});
test('failed task checkpoint never dispatches work',async()=>{
  const m=setup();try{
    const {s,t}=await fixture(m);const save=m.store.save.bind(m.store);m.store.save=()=>{throw Error('disk failure');};
    await assert.rejects(m.dispatch({action:'dispatchTask',taskId:t}),/disk failure/);
    assert.equal(m.session(s).conversation.calls.length,0);assert.equal(m.tasks.get(t).status,'ready');m.store.save=save;
  }finally{m.close();}
});
