import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as git from './workspaces.mjs';

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
    this.projects=new Map();this.sessions=new Map();this.creating=new Map();this.closed=false;this.store=store;this.saveTimer=null;this.storageError=null;
  }
  records(){
    return [...this.sessions.values()].map(s=>({id:s.id,projectId:s.projectId,name:s.name,mode:s.mode,cwd:s.cwd,writable:s.writable,branch:s.branch,git:s.git,autoName:!!s.autoName,preferences:s.preferences||{},saved:s.conversation instanceof OfflineConversation?s.conversation.saved:savedState(s.conversation)}));
  }
  flush(){
    if(this.saveTimer!==null){clearTimeout(this.saveTimer);this.saveTimer=null;}
    if(!this.store)return;
    try{this.store.save([...this.projects.values()],this.records());this.storageError=null;}
    catch(e){this.storageError='Local storage failed: '+e.message;throw e;}
  }
  emitState(mode='immediate'){
    if(this.store){
      if(mode==='stream'){
        if(this.saveTimer===null)this.saveTimer=setTimeout(()=>{try{this.flush();}catch{this.emit('state',null,'immediate');}},250);
      }else this.flush();
    }
    this.emit('state',null,mode);
  }
  restore(){
    if(!this.store)return false;
    const data=this.store.load();
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
    if(s.reconnecting||occupied(s))throw Error('Session is busy');
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
        if(details.branch!==s.branch||await this.workspace.repoRoot(cwd)!==cwd)throw Error('Saved worktree or branch changed; refusing to resume');
      }
      if(s.writable&&[...this.sessions.values(),...this.creating.values()].some(other=>other.id!==id&&other.writable&&other.cwd&&this.workspace.overlaps(other.cwd,cwd)))throw Error('Writable workspace conflicts with another session');
      if(this.closed)throw Error('Manager closed');
      runtime=this.createSession({cwd,writable:s.writable});
      await runtime.conversation.resume(saved);
      if(this.closed)throw Error('Manager closed');
      s.conversation.off('state',s.listener);s.close();
      s.conversation=runtime.conversation;s.close=runtime.close;s.interrupted=false;
      s.listener=(_state,mode)=>this.emitState(mode);
      s.conversation.on('state',s.listener);
    }catch(error){
      runtime?.close();
      s.conversation=new OfflineConversation(saved,s.cwd,s.writable,'Reconnect failed: '+error.message);
      s.close=()=>{};s.listener=()=>{};throw error;
    }finally{s.reconnecting=false;if(!this.closed)this.emitState();}
  }
  snapshot(){
    return {projects:[...this.projects.values()],sessions:[...this.sessions.values()].map(s=>({id:s.id,projectId:s.projectId,name:s.name,mode:s.mode,branch:s.branch,git:s.git,preferences:s.preferences||{},reconnecting:!!s.reconnecting,interrupted:!!s.interrupted,conversation:s.conversation.snapshot()})),storageError:this.storageError,activeCount:this.activeCount(),maxActive:this.maxActive};
  }
  activeCount(){return [...this.sessions.values()].filter(occupied).length;}
  project(id){const p=this.projects.get(id);if(!p)throw Error('Unknown project');return p;}
  session(id){const s=this.sessions.get(id);if(!s)throw Error('Unknown session');return s;}
  async register(path,name,{allowDirectory=false}={}){
    if(this.closed)throw Error('Manager is closed');
    let root;
    if(allowDirectory){try{root=await this.workspace.repoRoot(path);}catch{root=await this.workspace.directory(path);}}
    else root=await this.workspace.repoRoot(path);
    if(this.closed)throw Error('Manager is closed');
    if([...this.projects.values()].some(p=>this.workspace.overlaps(p.root,root)&&this.workspace.overlaps(root,p.root)))throw Error('Project overlaps an already registered workspace');
    if(this.projects.size>=20)throw Error('Project limit reached');
    const id=randomUUID();this.projects.set(id,{id,root,name:label(name,basename(root)||root)});this.emitState();return id;
  }
  renameProject(id,name){const p=this.project(id);p.name=label(name,p.name);this.emitState();}
  removeProject(id){this.project(id);if([...this.sessions.values(),...this.creating.values()].some(s=>s.projectId===id))throw Error('Close the project sessions before removing it');this.projects.delete(id);this.emitState();}
  async addSession(projectId,name,mode='read-only'){
    if(this.closed)throw Error('Manager is closed');
    const project=this.project(projectId);
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
      runtime=this.createSession({cwd:location.cwd,writable});
      const conversation=runtime.conversation;
      await conversation.initialize();
      if(this.closed)throw Error('Manager is closed');
      const s={...pending,name:sessionName,mode,branch:location.branch,git:null,conversation,close:runtime.close,autoName:!name,preferences:{}};
      // Initialization is complete before exposing the session to actions.
      const listener=(_state,eventMode)=>this.emitState(eventMode);
      s.listener=listener;conversation.on('state',listener);
      this.sessions.set(id,s);this.emitState();return id;
    }catch(error){
      runtime?.close();
      if(mode==='isolated'&&location)throw Error(error.message+'; worktree preserved at '+location.cwd);
      throw error;
    }finally{this.creating.delete(id);}
  }
  renameSession(id,name){const s=this.session(id);s.name=label(name,s.name);s.autoName=false;this.emitState();}
  closeSession(id){const s=this.session(id);if(occupied(s)||s.reconnecting)throw Error('Stop active work first; uncertain sessions require a server restart');s.conversation.off('state',s.listener);this.sessions.delete(id);s.close();this.emitState();}
  async dispatch(data){
    if(this.closed)throw Error('Manager is closed');
    if(this.storageError&&['send','steer','approval','createSession','reconnect'].includes(data?.action))throw Error(this.storageError);
    switch(data?.action){
      case 'registerProject':return {projectId:await this.register(data.path,data.name)};
      case 'renameProject':this.renameProject(data.projectId,data.name);return {};
      case 'removeProject':this.removeProject(data.projectId);return {};
      case 'createSession':return {sessionId:await this.addSession(data.projectId,data.name,data.mode)};
      case 'renameSession':this.renameSession(data.sessionId,data.name);return {};
      case 'closeSession':this.closeSession(data.sessionId);return {};
      case 'reconnect':await this.reconnect(data.sessionId,data.acknowledge===true);return {};
      case 'searchHistory':this.flush();return {results:this.store?.search(data.query)||[]};
      case 'exportSession':{const s=this.session(data.sessionId);return {export:{name:s.name,project:this.project(s.projectId).name,workspace:s.cwd,...savedState(s.conversation)}};}
    }
    const s=this.session(data?.sessionId),c=s.conversation;
    switch(data.action){
      case 'send':
        // Conversation.send synchronously enters starting before its first await.
        // Queued follow-ups reuse the already occupied slot.
        if(!c.active()&&this.activeCount()>=this.maxActive)throw Error('All generation slots are occupied; wait or stop another session');
        if(c instanceof OfflineConversation)throw Error('Reconnect the saved session first');
        if(typeof c.validateMessage==='function')c.validateMessage(data);
        if(s.autoName&&typeof data.text==='string'&&data.text.trim()){s.name=data.text.trim().replace(/\s+/g,' ').slice(0,60);s.autoName=false;}
        s.preferences={model:data.model||'',effort:data.effort||''};
        await c.send(data);break;
      case 'stop':await c.stop();break;
      case 'steer':await c.steer(data);break;
      case 'removeQueued':c.removeQueued(data.id);break;
      case 'approval':{
        // Approval can escape normal sandbox boundaries. Do not elevate while
        // another writable reservation overlaps this session's workspace.
        if(data.decision==='accept'&&[...this.sessions.values(),...this.creating.values()].some(other=>other.id!==s.id&&other.writable&&other.cwd&&this.workspace.overlaps(other.cwd,s.cwd)))throw Error('Approval blocked by overlapping writable workspace; decline or close the other session');
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
  close(){this.closed=true;try{this.flush();}finally{for(const s of this.sessions.values()){s.conversation.off('state',s.listener);s.close();}this.sessions.clear();this.store?.close();}}
}
