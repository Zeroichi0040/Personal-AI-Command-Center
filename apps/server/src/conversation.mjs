import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const input = text => [{ type: 'text', text }];
const bounded = (text, max = 100_000) => typeof text === 'string' ? text.slice(0, max) : '';
const terminal = new Set(['completed','interrupted','failed']);
const approvals = new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval']);
function toolLabel(item) {
  if (item.type === 'commandExecution') {
    const command = Array.isArray(item.commandActions) && item.commandActions.length &&
      item.commandActions.every(action => typeof action?.command === 'string' && action.command.trim())
      ? item.commandActions.map(action => action.command).join(' · ') : item.command;
    const full = typeof command === 'string' ? command.replace(/\s+/g,' ').trim() : '';
    const preview = full.length > 100 ? full.slice(0,97) + '…' : full;
    const verb = item.status === 'declined' ? 'Declined command' : item.status === 'failed' || (item.status === 'completed' && item.exitCode != null && item.exitCode !== 0) ? 'Command failed' : item.status === 'completed' ? 'Ran' : 'Running';
    return preview ? verb + ' ' + preview : verb;
  }
  return ({fileChange:'File changes',mcpToolCall:'MCP tool',dynamicToolCall:'Tool call',webSearch:'Web search',plan:'Plan',collabAgentToolCall:'Agent activity'})[item.type] || 'Tool activity';
}
const allowedTools = new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','plan','collabAgentToolCall']);
export class Conversation extends EventEmitter {
  constructor({ client, cwd, writable = false }) {
    super();
    this.client = client; this.cwd = cwd; this.writable = writable;
    this.connected = false; this.threadId = null; this.turnId = null;
    this.status = 'connecting'; this.startedAt = null; this.endedAt = null;
    this.messages = []; this.queue = []; this.models = []; this.pending = new Map();
    this.early = []; this.error = null; this.items = new Map(); this.fileChanges = new Map(); this.commandItems = new Map();
    this.client.on('notification', n => this.onEvent(n));
    this.client.on('disconnect', () => {
      const wasActive=this.active()||this.status==='uncertain';
      this.connected = false; this.status = wasActive?'uncertain':'disconnected'; this.endedAt = Date.now();
      this.queue = []; this.clearApprovals(); this.emitState();
    });
  }
  snapshot() {
    return { connected: this.connected, threadId: this.threadId, status: this.status,
      cwd: this.cwd, writable: this.writable, startedAt: this.startedAt, endedAt: this.endedAt,
      turnReady: !!this.turnId && this.status === 'running', messages: this.messages, queue: this.queue,
      models: this.models, approvals: [...this.pending.values()].map(({ publicData }) => publicData), error: this.error };
  }
  emitState(mode = 'immediate') { this.emit('state', this.snapshot(), mode); }
  async initialize() {
    await this.client.initialize();
    const { account } = await this.client.request('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Sign in using ChatGPT with codex login first');
    this.connected = true; this.status = 'idle';
    try {
      let cursor = null;
      do {
        const page = await this.client.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) break;
        this.models.push(...page.data.filter(m => !m.hidden && typeof m.model === 'string').map(m => ({
          model: m.model, name: m.displayName || m.model, default: !!m.isDefault, effort: m.defaultReasoningEffort,
          efforts: (m.supportedReasoningEfforts || []).map(e => e.reasoningEffort)
        })));
        cursor = page.nextCursor;
      } while (cursor && this.models.length < 500);
    } catch { this.error = 'Model catalog unavailable; using runtime default.'; }
    this.emitState();
  }
  async resume(saved) {
    this.messages=structuredClone(saved.messages||[]);
    this.startedAt=saved.startedAt??null;this.endedAt=saved.endedAt??null;
    this.threadId=saved.threadId??null;this.queue=[];this.turnId=null;
    await this.initialize();
    if(this.threadId){
      const result=await this.client.request('thread/resume',{threadId:this.threadId,cwd:this.cwd,sandbox:this.writable?'workspace-write':'read-only',approvalPolicy:'on-request'});
      if(result?.thread?.id!==this.threadId)throw Error('Native resume returned a different thread');
      if(result.thread.status?.type==='active'||result.thread.turns?.some(t=>t.status==='inProgress'))throw Error('Native thread is still active; inspect it in Codex before reconnecting');
    }
    if(!this.connected)throw Error('Runtime disconnected during recovery');
    this.status='idle';
    this.error=null;this.emitState();
  }
  validateMessage(data) {
    if (!data || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 40_000) throw new Error('Enter a message of 1–40000 characters');
    const model = data.model || undefined, effort = data.effort || undefined;
    const entry = this.models.find(m => m.model === model);
    if (model && !entry) throw new Error('Unknown model');
    if (effort && (!entry || !entry.efforts.includes(effort))) throw new Error('Unsupported reasoning effort');
    return { text: data.text.trim(), model, effort };
  }
  active() { return ['starting','running','stopping'].includes(this.status); }
  async send(data) {
    if (!this.connected || this.status === 'uncertain') throw new Error('Runtime unavailable; restart the application');
    const message = this.validateMessage(data);
    if (this.active()) {
      if (this.queue.length >= 10) throw new Error('Queue is full');
      this.queue.push({ ...message, id: randomUUID() }); this.emitState(); return;
    }
    await this.start(message);
  }
  async start(message) {
    this.status = 'starting'; this.error = null; this.turnId = null; this.early = [];
    this.startedAt = Date.now(); this.endedAt = null; this.items.clear(); this.fileChanges.clear(); this.commandItems.clear();
    this.messages.push({ id: randomUUID(), kind: 'user', text: message.text }); this.emitState();
    try {
      if (!this.threadId) {
        const result = await this.client.request('thread/start', { cwd: this.cwd, sandbox: this.writable ? 'workspace-write' : 'read-only', approvalPolicy: 'on-request' });
        if (typeof result?.thread?.id !== 'string') throw new Error('Missing thread ID');
        this.threadId = result.thread.id;
        // Checkpoint the native ID before dispatching any model work.
        this.emitState();
      }
      const result = await this.client.request('turn/start', {
        threadId: this.threadId, input: input(message.text), cwd: this.cwd, approvalPolicy: 'on-request',
        sandboxPolicy: this.writable ? { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false } : { type: 'readOnly' },
        ...(message.model ? { model: message.model } : {}), ...(message.effort ? { effort: message.effort } : {})
      });
      if (!this.connected) return;
      if (typeof result?.turn?.id !== 'string') throw new Error('Missing turn ID');
      this.turnId = result.turn.id; this.status = 'running';
      const events = this.early; this.early = [];
      for (const e of events) { if (this.turnId !== result.turn.id) break; this.onEvent(e); }
      if (this.turnId === result.turn.id && terminal.has(result.turn.status)) this.finish(result.turn.status);
      this.emitState();
    } catch (error) {
      if (!this.connected) return;
      this.status = 'uncertain'; this.error = 'Start failed; outcome may be unknown. Restart before sending again. ' + error.message;
      this.endedAt = Date.now(); this.queue = []; this.clearApprovals(); this.emitState();
    }
  }
  onEvent(event) {
    const { method, params: p } = event;
    if (p?.threadId !== this.threadId || !this.active()) return;
    if (method === 'serverRequest/resolved') {
      for (const [id, pending] of this.pending) if (pending.requestId === p.requestId) this.resolveApproval(id,'decline');
      return;
    }
    if (!this.turnId) {
      if (this.early.length >= 10000) { this.client.close(); return; }
      this.early.push(event); return;
    }
    const id = method === 'turn/completed' ? p.turn?.id : p.turnId;
    if (id !== this.turnId) return;
    if (method === 'turn/completed') { this.finish(p.turn.status); return; }
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      if (typeof p.itemId !== 'string') return;
      const kind = method.includes('reasoning') ? 'reasoning' : 'assistant';
      const key = this.turnId + ':' + p.itemId + ':' + kind + (kind === 'reasoning' ? ':' + (p.summaryIndex ?? 0) : '');
      let item = this.items.get(key);
      if (!item) { item = { id: key, kind, text: '', startedAt: Date.now() }; this.items.set(key,item); this.messages.push(item); }
      item.text = bounded(item.text + bounded(p.delta));
      this.emitState('stream'); return;
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item;
      if (!item || typeof item.id !== 'string') return;
      if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') {
        const key = this.turnId + ':' + item.id + ':assistant';
        let record = this.items.get(key);
        if (!record) { record = { id:key,kind:'assistant',text:'' }; this.items.set(key, record); this.messages.push(record); }
        record.text = bounded(item.text);
      } else if (allowedTools.has(item.type)) {
        const key = this.turnId + ':' + item.id + ':tool';
        if (item.type === 'fileChange' && method === 'item/started') this.fileChanges.set(key, JSON.stringify(item,null,2));
        if (item.type === 'commandExecution' && method === 'item/started') this.commandItems.set(key,item);
        if (method === 'item/completed') { this.commandItems.delete(key); this.fileChanges.delete(key); }
        let record = this.items.get(key);
        if (!record) { record = { id:key,kind:'tool',text:item.type,startedAt:Date.now() }; this.items.set(key,record); this.messages.push(record); }
        record.text = bounded(JSON.stringify(item, null, 2)); record.label = toolLabel(item);
        if (method === 'item/completed') record.endedAt = Date.now();
      } else if (item.type === 'reasoning' && method === 'item/completed') {
        for (const [key, record] of this.items) if (key.startsWith(this.turnId + ':' + item.id + ':reasoning:')) record.endedAt = Date.now();
      }
    } else if (method === 'error') { this.error = bounded(p.error?.message, 2000) || 'Runtime error'; }
    this.emitState();
  }
  finish(status) {
    if (!this.active()) return;
    this.status = terminal.has(status) ? status : 'failed'; this.endedAt = Date.now(); this.turnId = null;
    this.clearApprovals();
    if (status !== 'completed') this.queue = [];
    const next = status === 'completed' ? this.queue.shift() : null;
    if (next) void this.start(next); else this.emitState();
  }
  async stop() {
    if (!this.turnId || this.status !== 'running') throw new Error('Turn is not ready to stop');
    this.queue = []; this.status = 'stopping'; this.clearApprovals(); this.emitState();
    const turnId = this.turnId;
    try { await this.client.request('turn/interrupt', { threadId: this.threadId, turnId }); }
    catch (error) { if (this.turnId === turnId && this.connected) { this.status='uncertain'; this.error=error.message; this.endedAt=Date.now(); this.emitState(); } }
  }
  async steer(data) {
    if (this.status !== 'running' || !this.turnId) throw new Error('No active turn');
    const { text } = this.validateMessage({ text:data?.text });
    const expectedTurnId = this.turnId;
    await this.client.request('turn/steer', { threadId:this.threadId, expectedTurnId, input:input(text) });
    this.messages.push({ id:randomUUID(),kind:'user',text,label:'Steered' }); this.emitState();
  }
  removeQueued(id) { this.queue = this.queue.filter(m => m.id !== id); this.emitState(); }
  approvalDiagnostic(reason) {
    const now = Date.now();
    this.messages.push({ id:randomUUID(),kind:'tool',label:'Approval automatically declined — ' + reason,text:reason,startedAt:now,endedAt:now });
    this.emitState();
  }
  requestApproval({ id:requestId, method, params }) {
    const scoped = params && params.threadId === this.threadId && this.threadId && this.active();
    if (!approvals.has(method) || !scoped || typeof params.turnId !== 'string' || this.status === 'stopping' || (this.turnId && params.turnId !== this.turnId)) {
      if (this.active() && (!params?.threadId || params.threadId === this.threadId)) this.approvalDiagnostic(!approvals.has(method) ? 'Unsupported request type: ' + bounded(method,120) : 'Request is not scoped to the active turn');
      return Promise.reject(new Error('Unsupported request'));
    }
    const decline = reason => { this.approvalDiagnostic(reason); return Promise.resolve({ decision:'decline' }); };
    if (JSON.stringify(params).length > 100_000) return decline('Approval request is too large to review safely');
    if (params.networkApprovalContext != null) return decline('Managed network approvals are not supported');
    if (params.additionalPermissions != null) return decline('Additional sandbox permissions are not supported');
    if (params.grantRoot != null) return decline('Persistent filesystem grants are not supported');
    // Optional persistence proposals are hints only. Never return a policy amendment or session grant.
    const decisions = params.availableDecisions;
    if (decisions != null && (!Array.isArray(decisions) || !decisions.includes('accept'))) return decline('Runtime did not offer one-time acceptance');
    const isCommand = method === 'item/commandExecution/requestApproval';
    const type = isCommand ? 'commandExecution' : 'fileChange';
    const key = params.turnId + ':' + params.itemId + ':tool';
    const earlyItem = typeof params.itemId === 'string' && this.early.find(e => e.method === 'item/started' && e.params?.threadId === this.threadId && e.params?.turnId === params.turnId && e.params?.item?.id === params.itemId && e.params?.item?.type === type)?.params.item;
    let review;
    if (isCommand) {
      const item = this.commandItems.get(key) || earlyItem;
      const hasText = value => typeof value === 'string' && value.trim().length > 0;
      const command = hasText(params.command) ? params.command : item?.command;
      if (!hasText(command)) return decline('No reviewable command in the request or matching started item');
      const cwd = params.cwd ?? item?.cwd ?? null;
      review = { command, cwd, reason:params.reason ?? null, request:params, ...(item ? { startedItem:{command:item.command,cwd:item.cwd} } : {}) };
    } else {
      const details = this.fileChanges.get(key) || (earlyItem && JSON.stringify(earlyItem,null,2));
      if (!details) return decline('No matching proposed file changes to review');
      review = { request:params, fileChange:JSON.parse(details) };
    }
    const details = JSON.stringify(review,null,2);
    if (details.length > 100_000) return decline('Operation details are too large to review safely');
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.approvalDiagnostic('Approval expired'); this.resolveApproval(id,'decline'); }
      },300_000);
      this.pending.set(id,{resolve,timer,requestId,turnId:params.turnId,publicData:{id,method,details}});
      this.emitState();
    });
  }
  resolveApproval(id, decision) {
    const pending = this.pending.get(id);
    if (!pending || !['accept','decline'].includes(decision)) throw new Error('Invalid or expired approval');
    if (decision === 'accept' && (this.status !== 'running' || this.turnId !== pending.turnId)) throw new Error('Approval is not attached to the active turn');
    clearTimeout(pending.timer); this.pending.delete(id); pending.resolve({ decision }); this.emitState();
  }
  clearApprovals() { for (const id of [...this.pending.keys()]) this.resolveApproval(id,'decline'); }
}
