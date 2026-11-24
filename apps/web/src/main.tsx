import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import './style.css';

type Message = {id:string;kind:'user'|'assistant'|'reasoning'|'tool';text:string;label?:string;startedAt?:number;endedAt?:number};
type Model = {model:string;name:string;default:boolean;effort:string;efforts:string[]};
type State = {connected:boolean;threadId:string|null;status:string;cwd:string;writable:boolean;startedAt:number|null;endedAt:number|null;turnReady:boolean;messages:Message[];queue:{id:string;text:string}[];models:Model[];approvals:{id:string;method:string;details:string}[];error:string|null};
type Project = {id:string;root:string;name:string};
type Session = {id:string;projectId:string;name:string;mode:string;branch:string|null;git:{branch:string;status:string;diff:string}|null;conversation:State};
type Workspace = {projects:Project[];sessions:Session[];activeCount:number;maxActive:number};
type Draft = {text:string;model:string;effort:string;mode:string};
const blank:Draft={text:'',model:'',effort:'',mode:'send'};
const duration = (ms:number) => {const s=Math.max(0,Math.floor(ms/1000));return [Math.floor(s/3600)?Math.floor(s/3600)+'h':'',Math.floor(s/60)%60?Math.floor(s/60)%60+'m':'',s%60+'s'].filter(Boolean).join(' ');};
function Code({children,className}:{children?:React.ReactNode;className?:string}) {
  const language=/language-([\w+-]+)/.exec(className||'')?.[1];
  const text=String(children??'');
  if (!language || !hljs.getLanguage(language)) return <code className={className}>{children}</code>;
  // highlight.js escapes input before inserting its own markup; never render raw Markdown HTML.
  return <code className={'hljs '+className} dangerouslySetInnerHTML={{__html:hljs.highlight(text,{language,ignoreIllegals:true}).value}}/>;
}
function App(){
  const [workspace,setWorkspace]=useState<Workspace|null>(null),[online,setOnline]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [selectedId,setSelectedId]=useState(''),[drafts,setDrafts]=useState<Record<string,Draft>>({}),[now,setNow]=useState(Date.now());
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({}),[registering,setRegistering]=useState(false),[projectPath,setProjectPath]=useState(''),[projectName,setProjectName]=useState('');
  const [newProjectId,setNewProjectId]=useState(''),[sessionName,setSessionName]=useState(''),[workspaceMode,setWorkspaceMode]=useState('read-only');
  const session=workspace?.sessions.find(s=>s.id===selectedId)||workspace?.sessions[0];
  const state=session?.conversation, sid=session?.id||'';
  const current=drafts[sid]||blank, {text:draft,model,effort,mode}=current;
  const updateDraft=(patch:Partial<Draft>)=>setDrafts(old=>({...old,[sid]:{...(old[sid]||blank),...patch}}));
  const setDraft=(text:string)=>updateDraft({text});
  const setModel=(model:string)=>updateDraft({model,effort:''});
  const setEffort=(effort:string)=>updateDraft({effort});
  const setMode=(mode:string)=>updateDraft({mode});
  const [sidebar,setSidebar]=useState(true),[details,setDetails]=useState(true);
  const token=useRef(''),scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
  useEffect(()=>{
    let dead=false,ws:WebSocket|undefined,timer:ReturnType<typeof setTimeout>;
    async function connect(){
      try {
        const response=await fetch('/api/bootstrap',{cache:'no-store'});
        if(!response.ok) throw Error('Unable to connect');
        const initial=await response.json(); if(dead)return;
        token.current=initial.token; setWorkspace(initial.state);
        ws=new WebSocket('ws://'+location.host+'/events');
        ws.onopen=()=>ws?.send(token.current);
        ws.onmessage=e=>{if(!dead){setWorkspace(JSON.parse(e.data));setOnline(true);}};
        ws.onclose=()=>{if(!dead){setOnline(false);timer=setTimeout(connect,1500);}};
        ws.onerror=()=>ws?.close();
      }catch{if(!dead){setOnline(false);timer=setTimeout(connect,1500);}}
    }
    void connect(); return()=>{dead=true;clearTimeout(timer);ws?.close();};
  },[]);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(follow.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[state]);
  useEffect(()=>{follow.current=true;if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[sid]);
  async function action(data:Record<string,unknown>){
    if(!online||busy)return false;
    setBusy(true);setError('');
    try{
      const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-PACC-Token':token.current},body:JSON.stringify({sessionId:sid,...data})});
      const result=await r.json();if(!r.ok)throw Error(result.error||'Request failed');if(result.sessionId){setSelectedId(result.sessionId);setNewProjectId('');}return true;
    }catch(e){setError(e instanceof Error?e.message:'Request failed');return false;}
    finally{setBusy(false);}
  }
  const active=!!state&&['starting','running','stopping'].includes(state.status);
  const disabled=!online||!state?.connected||state?.status==='uncertain'||busy;
  const navigationDisabled=!online||busy;
  const selected=state?.models.find(m=>m.model===model);
  async function submit(){
    if(!draft.trim()||disabled||(active&&mode==='steer'&&!state?.turnReady))return;
    const text=draft;const ok=await action({action:active&&mode==='steer'?'steer':'send',text,model,effort});
    if(ok)setDrafts(old=>old[sid]?.text===text?{...old,[sid]:{...old[sid],text:''}}:old);
  }
  return <div className={'shell '+(!sidebar?'no-left ':'')+(!details?'no-right':'')}>
    <header><button className="quiet" onClick={()=>setSidebar(v=>!v)} aria-label="Toggle navigation">☰</button><strong>PACC</strong><span className="muted">/ Command Center</span><div className="spacer"/><span className={'status '+(online?'good':'')}>{online?(workspace?.activeCount||0)+'/'+(workspace?.maxActive||2)+' active':'Disconnected'}</span><button className="quiet" onClick={()=>setDetails(v=>!v)} aria-label="Toggle details">▥</button></header>
    {sidebar&&<aside className="left"><div className="project-heading"><span className="eyebrow">PROJECTS</span><button className="quiet" disabled={navigationDisabled} onClick={()=>setRegistering(v=>!v)} aria-label="Register project">+</button></div>
      {registering&&<form className="nav-form" onSubmit={async e=>{e.preventDefault();if(await action({action:'registerProject',path:projectPath,name:projectName})){setRegistering(false);setProjectPath('');setProjectName('');}}}><input aria-label="Repository path" placeholder="Absolute repository path" value={projectPath} onChange={e=>setProjectPath(e.target.value)} required/><input aria-label="Project name" placeholder="Name (optional)" value={projectName} onChange={e=>setProjectName(e.target.value)} maxLength={80}/><button disabled={navigationDisabled}>Register</button></form>}
      {workspace?.projects.map(p=><section className="project-group" key={p.id}><div className="project-heading"><button className="project-toggle" title={p.root} onClick={()=>setCollapsed(old=>({...old,[p.id]:!old[p.id]}))}>{collapsed[p.id]?'▸':'▾'} {p.name}</button><button className="quiet" title="Rename project" disabled={navigationDisabled} onClick={()=>{const name=window.prompt('Project name',p.name);if(name?.trim())void action({action:'renameProject',projectId:p.id,name});}}>✎</button><button className="quiet" title="Remove project" disabled={navigationDisabled} onClick={()=>{if(window.confirm('Remove project registration? No files will be deleted.'))void action({action:'removeProject',projectId:p.id});}}>×</button></div>
      {!collapsed[p.id]&&<><div className="project-sessions">{workspace.sessions.filter(s=>s.projectId===p.id).map(s=><button className={'session session-button '+(sid===s.id?'active':'')} key={s.id} onClick={()=>{setSelectedId(s.id);setError('');}}><span className={'dot '+(['starting','running','stopping'].includes(s.conversation.status)?'pulse':'')+(s.conversation.approvals.length?' pending':'')}/><span>{s.name}<small>{s.conversation.approvals.length?'Awaiting approval':s.conversation.status} · {s.mode}</small></span></button>)}</div><button className="new-session quiet" disabled={navigationDisabled} onClick={()=>{setNewProjectId(p.id);setSessionName('');setWorkspaceMode('read-only');}}>+ New session</button>
      {newProjectId===p.id&&<form className="nav-form" onSubmit={async e=>{e.preventDefault();await action({action:'createSession',projectId:p.id,name:sessionName,mode:workspaceMode});}}><input aria-label="Session name" placeholder="Session name" value={sessionName} maxLength={80} onChange={e=>setSessionName(e.target.value)}/><select aria-label="Workspace mode" value={workspaceMode} onChange={e=>setWorkspaceMode(e.target.value)}><option value="read-only">Read-only</option><option value="existing">Existing · writable</option><option value="isolated">Isolated Git worktree</option></select><div className="muted small">{workspaceMode==='isolated'?'Creates a new branch and worktree from HEAD.':workspaceMode==='existing'?'Allows edits in the registered workspace.':'No normal sandbox writes.'}</div><div className="actions"><button type="button" onClick={()=>setNewProjectId('')}>Cancel</button><button disabled={navigationDisabled}>Create</button></div></form>}</>}</section>)}
      <div className="bottom muted small">v0.1.0-dev.3 · Local only</div></aside>}
    <main><div className="chathead"><div><strong>{session?.name||'No session selected'}</strong><div className="muted small">{session?'Codex · '+(state?.writable?'Workspace write':'Read-only sandbox'):'Create a project session to begin'}</div></div><div className="spacer"/><span className="muted small">{state?.startedAt? (active?'Working ':'Worked for ')+duration((state.endedAt||now)-state.startedAt):'Ready'}</span></div>
      <div className="scroll" ref={scroll} onScroll={()=>{const e=scroll.current;if(e)follow.current=e.scrollHeight-e.scrollTop-e.clientHeight<100;}}>
        {(!state||state.messages.length===0)&&<div className="empty"><div className="terminal-mark">&gt;_</div><h1>What are we building?</h1><p>Ask Codex to inspect your workspace, plan changes, or help debug an issue.</p></div>}
        {state?.messages.map(m=>m.kind==='tool'||m.kind==='reasoning'?<details className="activity" key={m.id}><summary>{m.kind==='reasoning'?'Reasoning summary':m.label||'Tool activity'} {m.endedAt&&m.startedAt?'· '+duration(m.endedAt-m.startedAt):''}</summary><pre>{m.text}</pre></details>:<article key={m.id} className={'message '+m.kind}><div className="author">{m.kind==='user'?'You': 'Codex'}{m.label?' · '+m.label:''}</div>{m.kind==='user'?<div className="usertext">{m.text}</div>:<Markdown skipHtml remarkPlugins={[remarkGfm]} components={{code:Code,a:({children})=><span>{children}</span>,img:()=>null}}>{m.text}</Markdown>}</article>)}
        {state?.approvals.map(a=><section key={a.id} className="approval"><strong>Approval requested · {a.method.includes('fileChange')?'File change':'Command execution'}</strong><p>This may allow an operation outside the normal sandbox. Review the full request before approving. PACC only sends a one-time acceptance; policy amendment suggestions are not applied.</p><pre>{a.details}</pre><div className="actions"><button disabled={disabled} onClick={()=>void action({action:'approval',id:a.id,decision:'decline'})}>Decline</button><button className="primary" disabled={disabled||!state?.turnReady} onClick={()=>void action({action:'approval',id:a.id,decision:'accept'})}>Approve once</button></div></section>)}
      </div>
      <div className="composer-wrap">
        {(error||state?.error)&&<div className="error" role="alert">{error||state?.error}</div>}
        {state?.queue.map(q=><div className="queued" key={q.id}><span>Queued · {q.text}</span><button disabled={disabled} onClick={()=>void action({action:'removeQueued',id:q.id})}>Remove</button></div>)}
        <form className="composer" onSubmit={e=>{e.preventDefault();void submit();}}><textarea aria-label="Message Codex" value={draft} onChange={e=>setDraft(e.target.value)} placeholder={active?'Queue a follow-up or steer…':'Message Codex…'} maxLength={40000} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void submit();}}}/>
        <div className="toolbar"><select aria-label="Model" value={model} onChange={e=>{setModel(e.target.value);setEffort('');}}><option value="">Runtime default</option>{state?.models.map(m=><option key={m.model} value={m.model}>{m.name}</option>)}</select><select aria-label="Reasoning effort" value={effort} disabled={!selected} onChange={e=>setEffort(e.target.value)}><option value="">Default effort</option>{selected?.efforts.map(x=><option key={x}>{x}</option>)}</select>{active&&<select aria-label="Follow-up mode" value={mode} onChange={e=>setMode(e.target.value)}><option value="send">Queue</option><option value="steer">Steer</option></select>}<div className="spacer"/>{active&&<button type="button" disabled={disabled||!state?.turnReady} onClick={()=>void action({action:'stop'})}>Stop</button>}<button type="submit" className="primary" disabled={disabled||!draft.trim()||(active&&mode==='steer'&&!state?.turnReady)}>{active?(mode==='steer'?'Steer':'Queue'):'Send'}</button></div></form>
        <div className="footer muted small">Enter to send · Shift+Enter for a new line · No automatic approvals</div>
      </div>
    </main>
    {details&&<aside className="right"><strong>Session details</strong>{session&&<div className="actions session-actions"><button disabled={navigationDisabled} onClick={()=>{const name=window.prompt('Session name',session.name);if(name?.trim())void action({action:'renameSession',name});}}>Rename</button><button disabled={navigationDisabled||active||state?.status==='uncertain'} onClick={()=>{if(window.confirm('Close this session? The client view will be lost; files and worktrees stay.'))void action({action:'closeSession'});}}>Close</button></div>}<dl><dt>Status</dt><dd>{state?.status||'Connecting'}</dd><dt>Workspace</dt><dd className="path">{state?.cwd||'—'}</dd><dt>Sandbox</dt><dd>{state?.writable?'Workspace write (network restricted)':'Read-only (approvals may escalate)'}</dd><dt>Native thread</dt><dd className="path">{state?.threadId||'Not started'}</dd><dt>Queued messages</dt><dd>{state?.queue.length||0}</dd><dt>Branch</dt><dd>{session?.branch||'Not inspected'}</dd><dt>Git workspace</dt><dd>{session&&<button disabled={navigationDisabled} onClick={()=>void action({action:'inspectGit'})}>Inspect status / diff</button>}{session?.git&&<pre className="git-output">{session.git.status+'\n\n'+(session.git.diff||'No tracked diff')}</pre>}</dd></dl><p className="muted small">Closing the browser does not stop the server. Restarting the server clears project and session registrations; native history, branches and worktrees remain.</p></aside>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
