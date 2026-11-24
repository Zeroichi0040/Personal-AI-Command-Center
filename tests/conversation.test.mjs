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
  client.close();assert.deepEqual(await p,{decision:'decline'});assert.equal(c.status,'uncertain');assert.equal(c.queue.length,0);
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
  assert.equal((await post({origin,'x-pacc-token':'é'.repeat(64)},{action:'send',text:'hi'})).statusCode,403);
  assert.equal((await post({origin:'https://evil.example','x-pacc-token':token},{action:'send',text:'hi'})).statusCode,403);
  assert.equal((await post({origin,'x-pacc-token':token},{action:'command/exec'})).statusCode,400);
  assert.equal((await post({origin,'x-pacc-token':token},{action:'send',text:'hi'})).statusCode,200);assert.equal(client.n,1);
});

test('server-resolved approvals cannot be accepted later',async()=>{
  const {c,client}=await setup();await c.send({text:'first'});
  const p=c.requestApproval({id:123,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn1',command:'echo x'}});
  const id=c.snapshot().approvals[0].id;client.emit('notification',{method:'serverRequest/resolved',params:{threadId:'thread',requestId:123}});
  assert.deepEqual(await p,{decision:'decline'});assert.throws(()=>c.resolveApproval(id,'accept'));
});

test('one-time command approval tolerates optional persistent-policy hints',async()=>{
  const {c}=await setup();await c.send({text:'first'});
  const p=c.requestApproval({id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn1',itemId:'cmd',command:'git status --short',proposedExecpolicyAmendment:['git','status'],availableDecisions:['accept','acceptForSession',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['git','status']}},'decline']}});
  const approval=c.snapshot().approvals[0];assert.ok(approval);assert.match(approval.details,/git status --short/);
  assert.throws(()=>c.resolveApproval(approval.id,'acceptForSession'));
  c.resolveApproval(approval.id,'accept');assert.deepEqual(await p,{decision:'accept'});
});
test('omitted command is recovered only from the matching active started item',async()=>{
  const {c,client}=await setup();await c.send({text:'first'});
  client.emit('notification',{method:'item/started',params:{threadId:'thread',turnId:'turn1',item:{id:'cmd',type:'commandExecution',command:'git status --short',cwd:'/repo',status:'inProgress'}}});
  const params={threadId:'thread',turnId:'turn1',itemId:'cmd'};
  const p=c.requestApproval({method:'item/commandExecution/requestApproval',params});
  const approval=c.snapshot().approvals[0];assert.equal(JSON.parse(approval.details).command,'git status --short');assert.equal(JSON.parse(approval.details).cwd,'/repo');
  c.resolveApproval(approval.id,'decline');assert.deepEqual(await p,{decision:'decline'});
  assert.deepEqual(await c.requestApproval({method:'item/commandExecution/requestApproval',params:{...params,itemId:'other'}}),{decision:'decline'});
  assert.match(c.messages.at(-1).label,/No reviewable command/);
  client.emit('notification',{method:'item/completed',params:{threadId:'thread',turnId:'turn1',item:{id:'cmd',type:'commandExecution',command:'git status --short',status:'declined'}}});
  assert.equal(c.messages.find(m=>m.id==='turn1:cmd:tool').label,'Declined command git status --short');
  assert.deepEqual(await c.requestApproval({method:'item/commandExecution/requestApproval',params}),{decision:'decline'});
});
test('actual permission requests remain blocked with visible reasons',async()=>{
  const {c}=await setup();await c.send({text:'first'});
  const params={threadId:'thread',turnId:'turn1',itemId:'cmd',command:'echo test'};
  for(const [fields,reason] of [[{networkApprovalContext:{host:'example.com'}},/network approvals/],[{additionalPermissions:{network:{enabled:true}}},/Additional sandbox permissions/],[{grantRoot:'/other'},/filesystem grants/],[{availableDecisions:['acceptForSession','decline']},/one-time acceptance/]]){
    assert.deepEqual(await c.requestApproval({method:'item/commandExecution/requestApproval',params:{...params,...fields}}),{decision:'decline'});
    assert.equal(c.snapshot().approvals.length,0);assert.match(c.messages.at(-1).label,reason);
  }
  await assert.rejects(c.requestApproval({method:'item/permissions/requestApproval',params}));assert.match(c.messages.at(-1).label,/Unsupported request type/);
});
test('file approval shows matching proposed changes and does not grant roots',async()=>{
  const {c,client}=await setup();await c.send({text:'first'});
  client.emit('notification',{method:'item/started',params:{threadId:'thread',turnId:'turn1',item:{id:'file',type:'fileChange',changes:[{path:'a.txt',diff:'+test'}],status:'inProgress'}}});
  const params={threadId:'thread',turnId:'turn1',itemId:'file'};
  const p=c.requestApproval({method:'item/fileChange/requestApproval',params});
  const approval=c.snapshot().approvals[0];assert.match(approval.details,/a.txt/);
  c.resolveApproval(approval.id,'accept');assert.deepEqual(await p,{decision:'accept'});
  assert.deepEqual(await c.requestApproval({method:'item/fileChange/requestApproval',params:{...params,grantRoot:'/other'}}),{decision:'decline'});
});

test('WebSocket authenticates and reconnects to current state; stream snapshots coalesce', {timeout:10000}, async t=>{
  const {c,client}=await setup();const app=await buildServer(c);await app.ready();
  const host='127.0.0.1:4317',origin='http://'+host;
  const token=(await app.inject({url:'/api/bootstrap',headers:{host}})).json().token;
  const sockets=[];t.after(async()=>{for(const socket of sockets)socket.terminate();await app.close();});
  const open=async(headers={host,origin})=>{const socket=await app.injectWS('/events',{headers});sockets.push(socket);return socket;};
  await assert.rejects(open({host,origin:'https://example.com'}));
  const bad=await open();const closed=new Promise(resolve=>bad.once('close',resolve));bad.send('invalid');assert.equal(await closed,1008);
  const collect=async()=>{
    const socket=await open(),states=[];
    socket.on('message',data=>states.push(JSON.parse(data.toString())));
    socket.send(token);
    return {socket,states};
  };
  const waitFor=async pred=>{for(let i=0;i<200;i++){if(pred())return;await new Promise(r=>setTimeout(r,10));}throw Error('Missing WebSocket update');};
  const first=await collect();await waitFor(()=>first.states.length===1);
  await c.send({text:'test'});await waitFor(()=>first.states.at(-1)?.status==='running');
  const before=first.states.length;
  for(let i=0;i<25;i++)client.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn1',itemId:'a',delta:'x'}});
  await waitFor(()=>first.states.at(-1)?.messages.at(-1)?.text==='early'+'x'.repeat(25));
  assert.equal(first.states.length,before+1);
  client.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn1',itemId:'a',delta:'!'}});
  const approval=c.requestApproval({method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn1',command:'echo test'}});
  try {
    await waitFor(()=>first.states.at(-1)?.approvals.length===1);
    assert.equal(first.states.at(-1).messages.at(-1).text,'early'+'x'.repeat(25)+'!');
    const approvalId=c.snapshot().approvals[0].id;
    first.socket.close();const second=await collect();await waitFor(()=>second.states.length===1);
    assert.equal(second.states[0].approvals[0].id,approvalId);assert.equal(second.states[0].threadId,'thread');
    c.resolveApproval(approvalId,'decline');assert.deepEqual(await approval,{decision:'decline'});
    client.finish();await waitFor(()=>second.states.at(-1)?.status==='completed');assert.equal(second.states.at(-1).approvals.length,0);
  }finally{c.clearApprovals();}
});
