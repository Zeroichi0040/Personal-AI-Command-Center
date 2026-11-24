import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// Minimal transport spike. No shell, credential handling, retries or browser API.
export class CodexClient extends EventEmitter {
  #proc; #pending = new Map(); #next = 1; #closed = false;
  #ready = false; #initializing = false; #lines; #serverRequest;
  constructor({ executable = process.env.CODEX_EXECUTABLE || 'codex', args = ['app-server'], timeoutMs = 30_000, serverRequest } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.#serverRequest = serverRequest;
    this.#proc = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#lines = createInterface({ input: this.#proc.stdout, crlfDelay: Infinity });
    this.#lines.on('line', line => this.#receive(line));
    this.#proc.stderr.resume(); // Avoid leaking credentials or private paths in logs.
    this.#proc.on('error', error => this.#fail(error));
    this.#proc.stdin.on('error', error => this.#fail(error));
    this.#proc.stdout.on('error', error => this.#fail(error));
    this.#proc.on('close', (code, signal) => this.#fail(new Error(`Codex exited (${code ?? signal})`)));
  }
  #write(message) {
    if (this.#closed) throw new Error('Codex connection closed');
    this.#proc.stdin.write(JSON.stringify(message) + '\n');
  }
  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) { clearTimeout(timer); reject(error); }
    this.#pending.clear();
    this.#lines.close();
    this.#proc.stdin.destroy();
    this.#proc.kill();
    this.emit('disconnect', error);
  }
  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.#fail(new Error('Invalid JSON from Codex')); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.#fail(new Error('Invalid RPC message')); return; }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) {
        // Milestone 1 intentionally cannot approve tools, write access or user input.
        // Do not log server request parameters; they may contain private data.
        if (this.#serverRequest) {
          Promise.resolve().then(() => this.#serverRequest(message)).then(
            result => { if (!this.#closed && result !== undefined) this.#write({ id: message.id, result }); },
            () => { if (!this.#closed) this.#write({ id: message.id, error: { code: -32601, message: 'Unsupported or cancelled server request' } }); }
          ).catch(error => this.#fail(error));
        } else {
          try { this.#write({ id: message.id, error: { code: -32601, message: 'Server requests are not supported by the read-only smoke client' } }); }
          catch (error) { this.#fail(error); }
        }
      } else { this.emit('notification', message); }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id); clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
      const error = new Error(`Codex RPC ${pending.method} failed (code ${message.error?.code ?? 'unknown'})`);
      error.code = message.error?.code; pending.reject(error);
    } else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
    else pending.reject(new Error('Malformed RPC response'));
  }
  #request(method, params) {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(new Error('Codex connection closed')); return; }
      const id = this.#next++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC timed out: ${method}; outcome unknown`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.#write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    if (this.#ready || this.#initializing) throw new Error('Already initialized or initializing');
    this.#initializing = true;
    try {
      const info = await this.#request('initialize', { clientInfo: { name: 'personal_ai_command_center', title: 'Personal AI Command Center', version: '0.1.0-rc.1' } });
      this.#write({ method: 'initialized' });
      this.#ready = true; return info;
    } catch (error) { this.#fail(error); throw error; }
    finally { this.#initializing = false; }
  }
  request(method, params) {
    if (!this.#ready) return Promise.reject(new Error('Initialize first'));
    return this.#request(method, params);
  }
  close() { this.#fail(new Error('Connection closed by client')); }
}
