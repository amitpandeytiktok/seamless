// Room CLI — warm worker pool over the Copilot CLI's Agent Client Protocol (ACP).
//
// Spawning `copilot -p` fresh per turn costs ~8.5s of cold start (Node boot, auth,
// MCP servers, tool defs). This pool keeps N `copilot --acp` processes warm so a
// turn pays only model time. To preserve Room CLI's "cheap context" guarantee we
// open a FRESH ACP session per turn (session/new) and inject the room's distilled
// knowledge as the prompt — exactly like the cold engine, just without the boot.
//
// ACP here is JSON-RPC 2.0 over newline-delimited stdio:
//   initialize -> session/new {cwd} -> session/prompt {prompt:[{type:text}]}
//   streaming via session/update notifications; tool gating via session/request_permission.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import { resolveCwd } from './roomstore.js';
import { buildPrompt, extractMemory } from './engine.js';

const COPILOT_BIN = process.env.ROOMCLI_COPILOT_BIN || 'copilot';
const POOL_SIZE = Math.max(0, Number.parseInt(process.env.ROOMCLI_ACP_POOL || '0', 10) || 0);
const INIT_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
const ACQUIRE_TIMEOUT_MS = 20_000;
const RECYCLE_AFTER_TURNS = 50; // bound per-process session/memory growth

export function acpEnabled() {
  return POOL_SIZE > 0;
}

// Tools a "chat" room must never run (mirrors the cold engine's excluded-tools).
const CHAT_DENY_KINDS = new Set(['execute', 'edit', 'delete', 'move']);

// Decide how to answer an ACP permission request. agent rooms auto-allow (and
// remember within the session to cut round-trips); chat rooms allow read-only
// kinds once but reject anything that mutates the system.
export function permissionDecision(permission, kind) {
  if (permission === 'chat') {
    return CHAT_DENY_KINDS.has(String(kind)) ? 'reject_once' : 'allow_once';
  }
  return 'allow_always';
}

function summarizeAcpTool(u) {
  const ri = u.rawInput || {};
  if (ri.description) return ri.description;
  if (ri.command) return String(ri.command).slice(0, 80);
  if (ri.path) return String(ri.path);
  return u.title || '';
}

function acpToolPreview(u) {
  const arr = Array.isArray(u.content) ? u.content : [];
  for (const c of arr) {
    const t = c?.content?.text ?? c?.text;
    if (t) return String(t).replace(/\s+/g, ' ').slice(0, 160);
  }
  return '';
}

let WORKER_SEQ = 0;

// One warm `copilot --acp` process. Handles exactly one turn at a time (busy).
class AcpWorker {
  constructor() {
    this.id = ++WORKER_SEQ;
    this.proc = null;
    this.ready = false;
    this.dead = false;
    this.busy = false;
    this.turns = 0;
    this.nextId = 1;
    this.pending = new Map(); // jsonrpc id -> {resolve, reject, timer}
    this.active = null; // current turn context
  }

  start() {
    this.proc = spawn(COPILOT_BIN, ['--acp'], { env: process.env, windowsHide: true });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.proc.stderr.on('data', () => {});
    this.proc.on('error', () => this._die(new Error('spawn error')));
    this.proc.on('close', () => this._die(new Error('worker exited')));
    return this._initialize();
  }

  _die(err) {
    this.dead = true;
    this.ready = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    try { this.rl?.close(); } catch { /* ignore */ }
  }

  _send(obj) {
    if (this.dead || !this.proc?.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _call(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _respond(id, result) {
    this._send({ jsonrpc: '2.0', id, result });
  }

  _respondError(id, message) {
    this._send({ jsonrpc: '2.0', id, error: { code: -32601, message } });
  }

  async _initialize() {
    await this._call(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
      INIT_TIMEOUT_MS,
    );
    this.ready = true;
  }

  _onLine(line) {
    const s = line.trim();
    if (!s) return;
    let m;
    try {
      m = JSON.parse(s);
    } catch {
      return; // ignore non-JSON noise
    }
    // Agent -> client request (id + method): must answer.
    if (m.method && m.id !== undefined) {
      this._onRequest(m);
      return;
    }
    // Agent -> client notification.
    if (m.method) {
      if (m.method === 'session/update') this._onUpdate(m.params || {});
      return;
    }
    // Response to one of our calls.
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'ACP error'));
      else p.resolve(m.result);
    }
  }

