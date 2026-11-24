import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Conversation } from '../apps/server/src/conversation.mjs';
import { buildServer } from '../apps/server/src/http.mjs';
class Fake extends EventEmitter {
  calls=[]; n=0;
  async initialize(){}
  async request(method,p){
    this.calls.push({method,p});
    switch(method){
      case 'account/read':return {account:{type:'chatgpt'}};
      case 'model/list':return {data:[{model:'test',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
      case 'thread/start':return {thread:{id:'thread'}};
      case 'turn/start':{ const id='turn'+ ++this.n; this.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:id,itemId:'a',delta:'early'}});return {turn:{id,status:'inProgress'}}; }
      case 'turn/interrupt':return {};
      case 'turn/steer':return {};
      default:throw Error('unsupported');
    }
  }
  close(){this.emit('disconnect');}
  finish(id='turn'+this.n,status='completed'){this.emit('notification',{method:'turn/completed',params:{threadId:'thread',turn:{id,status}}});}
}
async function setup(){const client=new Fake();const c=new Conversation({client,cwd:process.cwd()});await c.initialize();return {client,c};}
test('streams early events, isolates foreign turns, queues in order',async()=>{
  const {client,c}=await setup();await c.send({text:'first',model:'test',effort:'medium'});
  assert.equal(c.messages[1].text,'early');assert.equal(c.status,'running');
  client.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'wrong',itemId:'a',delta:'wrong'}});
  assert.equal(c.messages[1].text,'early');await c.send({text:'second'});assert.equal(c.queue.length,1);
  client.finish();await new Promise(r=>setImmediate(r));assert.equal(c.queue.length,0);assert.equal(client.n,2);
  assert.equal(c.messages[2].text,'second');client.finish();assert.equal(c.status,'completed');
  assert.equal(client.calls.filter(x=>x.method==='thread/start').length,1);
  assert.equal(client.calls.find(x=>x.method==='turn/start').p.sandboxPolicy.type,'readOnly');
});
test('stop clears queued tasks, steer uses active turn id',async()=>{
  const {client,c}=await setup();await c.send({text:'first'});await c.send({text:'second'});await c.steer({text:'correct'});
  assert.equal(client.calls.find(x=>x.method==='turn/steer').p.expectedTurnId,'turn1');await c.stop();assert.equal(c.queue.length,0);
  client.finish('turn1','interrupted');assert.equal(c.status,'interrupted');
});
test('approval requires active scoped request and explicit single decision',async()=>{
  const {c}=await setup();await c.send({text:'first'});
  await assert.rejects(c.requestApproval({method:'unknown',params:{}}));
  const p={threadId:'thread',turnId:'turn1',itemId:'tool',command:'echo test'};
  assert.deepEqual(await c.requestApproval({method:'item/commandExecution/requestApproval',params:{...p,networkApprovalContext:{host:'x'}}}),{decision:'decline'});
  const promise=c.requestApproval({method:'item/commandExecution/requestApproval',params:p});
  const id=c.snapshot().approvals[0].id;assert.throws(()=>c.resolveApproval(id,'acceptForSession'));
  c.resolveApproval(id,'accept');assert.deepEqual(await promise,{decision:'accept'});assert.throws(()=>c.resolveApproval(id,'accept'));
});
test('disconnect declines pending approval and never retries queued work',async()=>{
  const {c,client}=await setup();await c.send({text:'first'});await c.send({text:'later'});
  const p=c.requestApproval({method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn1',command:'echo x'}});
  client.close();assert.deepEqual(await p,{decision:'decline'});assert.equal(c.status,'disconnected');assert.equal(c.queue.length,0);
});
test('rejects invalid model and effort before any turn',async()=>{
  const {c,client}=await setup();await assert.rejects(c.send({text:'hi',model:'unknown'}));await assert.rejects(c.send({text:'hi',model:'test',effort:'high'}));assert.equal(client.n,0);
});
test('HTTP validates host, origin and token; only allowlisted actions',async t=>{
  const {c,client}=await setup();const app=await buildServer(c);t.after(()=>app.close());
  const host='127.0.0.1:4317',origin='http://'+host;
  const get=await app.inject({url:'/api/bootstrap',headers:{host}});assert.equal(get.statusCode,200);
  const token=get.json().token;
  assert.equal((await app.inject({url:'/api/bootstrap',headers:{host:'evil.example'}})).statusCode,403);
  const post=(headers,payload)=>app.inject({method:'POST',url:'/api/action',headers:{host,...headers},payload});
  assert.equal((await post({origin},{action:'send',text:'hi'})).statusCode,403);
  assert.equal((await post({origin:'https://evil.example','x-pacc-token':token},{action:'send',text:'hi'})).statusCode,403);
  assert.equal((await post({origin,'x-pacc-token':token},{action:'command/exec'})).statusCode,400);
  assert.equal((await post({origin,'x-pacc-token':token},{action:'send',text:'hi'})).statusCode,200);assert.equal(client.n,1);
});
