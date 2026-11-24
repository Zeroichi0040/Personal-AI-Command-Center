import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as git from './workspaces.mjs';
import { TaskBook } from './tasks.mjs';

const modes=new Set(['read-only','existing','isolated']);
const occupied=s=>s.conversation.active()||s.conversation.status==='uncertain';
const savedState=c=>{
  const s=c.snapshot();
  return {threadId:s.threadId??null,status:s.status,startedAt:s.startedAt??null,endedAt:s.endedAt??null,messages:s.messages||[]};
};
class OfflineConversation extends EventEmitter {
  constructor(saved,cwd,writable,error){super();this.saved=saved;this.status='offline';this.cwd=cwd;this.writable=writable;this.error=error;}
  active(){return false;}
  snapshot(){return {...this.saved,cwd:this.cwd,writable:this.writable,status:'offline',connected:false,turnReady:false,models:[],queue:[],approvals:[],error:this.error};}
}
const label=(value,fallback)=>{if(value==null||value==='')return fallback;if(typeof value!=='string'||!value.trim()||value.trim().length>80)throw Error('Name must contain 1–80 characters');return value.trim();};

export class SessionManager extends EventEmitter {
  constructor({createSession,workspace=git,maxActive=2,store=null}) {
    super();this.createSession=createSession;this.workspace=workspace;this.maxActive=maxActive;
    this.projects=new Map();this.sessions=new Map();this.creating=new Map();this.closed=false;this.store=store;this.saveTimer=null;this.storageError=null;this.tasks=new TaskBook();this.inflight=new Set();
  }
  checkWorkspace(s){this.workspace.assertCurrent?.(s.cwd);this.workspace.assertCurrent?.(this.project(s.projectId).root);}
  checkpoint(s){this.checkWorkspace(s);this.flush();}
  records(){
    return [...this.sessions.values()].map(s=>({id:s.id,projectId:s.projectId,name:s.name,mode:s.mode,cwd:s.cwd,writable:s.writable,branch:s.branch,worktreeBranch:s.worktreeBranch??(s.mode==='isolated'?s.branch:null),git:s.git,autoName:!!s.autoName,preferences:s.preferences||{},saved:s.conversation instanceof OfflineConversation?s.conversation.saved:savedState(s.conversation)}));
  }
  flush(){
    if(this.saveTimer!==null){clearTimeout(this.saveTimer);this.saveTimer=null;}
    if(!this.store)return;
    try{this.store.save([...this.projects.values()],this.records(),this.tasks.list());this.storageError=null;}
    catch(e){this.storageError='Local storage failed: '+e.message;throw e;}
  }
  emitState(mode='immediate'){
    if(this.closed)return;
    if(this.store){
      if(mode==='stream'){
        if(this.saveTimer===null)this.saveTimer=setTimeout(()=>{try{this.flush();}catch{this.emit('state',null,'immediate');}},250);
      }else {try{this.flush();}catch{/* checkpoint errors remain visible and block new work */}}
    }
    this.emit('state',null,mode);
  }
  restore(){
    if(!this.store)return false;
    const data=this.store.load();
    this.tasks.load(data.tasks);
    for(const p of data.projects)this.projects.set(p.id,p);
    for(const r of data.sessions){
      const interrupted=['starting','running','stopping','uncertain'].includes(r.saved.status);
      const conversation=new OfflineConversation(r.saved,r.cwd,r.writable,interrupted?'Previous turn outcome is uncertain. Review workspace changes before reconnecting.':'Saved history. Reconnect to continue the native thread.');
      this.sessions.set(r.id,{...r,conversation,close:()=>{},listener:()=>{},interrupted,reconnecting:false});
    }
    return data.initialized;
  }
  async reconnect(id,acknowledge){
    const s=this.session(id);
    if(s.reconnecting||occupied(s))throw Error('Session is busy or uncertain; restart PACC if disconnected during a turn');
    if(s.conversation.snapshot().connected)throw Error('Session is already connected');
    const saved=s.conversation instanceof OfflineConversation?s.conversation.saved:savedState(s.conversation);
    const interrupted=s.interrupted||['starting','running','stopping','uncertain'].includes(saved.status);
    if(interrupted&&!acknowledge)throw Error('Confirm that you reviewed the interrupted operation before reconnecting');
    s.reconnecting=true;
    let runtime;
    try{
      const root=await this.workspace.directory(this.project(s.projectId).root);
      const cwd=await this.workspace.directory(s.cwd);
      if(root!==this.project(s.projectId).root||cwd!==s.cwd)throw Error('Workspace path changed; refusing to resume');
      if(s.mode==='isolated'){
        const details=await this.workspace.inspect(cwd);
        if(details.branch!==(s.worktreeBranch??s.branch)||await this.workspace.repoRoot(cwd)!==cwd)throw Error('Saved worktree or branch changed; refusing to resume');
      }
      if(s.writable&&[...this.sessions.values(),...this.creating.values()].some(other=>other.id!==id&&other.writable&&other.cwd&&this.workspace.overlaps(other.cwd,cwd)))throw Error('Writable workspace conflicts with another session');
      if(this.closed)throw Error('Manager closed');
      runtime=this.createSession({cwd,writable:s.writable});this.inflight.add(runtime);
      await runtime.conversation.resume(saved);
      if(this.closed)throw Error('Manager closed');
      s.conversation.off('state',s.listener);s.close();
      s.conversation=runtime.conversation;s.close=runtime.close;s.interrupted=false;
      s.listener=(_state,mode)=>{this.tasks.observe(s.id,s.conversation.status);this.emitState(mode);};
      s.conversation.checkpoint=()=>this.checkpoint(s);
      s.conversation.on('state',s.listener);
    }catch(error){
      runtime?.close();
      s.conversation.off('state',s.listener);s.close();
      s.conversation=new OfflineConversation(saved,s.cwd,s.writable,'Reconnect failed: '+error.message);
      s.close=()=>{};s.listener=()=>{};throw error;
    }finally{if(runtime)this.inflight.delete(runtime);s.reconnecting=false;if(!this.closed)this.emitState();}
  }
  snapshot(){
    return {tasks:this.tasks.list(),projects:[...this.projects.values()],sessions:[...this.sessions.values()].map(s=>({id:s.id,projectId:s.projectId,name:s.name,mode:s.mode,branch:s.branch,git:s.git,preferences:s.preferences||{},reconnecting:!!s.reconnecting,interrupted:!!s.interrupted,conversation:s.conversation.snapshot()})),storageError:this.storageError,activeCount:this.activeCount(),maxActive:this.maxActive};
  }
  activeCount(){return [...this.sessions.values()].filter(occupied).length;}
  project(id){const p=this.projects.get(id);if(!p)throw Error('Unknown project');return p;}
  session(id){const s=this.sessions.get(id);if(!s)throw Error('Unknown session');return s;}
  persistMetadata(rollback){try{this.flush();}catch(error){rollback();this.emit('state',null,'immediate');throw error;}this.emit('state',null,'immediate');}
  async register(path,name,{allowDirectory=false}={}){
    if(this.closed)throw Error('Manager is closed');
    let root;
    if(allowDirectory){try{root=await this.workspace.repoRoot(path);}catch{root=await this.workspace.directory(path);}}
    else root=await this.workspace.repoRoot(path);
    if(this.closed)throw Error('Manager is closed');
    if([...this.projects.values()].some(p=>this.workspace.overlaps(p.root,root)&&this.workspace.overlaps(root,p.root)))throw Error('Project overlaps an already registered workspace');
    if(this.projects.size>=20)throw Error('Project limit reached');
    const id=randomUUID();this.projects.set(id,{id,root,name:label(name,basename(root)||root)});this.persistMetadata(()=>this.projects.delete(id));return id;
  }
  renameProject(id,name){const p=this.project(id),old=p.name;p.name=label(name,p.name);this.persistMetadata(()=>{p.name=old;});}
  removeProject(id){this.project(id);if(this.tasks.list().some(t=>t.projectId===id))throw Error('Remove project tasks before removing the project');if([...this.sessions.values(),...this.creating.values()].some(s=>s.projectId===id))throw Error('Close the project sessions before removing it');const old=this.project(id);this.projects.delete(id);this.persistMetadata(()=>this.projects.set(id,old));}
  async addSession(projectId,name,mode='read-only'){
    if(this.closed)throw Error('Manager is closed');
    const project=this.project(projectId);
    this.workspace.assertCurrent?.(project.root);
    if(!modes.has(mode))throw Error('Unknown workspace mode');
    if(this.sessions.size+this.creating.size>=12)throw Error('Session limit reached (12)');
    const id=randomUUID(),writable=mode!=='read-only';
    const sessionName=label(name,'New conversation');
    const conflict=cwd=>[...this.sessions.values(),...this.creating.values()].some(s=>s.writable&&s.cwd&&this.workspace.overlaps(s.cwd,cwd));
    if(mode==='existing'&&conflict(project.root))throw Error('An overlapping writable workspace is already reserved; use an isolated worktree');
    const pending={id,projectId,writable,cwd:mode==='isolated'?null:project.root};this.creating.set(id,pending);
    let runtime,location;
    try {
      location=mode==='isolated'?await this.workspace.createWorktree(project.root,id):{cwd:project.root,branch:null};
      if(this.closed)throw Error('Manager is closed');
      pending.cwd=location.cwd;
      if(writable&&[...this.sessions.values(),...this.creating.values()].some(s=>s.id!==id&&s.writable&&s.cwd&&this.workspace.overlaps(s.cwd,location.cwd)))throw Error('Writable workspace conflicts with another session');
      runtime=this.createSession({cwd:location.cwd,writable});this.inflight.add(runtime);
      const conversation=runtime.conversation;
      await conversation.initialize();
      if(this.closed)throw Error('Manager is closed');
      const s={...pending,name:sessionName,mode,branch:location.branch,worktreeBranch:location.branch,git:null,conversation,close:runtime.close,autoName:!name,preferences:{}};
      // Initialization is complete before exposing the session to actions.
      const listener=(_state,eventMode)=>{this.tasks.observe(id,conversation.status);this.emitState(eventMode);};
      s.listener=listener;conversation.checkpoint=()=>this.checkpoint(s);conversation.on('state',listener);
      this.sessions.set(id,s);
      try{this.flush();}catch(error){this.sessions.delete(id);conversation.off('state',listener);throw error;}
      this.emit('state',null,'immediate');return id;
    }catch(error){
      runtime?.close();
      if(mode==='isolated'&&location)throw Error(error.message+'; worktree preserved at '+location.cwd);
      throw error;
    }finally{if(runtime)this.inflight.delete(runtime);this.creating.delete(id);}
  }
  renameSession(id,name){const s=this.session(id),old={name:s.name,autoName:s.autoName};s.name=label(name,s.name);s.autoName=false;this.persistMetadata(()=>Object.assign(s,old));}
  closeSession(id){const s=this.session(id);if(occupied(s)||s.reconnecting)throw Error('Stop active work first; uncertain sessions require a server restart');const before=structuredClone(this.tasks.list());this.sessions.delete(id);for(const t of this.tasks.list())if(t.sessionId===id)this.tasks.assign(t,null);this.persistMetadata(()=>{this.sessions.set(id,s);this.tasks.tasks=new Map(before.map(t=>[t.id,t]));});s.conversation.off('state',s.listener);s.close();}
  commitTasks(fn){
    const before=structuredClone(this.tasks.list());
    try{const value=fn();this.flush();this.emit('state',null,'immediate');return value;}
    catch(error){this.tasks.tasks=new Map(before.map(t=>[t.id,t]));this.emit('state',null,'immediate');throw error;}
  }
  async dispatchTask(taskId){
    const t=this.tasks.get(taskId);
    if(!t.sessionId)throw Error('Assign a session first');
    const s=this.session(t.sessionId),c=s.conversation;
    if(s.projectId!==t.projectId)throw Error('Task and session must share a project');
    if(!c.snapshot().connected||s.reconnecting||occupied(s)||this.tasks.forSession(s.id))throw Error('Choose an idle connected session');
    if(this.activeCount()>=this.maxActive)throw Error('All generation slots are occupied');
    this.checkWorkspace(s);
    const data={text:this.tasks.prompt(t),model:s.preferences?.model||'',effort:s.preferences?.effort||''};
    c.validateMessage?.(data);
    const attempt=this.commitTasks(()=>this.tasks.begin(t,s.id));
    try{
      // No await between reserving the attempt and sending; normal chat cannot queue behind it.
      await c.send(data);
      if(this.tasks.tasks.get(t.id)?.activeAttempt?.id===attempt.id)this.tasks.observe(s.id,c.status);
      if(!this.closed)this.emitState();
    }catch(error){
      const current=this.tasks.tasks.get(t.id);
      if(current?.activeAttempt?.id===attempt.id)this.tasks.finish(current,'uncertain',error.message);
      if(!this.closed)this.emitState();throw error;
    }
  }
  async dispatch(data){
    if(this.closed)throw Error('Manager is closed');
    if(this.storageError&&(['send','steer','createSession','reconnect'].includes(data?.action)||(data?.action==='approval'&&data.decision==='accept')))throw Error(this.storageError);
    if(typeof data?.action==='string'&&['createTask','editTask','assignTask','moveTask','deleteTask','dispatchTask'].includes(data.action)){
      if(this.storageError)throw Error(this.storageError);
      if(data.action==='createTask'){this.project(data.projectId);return {taskId:this.commitTasks(()=>this.tasks.create(data.projectId,data)).id};}
      const t=this.tasks.get(data.taskId);
      if(data.action==='dispatchTask'){await this.dispatchTask(t.id);return {};}
      this.commitTasks(()=>{
        switch(data.action){
          case 'editTask':this.tasks.edit(t,data);break;
          case 'assignTask':{const id=data.assignedSessionId||null;if(id&&this.session(id).projectId!==t.projectId)throw Error('Task and session must share a project');this.tasks.assign(t,id);break;}
          case 'moveTask':this.tasks.move(t,data.status);break;
          case 'deleteTask':this.tasks.remove(t);break;
        }
      });return {};
    }
    switch(data?.action){
      case 'registerProject':return {projectId:await this.register(data.path,data.name)};
      case 'renameProject':this.renameProject(data.projectId,data.name);return {};
      case 'removeProject':this.removeProject(data.projectId);return {};
      case 'createSession':return {sessionId:await this.addSession(data.projectId,data.name,data.mode)};
      case 'renameSession':this.renameSession(data.sessionId,data.name);return {};
      case 'closeSession':this.closeSession(data.sessionId);return {};
      case 'reconnect':await this.reconnect(data.sessionId,data.acknowledge===true);return {};
      case 'backupHistory':this.flush();if(!this.store)throw Error('History storage unavailable');return {backupPath:this.store.backup()};
      case 'searchHistory':this.flush();return {results:this.store?.search(data.query)||[]};
      case 'exportSession':{const s=this.session(data.sessionId);return {export:{name:s.name,project:this.project(s.projectId).name,workspace:s.cwd,...savedState(s.conversation)}};}
    }
    const s=this.session(data?.sessionId),c=s.conversation;
    switch(data.action){
      case 'send':
        if(this.tasks.forSession(s.id))throw Error('A task is executing in this session; wait or use Steer');
        // Conversation.send synchronously enters starting before its first await.
        // Queued follow-ups reuse the already occupied slot.
        if(!c.active()&&this.activeCount()>=this.maxActive)throw Error('All generation slots are occupied; wait or stop another session');
        if(c instanceof OfflineConversation)throw Error('Reconnect the saved session first');
        this.checkWorkspace(s);
        if(typeof c.validateMessage==='function')c.validateMessage(data);
        if(s.autoName&&typeof data.text==='string'&&data.text.trim()){s.name=data.text.trim().replace(/\s+/g,' ').slice(0,60);s.autoName=false;}
        s.preferences={model:data.model||'',effort:data.effort||''};
        await c.send(data);break;
      case 'stop':await c.stop();break;
      case 'steer':this.checkWorkspace(s);await c.steer(data);break;
      case 'removeQueued':c.removeQueued(data.id);break;
      case 'approval':{
        // Approval can escape normal sandbox boundaries. Do not elevate while
        // another writable reservation overlaps this session's workspace.
        if(data.decision==='accept'&&[...this.sessions.values(),...this.creating.values()].some(other=>other.id!==s.id&&other.writable&&other.cwd&&this.workspace.overlaps(other.cwd,s.cwd)))throw Error('Approval blocked by overlapping writable workspace; decline or close the other session');
        if(data.decision==='accept')this.checkWorkspace(s);
        c.resolveApproval(data.id,data.decision);break;
      }
      case 'inspectGit':{
        const result=await this.workspace.inspect(s.cwd);
        if(this.sessions.get(s.id)===s){s.git=result;s.branch=result.branch;this.emitState();}break;
      }
      default:throw Error('Unknown action');
    }
    return {};
  }
  close({persist=true}={}){if(this.closed)return;this.closed=true;try{if(persist)this.flush();}finally{if(this.saveTimer!==null)clearTimeout(this.saveTimer);for(const runtime of this.inflight)runtime.close();this.inflight.clear();for(const s of this.sessions.values()){s.conversation.off('state',s.listener);s.close();}this.sessions.clear();this.store?.close();}}
}