  _onRequest(m) {
    if (m.method === 'session/request_permission') {
      const a = this.active;
      const kind = m.params?.toolCall?.kind;
      const want = permissionDecision(a?.permission || 'agent', kind);
      const opts = m.params?.options || [];
      const pick = opts.find((o) => o.optionId === want)
        || opts.find((o) => /allow/i.test(o.optionId || ''))
        || opts[0];
      this._respond(m.id, { outcome: { outcome: 'selected', optionId: pick?.optionId } });
      return;
    }
    // We declared no fs/terminal client capabilities; decline anything else.
    this._respondError(m.id, 'unsupported');
  }

  _onUpdate(params) {
    const a = this.active;
    if (!a || params.sessionId !== a.sessionId) return;
    const u = params.update || {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.text || '';
        if (t) {
          a.chunks.push(t);
          a.onEvent({ kind: 'assistant_delta', text: t });
        }
        break;
      }
      case 'agent_thought_chunk':
        if (!a.thoughtShown) {
          a.thoughtShown = true;
          a.onEvent({ kind: 'status', text: 'thinking…' });
        }
        break;
      case 'tool_call':
        a.tools.set(u.toolCallId, u.title || u.kind || 'tool');
        a.onEvent({ kind: 'tool_start', name: u.title || u.kind || 'tool', summary: summarizeAcpTool(u) });
        break;
      case 'tool_call_update': {
        const terminal = u.status === 'completed' || u.status === 'failed' || Array.isArray(u.content);
        if (terminal && !a.toolsDone.has(u.toolCallId)) {
          a.toolsDone.add(u.toolCallId);
          a.onEvent({
            kind: 'tool_done',
            name: a.tools.get(u.toolCallId) || 'tool',
            success: u.status !== 'failed',
            preview: acpToolPreview(u),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // Run one turn. Throws ONLY before any output streams (session/new failure) so
  // the caller can cleanly fall back to the cold engine; once prompting starts it
  // always resolves (ok:false on error) to avoid double-streaming.
  async runTurn({ cwd, prompt, permission, onEvent }) {
    if (!this.ready || this.dead) throw new Error('worker not ready');
    const sess = await this._call('session/new', { cwd, mcpServers: [] }, 25_000);
    const sessionId = sess?.sessionId;
    if (!sessionId) throw new Error('session/new returned no sessionId');

    this.active = {
      sessionId, permission, onEvent, chunks: [], tools: new Map(), toolsDone: new Set(), thoughtShown: false,
    };
    let stopReason = 'error';
    let errText = '';
    try {
      const pr = await this._call('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, TURN_TIMEOUT_MS);
      stopReason = pr?.stopReason || 'end_turn';
    } catch (e) {
      errText = String(e.message || e);
      onEvent({ kind: 'error', text: errText });
    }
    const chunks = this.active.chunks;
    this.active = null;
    this.turns += 1;

    const { response, memory } = extractMemory(chunks.join(''));
    if (response) onEvent({ kind: 'assistant_message', text: response });
    const ok = !errText && stopReason !== 'refusal' && stopReason !== 'cancelled';
    return { ok, response, memory, sessionId, usage: null, exitCode: ok ? 0 : 1, stopReason, stderr: errText };
  }

  dispose() {
    this.dead = true;
    try { this.proc?.kill(); } catch { /* ignore */ }
  }
}

// A pool of warm workers. Lazily fills to POOL_SIZE, hands a free worker to each
// turn, queues when saturated, and replaces dead/over-used workers.
class AcpPool {
  constructor(size, makeWorker = () => new AcpWorker()) {
    this.size = size;
    this.makeWorker = makeWorker;
    this.workers = [];
    this.queue = [];
    this.drainTimer = null;
  }

  start() {
    this._fill();
  }

  _fill() {
    while (this.workers.length < this.size) {
      const w = this.makeWorker();
      this.workers.push(w);
      w.start().catch(() => { w.dead = true; });
    }
  }

  _reap() {
    for (const w of this.workers) {
      if (!w.busy && (w.dead || w.turns >= RECYCLE_AFTER_TURNS)) {
        w.dispose();
      }
    }
    this.workers = this.workers.filter((w) => !w.dead);
    this._fill();
  }

  _free() {
    return this.workers.find((w) => w.ready && !w.busy && !w.dead) || null;
  }

  _acquire() {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      // Returns true (and resolves the waiter) iff a free worker was claimed.
      const grab = () => {
        const w = this._free();
        if (!w) return false;
        w.busy = true;
        resolve(w);
        return true;
      };
      if (grab()) return;
      this._reap(); // drop dead/over-used, refill (new workers warm asynchronously)
      if (grab()) return;
      waiter.grab = grab;
      waiter.timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        if (!this.queue.length) this._stopDrain();
        reject(new Error('no warm worker available'));
      }, ACQUIRE_TIMEOUT_MS);
      this.queue.push(waiter);
      this._startDrain(); // wake the waiter once a reaped slot warms up
    });
  }

  // Hand free workers to queued waiters (FIFO). Called on release and on a poll
  // so a waiter still gets served when its worker is replaced rather than freed.
  _drainQueue() {
    while (this.queue.length) {
      const w = this._free();
      if (!w) break;
      const waiter = this.queue.shift();
      clearTimeout(waiter.timer);
      w.busy = true;
      waiter.resolve(w);
    }
    if (!this.queue.length) this._stopDrain();
  }

  _startDrain() {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      this._reap();
      this._drainQueue();
    }, 500);
    if (this.drainTimer.unref) this.drainTimer.unref();
  }

