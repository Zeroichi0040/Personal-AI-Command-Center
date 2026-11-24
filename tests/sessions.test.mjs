import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SessionManager} from '../apps/server/src/sessions.mjs';
import * as git from '../apps/server/src/workspaces.mjs';

class Fake extends EventEmitter {
  status='idle'; calls=[]; pending=[];
  async initialize(){}
  active(){return ['starting','running','stopping'].includes(this.status);}
  snapshot(){return {status:this.status,approvals:this.pending,messages:[]};}
  async send(data){this.calls.push(['send',data.text]);this.status='running';this.emit('state');}
  async stop(){this.status='interrupted';this.emit('state');}
  async steer(data){this.calls.push(['steer',data.text]);}
  resolveApproval(id,decision){if(!this.pending.some(p=>p.id===id))throw Error('Invalid approval');this.calls.push(['approval',id,decision]);this.pending=[];}
  removeQueued(){}
}
const workspace={repoRoot:async p=>p,directory:async p=>p,overlaps:git.overlaps,createWorktree:async(_root,id)=>({cwd:join(tmpdir(),id),branch:'pacc/'+id}),inspect:async()=>({branch:'main',status:'clean',diff:''})};
function setup(){return new SessionManager({workspace,createSession:()=>{const conversation=new Fake();return {conversation,close:()=>{conversation.status='disconnected';}};}});}
test('independent sessions and centralized two-generation limit',async()=>{
  const m=setup();const p=await m.register(join(tmpdir(),'project-a'));
  const a=await m.addSession(p,'A'),b=await m.addSession(p,'B'),c=await m.addSession(p,'C');
  await Promise.all([m.dispatch({action:'send',sessionId:a,text:'a'}),m.dispatch({action:'send',sessionId:b,text:'b'})]);
  await assert.rejects(m.dispatch({action:'send',sessionId:c,text:'c'}),/slots/);
  await m.dispatch({action:'send',sessionId:a,text:'queued'});assert.equal(m.activeCount(),2);
  await m.dispatch({action:'stop',sessionId:a});await m.dispatch({action:'send',sessionId:c,text:'c'});
  assert.equal(m.session(b).conversation.status,'running');assert.equal(m.activeCount(),2);
  assert.throws(()=>m.closeSession(b),/active/);assert.throws(()=>m.removeProject(p),/sessions/);
  m.session(b).conversation.status='uncertain';assert.equal(m.activeCount(),2);m.close();
});
test('writable reservations, isolated sessions and approval routing',async()=>{
  const m=setup();const p=await m.register(join(tmpdir(),'project-b'));
  const a=await m.addSession(p,'Writable','existing');
  await assert.rejects(m.addSession(p,'Conflicting','existing'),/overlapping/);
  const b=await m.addSession(p,'Reader','read-only'),c=await m.addSession(p,'Isolated','isolated');
  assert.notEqual(m.session(a).cwd,m.session(c).cwd);
  m.session(b).conversation.pending=[{id:'b-approval'}];m.session(c).conversation.pending=[{id:'c-approval'}];
  await assert.rejects(m.dispatch({action:'approval',sessionId:c,id:'b-approval',decision:'accept'}),/Invalid approval/);
  await assert.rejects(m.dispatch({action:'approval',sessionId:b,id:'b-approval',decision:'accept'}),/overlapping/);
  await m.dispatch({action:'approval',sessionId:c,id:'c-approval',decision:'accept'});
  m.closeSession(a);await m.dispatch({action:'approval',sessionId:b,id:'b-approval',decision:'accept'});
  const next=await m.addSession(p,'Writable again','existing');assert.ok(next);
  m.close();
});
test('concurrent creation cannot reserve the same writable workspace twice',async()=>{
  const m=setup();const p=await m.register(join(tmpdir(),'project-c'));
  const results=await Promise.allSettled([m.addSession(p,'one','existing'),m.addSession(p,'two','existing')]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);m.close();
});
test('real Git worktree creates a separate branch without copying dirty changes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pacc-test-repo-'));let worktree;
  const run=promisify(execFile);
  const command=(cwd,args)=>run('git',['-C',cwd,...args],{windowsHide:true});
  t.after(async()=>{if(worktree){await command(root,['worktree','remove','--force',worktree.cwd]);await rm(join(worktree.cwd,'..'),{recursive:true,force:true});}await rm(root,{recursive:true,force:true});});
  await command(root,['init']);await command(root,['config','user.name','PACC Test']);await command(root,['config','user.email','test@example.invalid']);
  await writeFile(join(root,'file.txt'),'base');await command(root,['add','file.txt']);await command(root,['commit','-m','base']);
  await writeFile(join(root,'file.txt'),'dirty');
  worktree=await git.createWorktree(await git.repoRoot(root),'test-session');
  assert.equal((await git.inspect(worktree.cwd)).branch,'pacc/test-session');
  assert.match((await git.inspect(root)).status,/file.txt/);
  assert.equal((await git.inspect(worktree.cwd)).diff,'');
  assert.equal(git.overlaps(root,worktree.cwd),false);
});
