import { randomUUID } from 'node:crypto';
export const statuses=['backlog','ready','in-progress','review','done'];
const priorities=['low','normal','high','urgent'];
const field=(v,max,required=false)=>{
  if(typeof v!=='string'||v.length>max||(required&&!v.trim()))throw Error('Invalid task field (limit '+max+' characters)');
  return v.trim();
};
const change=(t,event,details={})=>{
  t.updatedAt=Date.now();t.history.push({at:t.updatedAt,event,...details});
};
export class TaskBook {
  constructor(){this.tasks=new Map();}
  load(records){
    for(const record of records||[]){
      const t=structuredClone(record);
      if(t.activeAttempt){
        this.finish(t,'uncertain','Backend restarted; review workspace and native conversation before retrying.');
      }
      this.tasks.set(t.id,t);
    }
  }
  list(){return [...this.tasks.values()];}
  get(id){const t=this.tasks.get(id);if(!t)throw Error('Unknown task');return t;}
  forSession(id){return this.list().find(t=>t.activeAttempt?.sessionId===id);}
  create(projectId,data){
    if(this.tasks.size>=500)throw Error('Task limit reached (500)');
    const t={id:randomUUID(),projectId,title:'',description:'',criteria:'',priority:'normal',status:'backlog',sessionId:null,activeAttempt:null,attempts:[],history:[],createdAt:Date.now(),updatedAt:Date.now()};
    this.fields(t,data);change(t,'created');this.tasks.set(t.id,t);return t;
  }
  fields(t,data){
    const title=field(data.title,120,true),description=field(data.description??'',12000),criteria=field(data.criteria??'',8000),priority=data.priority??'normal';
    if(!priorities.includes(priority))throw Error('Invalid priority');
    Object.assign(t,{title,description,criteria,priority});
  }
  editable(t){if(t.activeAttempt)throw Error('Task is executing; stop the session or wait for review');}
  edit(t,data){this.editable(t);this.fields(t,data);change(t,'edited');}
  assign(t,sessionId){this.editable(t);if(t.sessionId===sessionId)return;t.sessionId=sessionId;change(t,'assigned',{sessionId});}
  move(t,status){
    this.editable(t);
    if(!statuses.includes(status))throw Error('Invalid status');
    if(status===t.status)return;
    if(status==='done'&&t.status!=='review')throw Error('Move to Review before marking Done');
    if(t.status==='done'&&status!=='backlog'&&status!=='ready')throw Error('Reopen completed tasks to Backlog or Ready');
    const from=t.status;t.status=status;change(t,'status',{from,to:status});
  }
  begin(t,sessionId){
    if(t.activeAttempt||t.status!=='ready')throw Error('Only a Ready task can be dispatched');
    if(t.attempts.length>=100)throw Error('Attempt limit reached; create a follow-up task');
    const a={id:randomUUID(),sessionId,startedAt:Date.now(),endedAt:null,outcome:'running',title:t.title,description:t.description,criteria:t.criteria};
    t.activeAttempt=a;t.attempts.push(a);const from=t.status;t.status='in-progress';change(t,'dispatched',{from,to:t.status,attemptId:a.id,sessionId});return a;
  }
  finish(t,outcome,note=''){
    if(!t.activeAttempt)return;
    const a=t.attempts.find(a=>a.id===t.activeAttempt.id);
    if(a){a.outcome=outcome;a.endedAt=Date.now();a.note=note;}
    const id=t.activeAttempt.id;t.activeAttempt=null;t.status='review';change(t,'attempt-ended',{attemptId:id,outcome,note,to:'review'});
  }
  observe(sessionId,status){
    const t=this.forSession(sessionId);
    if(!t)return;
    if(['completed','failed','interrupted','uncertain','disconnected'].includes(status))this.finish(t,status==='disconnected'?'uncertain':status);
  }
  remove(t){this.editable(t);this.tasks.delete(t.id);}
  prompt(t){return ['Task: '+t.title,'Description:\n'+(t.description||'(none provided)'),'Acceptance criteria:\n'+(t.criteria||'(none provided)'),'Work within this session’s workspace and approval rules. Report changes, verification results, and any remaining issues for human review. Do not mark the task complete yourself.'].join('\n\n');}
}