  _stopDrain() {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  _release(worker) {
    worker.busy = false;
    if (worker.dead || worker.turns >= RECYCLE_AFTER_TURNS) this._reap();
    this._drainQueue();
  }

  async runTurn(room, prompt, { onEvent = () => {} } = {}) {
    const worker = await this._acquire(); // throws if none in time -> caller falls back
    try {
      return await worker.runTurn({
        cwd: resolveCwd(room),
        prompt,
        permission: room.permission,
        onEvent,
      });
    } finally {
      this._release(worker);
    }
  }

  stats() {
    return {
      enabled: true,
      size: this.size,
      ready: this.workers.filter((w) => w.ready && !w.dead).length,
      busy: this.workers.filter((w) => w.busy).length,
      queued: this.queue.length,
      warm: !!this.warm,
    };
  }

  // One-time, best-effort heat of the shared on-disk caches (auth token, compiled
  // tool schemas, model endpoint). Measured: the first turn after a cold start is
  // ~8.5s but every turn after is ~3s, and the cost is shared across workers — so a
  // single throwaway turn here makes the user's first real turn fast too.
  async prewarm() {
    if (this.warming || this.warm) return;
    this.warming = true;
    try {
      const w = await this._acquire();
      try {
        await w.runTurn({ cwd: os.homedir(), prompt: 'Reply with exactly: READY', permission: 'agent', onEvent: () => {} });
        this.warm = true;
      } finally {
        this._release(w);
      }
    } catch {
      /* best-effort; a later startPool may retry */
    } finally {
      this.warming = false;
    }
  }
}

let POOL = null;

export function startPool() {
  if (!acpEnabled()) return null;
  if (!POOL) {
    POOL = new AcpPool(POOL_SIZE);
    POOL.start();
    if (process.env.ROOMCLI_ACP_PREWARM !== '0') POOL.prewarm();
  }
  return POOL;
}

export function poolStats() {
  if (!acpEnabled()) return { enabled: false, size: 0, ready: 0, busy: 0, queued: 0, warm: false };
  if (!POOL) startPool();
  return POOL.stats();
}

// Run a room turn on the warm pool. Builds the same budgeted, knowledge-injected
// prompt the cold engine uses. Throws (pre-stream) if no worker is available so
// the caller can fall back to the cold engine.
export function runTurnAcp(room, userRequest, { onEvent = () => {} } = {}) {
  if (!POOL) startPool();
  const prompt = buildPrompt(room, userRequest);
  return POOL.runTurn(room, prompt, { onEvent });
}

// Test-only: build an isolated pool with an injectable worker factory so the
// acquire/release/queue logic can be exercised without spawning real processes.
export function _createPoolForTest(size, makeWorker) {
  const p = new AcpPool(size, makeWorker);
  p.start();
  return p;
}
