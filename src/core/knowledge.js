// Room CLI — per-room knowledge: the "stored on disk, loaded into memory when needed"
// brain. Source of truth is memory.json (compact + curated); the full transcript lives
// in log.jsonl (on disk, never loaded into a prompt). CONTEXT.md is a rendered, human-
// readable mirror of memory.json. Each turn loads only the budgeted context preamble, so
// a room can carry ALL its history yet stay token-cheap.
import fs from 'node:fs';
import path from 'node:path';
import { ROOMS_DIR } from './roomstore.js';

// Budget (characters) of room knowledge injected into each turn. ~10k chars ≈ 2.5k tokens,
// and stays well under Windows' command-line length limit when passed as an argv prompt.
export const CONTEXT_BUDGET = 10_000;
const RECENT_KEEP = 14; // rolling window of recent-activity notes kept in memory
const DURABLE_KEEP = 80; // max durable facts retained (oldest dropped first)

export function roomDir(id) {
  const d = path.join(ROOMS_DIR, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const memoryPath = (id) => path.join(roomDir(id), 'memory.json');
const contextMdPath = (id) => path.join(roomDir(id), 'CONTEXT.md');
const logFilePath = (id) => path.join(roomDir(id), 'log.jsonl');

function emptyMemory() {
  return { overview: '', durable: [], recent: [], stats: { turns: 0, premiumRequests: 0 } };
}

export function readMemory(id) {
  try {
    const m = JSON.parse(fs.readFileSync(memoryPath(id), 'utf8'));
    return { ...emptyMemory(), ...m };
  } catch {
    return emptyMemory();
  }
}

export function writeMemory(id, mem) {
  fs.writeFileSync(memoryPath(id), JSON.stringify(mem, null, 2));
  renderContextMd(id, mem);
  return mem;
}

// Seed a room's knowledge from its rooms.json `seed` block, only if not already present.
export function ensureSeed(room) {
  const p = memoryPath(room.id);
  if (fs.existsSync(p)) return readMemory(room.id);
  const mem = emptyMemory();
  mem.overview = room.seed?.overview || '';
  mem.durable = (room.seed?.durable || []).map((text) => ({ text, ts: Date.now(), src: 'seed' }));
  return writeMemory(room.id, mem);
}

function renderContextMd(id, mem) {
  const lines = [`# Room knowledge`, ''];
  if (mem.overview) lines.push(mem.overview, '');
  if (mem.durable.length) {
    lines.push('## Durable knowledge');
    for (const f of mem.durable) lines.push(`- ${f.text}`);
    lines.push('');
  }
  if (mem.recent.length) {
    lines.push('## Recent activity');
    for (const r of mem.recent) lines.push(`- ${r.summary}`);
    lines.push('');
  }
  try {
    fs.writeFileSync(contextMdPath(id), lines.join('\n'));
  } catch {
    /* best effort */
  }
}

// Compose the budgeted context block injected at the start of a turn. Durable facts are
// prioritised; recent activity fills the remaining budget (newest first).
export function buildContextBlock(room) {
  const mem = readMemory(room.id);
  const parts = [];
  if (mem.overview) parts.push(`OVERVIEW: ${mem.overview}`);
  if (mem.durable.length) {
    parts.push('DURABLE KNOWLEDGE (accumulated across all past sessions in this room):');
    for (const f of mem.durable) parts.push(`- ${f.text}`);
  }
  if (mem.recent.length) {
    parts.push('RECENT ACTIVITY (most recent last):');
    for (const r of mem.recent) parts.push(`- ${r.summary}`);
  }
  let block = parts.join('\n');
  if (block.length > CONTEXT_BUDGET) {
    // Keep the head (overview + durable) and trim the recent tail to fit.
    block = block.slice(0, CONTEXT_BUDGET) + '\n…(older context elided; full history on disk)';
  }
  return block;
}

export function readLog(id, limit = 60) {
  try {
    const raw = fs.readFileSync(logFilePath(id), 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split(/\n/);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendLog(id, entry) {
  fs.appendFileSync(logFilePath(id), JSON.stringify(entry) + '\n');
}

function shorten(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Persist a completed turn: append the full transcript to log.jsonl and fold a compact
// note into memory.json (recent activity + any MEMORY: durable facts the model surfaced).
export function recordTurn(room, { prompt, response, memory = [], sessionId, usage }) {
  appendLog(room.id, {
    ts: Date.now(),
    prompt,
    response,
    memory,
    sessionId: sessionId || null,
    usage: usage || null,
  });

  const mem = readMemory(room.id);
  mem.stats = mem.stats || { turns: 0, premiumRequests: 0 };
  mem.stats.turns += 1;
  mem.stats.premiumRequests += usage?.premiumRequests || 0;

  // Recent activity note: prompt -> short response summary.
  mem.recent.push({
    ts: Date.now(),
    summary: `${shorten(prompt, 90)} → ${shorten(response, 140)}`,
  });
  if (mem.recent.length > RECENT_KEEP) mem.recent = mem.recent.slice(-RECENT_KEEP);

  // Durable facts the model explicitly flagged for long-term memory.
  for (const fact of memory) {
    const text = shorten(fact, 240);
    if (!text) continue;
    if (mem.durable.some((f) => f.text === text)) continue;
    mem.durable.push({ text, ts: Date.now(), src: 'turn' });
  }
  if (mem.durable.length > DURABLE_KEEP) mem.durable = mem.durable.slice(-DURABLE_KEEP);

  writeMemory(room.id, mem);
  return mem;
}

// Manually add or remove a durable fact (from the UI knowledge panel).
export function addDurable(id, text) {
  const mem = readMemory(id);
  const t = shorten(text, 240);
  if (t && !mem.durable.some((f) => f.text === t)) {
    mem.durable.push({ text: t, ts: Date.now(), src: 'manual' });
    if (mem.durable.length > DURABLE_KEEP) mem.durable = mem.durable.slice(-DURABLE_KEEP);
    writeMemory(id, mem);
  }
  return mem;
}

export function removeDurable(id, index) {
  const mem = readMemory(id);
  if (index >= 0 && index < mem.durable.length) {
    mem.durable.splice(index, 1);
    writeMemory(id, mem);
  }
  return mem;
}
