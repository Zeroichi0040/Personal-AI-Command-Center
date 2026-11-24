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
const duration = (ms:number) => {const s=Math.max(0,Math.floor(ms/1000));return [Math.floor(s/3600)?Math.floor(s/3600)+'h':'',Math.floor(s/60)%60?Math.floor(s/60)%60+'m':'',s%60+'s'].filter(Boolean).join(' ');};
function Code({children,className}:{children?:React.ReactNode;className?:string}) {
  const language=/language-([\w+-]+)/.exec(className||'')?.[1];
  const text=String(children??'');
  if (!language || !hljs.getLanguage(language)) return <code className={className}>{children}</code>;
  // highlight.js escapes input before inserting its own markup; never render raw Markdown HTML.
  return <code className={'hljs '+className} dangerouslySetInnerHTML={{__html:hljs.highlight(text,{language,ignoreIllegals:true}).value}}/>;
}
function App(){
  const [state,setState]=useState<State|null>(null),[online,setOnline]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [draft,setDraft]=useState(''),[model,setModel]=useState(''),[effort,setEffort]=useState(''),[mode,setMode]=useState('send'),[now,setNow]=useState(Date.now());
  const [sidebar,setSidebar]=useState(true),[details,setDetails]=useState(true);
  const token=useRef(''),scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
  useEffect(()=>{
    let dead=false,ws:WebSocket|undefined,timer:ReturnType<typeof setTimeout>;
    async function connect(){
      try {
        const response=await fetch('/api/bootstrap',{cache:'no-store'});
        if(!response.ok) throw Error('Unable to connect');
        const initial=await response.json(); if(dead)return;
        token.current=initial.token; setState(initial.state);
        ws=new WebSocket('ws://'+location.host+'/events');
        ws.onopen=()=>ws?.send(token.current);
        ws.onmessage=e=>{if(!dead){setState(JSON.parse(e.data));setOnline(true);}};
        ws.onclose=()=>{if(!dead){setOnline(false);timer=setTimeout(connect,1500);}};
        ws.onerror=()=>ws?.close();
      }catch{if(!dead){setOnline(false);timer=setTimeout(connect,1500);}}
    }
    void connect(); return()=>{dead=true;clearTimeout(timer);ws?.close();};
  },[]);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(follow.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[state]);
  async function action(data:Record<string,unknown>){
    if(!online||busy)return false;
    setBusy(true);setError('');
    try{
      const r=await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-PACC-Token':token.current},body:JSON.stringify(data)});
      const result=await r.json();if(!r.ok)throw Error(result.error||'Request failed');return true;
    }catch(e){setError(e instanceof Error?e.message:'Request failed');return false;}
    finally{setBusy(false);}
  }
  const active=!!state&&['starting','running','stopping'].includes(state.status);
  const disabled=!online||!state?.connected||state?.status==='uncertain'||busy;
  const selected=state?.models.find(m=>m.model===model);
  async function submit(){
    if(!draft.trim()||disabled||(active&&mode==='steer'&&!state?.turnReady))return;
    const text=draft;const ok=await action({action:active&&mode==='steer'?'steer':'send',text,model,effort});
    if(ok)setDraft(current=>current===text?'':current);
  }
  return <div className={'shell '+(!sidebar?'no-left ':'')+(!details?'no-right':'')}>
    <header><button className="quiet" onClick={()=>setSidebar(v=>!v)} aria-label="Toggle navigation">☰</button><strong>PACC</strong><span className="muted">/ Command Center</span><div className="spacer"/><span className={'status '+(online&&state?.connected?'good':'')}>{online&&state?.connected?'Runtime connected':'Disconnected'}</span><button className="quiet" onClick={()=>setDetails(v=>!v)} aria-label="Toggle details">▥</button></header>
    {sidebar&&<aside className="left"><div className="eyebrow">WORKSPACE</div><div className="workspace-name" title={state?.cwd}>{state?.cwd.split(/[\\/]/).pop()||'Local workspace'}</div><div className="eyebrow">SESSION</div><div className="session active"><span className={'dot '+(active?'pulse':'')}/><div>Current conversation<small>{state?.status||'Connecting'}</small></div></div><p className="muted small">Project navigation and multiple sessions arrive in the next milestone.</p><div className="bottom muted small">v0.1.0-dev.2 · Local only</div></aside>}
    <main><div className="chathead"><div><strong>Codex</strong><div className="muted small">{state?.writable?'Workspace write':'Read-only sandbox'}</div></div><div className="spacer"/><span className="muted small">{state?.startedAt? (active?'Working ':'Worked for ')+duration((state.endedAt||now)-state.startedAt):'Ready'}</span></div>
      <div className="scroll" ref={scroll} onScroll={()=>{const e=scroll.current;if(e)follow.current=e.scrollHeight-e.scrollTop-e.clientHeight<100;}}>
        {state?.messages.length===0&&<div className="empty"><div className="terminal-mark">&gt;_</div><h1>What are we building?</h1><p>Ask Codex to inspect your workspace, plan changes, or help debug an issue.</p></div>}
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
    {details&&<aside className="right"><strong>Session details</strong><dl><dt>Status</dt><dd>{state?.status||'Connecting'}</dd><dt>Workspace</dt><dd className="path">{state?.cwd||'—'}</dd><dt>Sandbox</dt><dd>{state?.writable?'Workspace write (network restricted)':'Read-only (approvals may escalate)'}</dd><dt>Native thread</dt><dd className="path">{state?.threadId||'Not started'}</dd><dt>Queued messages</dt><dd>{state?.queue.length||0}</dd><dt>Usage</dt><dd className="muted">Not available in this milestone</dd></dl><p className="muted small">Closing the browser does not stop the server. Restarting the server ends this client view; native Codex history remains.</p></aside>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
