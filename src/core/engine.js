// Room CLI — engine. Runs ONE short, fully-context-aware Copilot turn for a room:
// spawns `copilot -p` (non-interactive, JSONL) in the room's working dir with the room's
// compact knowledge injected, streams parsed events to a callback, and returns the captured
// response, the real copilot sessionId, usage, and any durable facts the model surfaced.
//
// Each turn is a FRESH copilot session — continuity comes from the on-disk room knowledge,
// not from a growing chat history. That is what keeps every turn cheap despite "all context".
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolveCwd } from './roomstore.js';
import { buildContextBlock, CONTEXT_BUDGET } from './knowledge.js';

const COPILOT_BIN = process.env.ROOMCLI_COPILOT_BIN || 'copilot';
const MAX_PROMPT_CHARS = 26_000; // stay well under Windows' ~32k command-line limit

function flagsForPermission(room) {
  if (room.permission === 'chat') {
    // Allowed to run (non-interactive needs --allow-all-tools) but no system mutation.
    return [
      '--allow-all-tools',
      '--no-ask-user',
      '--excluded-tools=bash',
      '--excluded-tools=edit',
      '--excluded-tools=create',
    ];
  }
  // Full agent: edit files, run shell, hit the network, deploy.
  return ['--allow-all-tools', '--allow-all-paths', '--allow-all-urls', '--no-ask-user'];
}

// Assemble the budgeted prompt: a room preamble + on-disk knowledge + the new request +
// a self-curation instruction so the model can append durable facts with no extra call.
export function buildPrompt(room, userRequest) {
  let context = buildContextBlock(room);
  const preamble =
    `You are operating inside "${room.name}", a persistent ROOM in Amit's personal control center. ` +
    `Below is this room's accumulated knowledge (kept on disk across every past session). ` +
    `Treat it as authoritative background. Be concise and incremental — do the next step, don't re-explain everything.\n` +
    `If this turn establishes a durable fact, decision, URL, command, or state worth remembering for ALL future sessions in this room, ` +
    `end your reply with one or more lines starting "MEMORY:" (one fact per line, <200 chars).`;
  const tail = `\n\n=== NEW REQUEST ===\n${userRequest}`;
  // If the user request is huge, shrink the context block rather than the request.
  const budget = MAX_PROMPT_CHARS - preamble.length - tail.length - 64;
  if (context.length > Math.max(1000, budget)) {
    context = context.slice(0, Math.max(1000, budget)) + '\n…(older context elided; full history on disk)';
  }
  return `${preamble}\n\n=== ROOM KNOWLEDGE (≤${CONTEXT_BUDGET} chars) ===\n${context}${tail}`;
}

function summarizeTool(name, args) {
  if (!args) return name;
  if (args.description) return `${name}: ${args.description}`;
  if (args.command) return `${name}: ${String(args.command).slice(0, 80)}`;
  if (args.path) return `${name}: ${args.path}`;
  if (args.query) return `${name}: ${String(args.query).slice(0, 80)}`;
  return name;
}

// Run a turn. onEvent receives compact {kind, ...} objects for live streaming.
// Resolves with { ok, response, memory[], sessionId, usage, exitCode }.
export function runTurn(room, userRequest, { onEvent = () => {} } = {}) {
  return new Promise((resolve) => {
    const cwd = resolveCwd(room);
    const prompt = buildPrompt(room, userRequest);
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--no-color',
      '-C', cwd,
      ...flagsForPermission(room),
    ];
    if (room.model && room.model !== 'auto') args.push('--model', room.model);

    let child;
    try {
      child = spawn(COPILOT_BIN, args, {
        cwd,
        env: process.env,
        windowsHide: true,
      });
    } catch (e) {
      onEvent({ kind: 'error', text: `Failed to launch copilot: ${e.message}` });
      return resolve({ ok: false, response: '', memory: [], sessionId: null, usage: null, exitCode: -1 });
    }

    const messages = []; // authoritative assistant text segments
    let sessionId = null;
    let usage = null;
    let stderr = '';

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch {
        return; // ignore non-JSON noise
      }
      const d = ev.data || {};
      switch (ev.type) {
        case 'user.message':
          break;
        case 'assistant.turn_start':
          onEvent({ kind: 'status', text: 'thinking…' });
          break;
        case 'assistant.message_delta':
          if (d.deltaContent) onEvent({ kind: 'assistant_delta', text: d.deltaContent });
          break;
        case 'assistant.message':
          if (d.content && d.content.trim()) {
            messages.push(d.content);
            onEvent({ kind: 'assistant_message', text: d.content });
          }
          break;
        case 'tool.execution_start':
          onEvent({ kind: 'tool_start', name: d.toolName, summary: summarizeTool(d.toolName, d.arguments) });
          break;
        case 'tool.execution_complete': {
          const preview = (d.result?.content || '').replace(/\s+/g, ' ').slice(0, 160);
          onEvent({ kind: 'tool_done', name: d.toolName || 'tool', success: d.success !== false, preview });
          break;
        }
        case 'result':
          sessionId = ev.sessionId || null;
          usage = ev.usage || null;
          break;
        default:
          break;
      }
    });

    child.stderr.on('data', (b) => {
      stderr += b.toString();
    });

    child.on('error', (e) => {
      onEvent({ kind: 'error', text: `copilot error: ${e.message}` });
    });

    child.on('close', (code) => {
      rl.close();
      let response = messages.join('\n\n').trim();
      // Extract MEMORY: lines into durable facts; strip them from the visible response.
      const memory = [];
      response = response
        .split(/\r?\n/)
        .filter((ln) => {
          const m = ln.match(/^\s*MEMORY:\s*(.+)$/i);
          if (m) {
            memory.push(m[1].trim());
            return false;
          }
          return true;
        })
        .join('\n')
        .trim();

      if (!response && stderr) {
        onEvent({ kind: 'error', text: stderr.slice(0, 500) });
      }
      onEvent({ kind: 'result', sessionId, usage });
      resolve({
        ok: code === 0,
        response,
        memory,
        sessionId,
        usage,
        exitCode: code,
        stderr: stderr.slice(0, 2000),
      });
    });
  });
}
