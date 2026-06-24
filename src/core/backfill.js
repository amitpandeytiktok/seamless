// Room CLI — backfill. Distils the local Copilot session store (sessions + checkpoints)
// into each room's on-disk knowledge, so a freshly-seeded control room already "remembers"
// everything you've built. Pure SQL + text heuristics — no model calls, runs in milliseconds.
import { GLOBAL_DB } from './config.js';
import { queryAll } from './db.js';
import { listRooms } from './roomstore.js';
import { readMemory, writeMemory, ensureSeed } from './knowledge.js';

const DURABLE_CAP_PER_ROOM = 28;
const RECENT_SEED = 12;
// A summary that recurs at least this many times is treated as an automated/cron job
// (batch pipelines reuse the same summary), not interactive work worth distilling.
const AUTOMATION_MIN_REPEATS = 25;

// Common words that must NOT be used to claim sessions for a room — they're too generic.
const STOP = new Set([
  'room', 'rooms', 'project', 'projects', 'workspace', 'example', 'main', 'general',
  'studio', 'games', 'game', 'labs', 'lab', 'ops', 'deploy', 'misc', 'stuff', 'test',
  'app', 'apps', 'code', 'dev', 'group', 'work', 'home', 'my',
]);

// Derive match tokens from a room's OWN configuration (no hardcoded business data):
//   strong = the room's working-directory name (high confidence, matched against cwd/repo)
//   weak   = distinctive words from the room id/name (matched against the whole session text)
function roomTokens(room) {
  const strong = [];
  const cwd = String(room.cwd || '~').trim();
  if (cwd && cwd !== '~' && cwd !== '~/') {
    const base = cwd.replace(/^~[\\/]+/, '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    if (base && base.length >= 2) strong.push(base.toLowerCase());
  }
  const weak = new Set();
  for (const w of `${room.id} ${room.name}`.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOP.has(w)) weak.add(w);
  }
  return { id: room.id, strong, weak: [...weak] };
}

// Claim a session for the best-matching room. Working-directory matches (strong) always beat
// name/keyword matches (weak); within a tier the longest, most-specific token wins.
function matchRoom(session, roomMeta) {
  const cwdrepo = `${session.cwd || ''} ${session.repository || ''}`.toLowerCase();
  const hay = `${session.summary || ''} ${cwdrepo}`.toLowerCase();
  let bestId = null;
  let bestLen = 0;
  for (const m of roomMeta) {
    for (const t of m.strong) {
      if (cwdrepo.includes(t) && t.length > bestLen) { bestId = m.id; bestLen = t.length; }
    }
  }
  if (bestId) return bestId;
  for (const m of roomMeta) {
    for (const t of m.weak) {
      if (hay.includes(t) && t.length > bestLen) { bestId = m.id; bestLen = t.length; }
    }
  }
  return bestId;
}

function firstSentence(s, max = 200) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  const cut = t.split(/(?<=[.!?])\s/)[0] || t;
  return cut.length > max ? cut.slice(0, max - 1) + '…' : cut;
}

export function runBackfill({ dbPath = GLOBAL_DB } = {}) {
  const rooms = listRooms();
  const roomMeta = rooms.map(roomTokens);
  for (const r of rooms) ensureSeed(r);

  const allSessions = queryAll(
    dbPath,
    `SELECT s.id, s.cwd, s.repository, s.summary, s.created_at, s.updated_at
       FROM sessions s ORDER BY s.updated_at DESC`
  );

  // Turn counts (cheap single grouped scan) for nicer "recent" labels.
  const turnCounts = new Map();
  for (const row of queryAll(dbPath, `SELECT session_id, COUNT(*) c FROM turns GROUP BY session_id`)) {
    turnCounts.set(row.session_id, row.c);
  }

  // Automated/cron sessions reuse the same summary many times — detect and skip them.
  const summaryCounts = new Map();
  for (const s of allSessions) {
    const key = (s.summary || '').trim().toLowerCase();
    if (key) summaryCounts.set(key, (summaryCounts.get(key) || 0) + 1);
  }
  const isAutomation = (s) => {
    const key = (s.summary || '').trim().toLowerCase();
    return !!key && summaryCounts.get(key) >= AUTOMATION_MIN_REPEATS;
  };

  const sessions = [];
  let automation = 0;
  for (const s of allSessions) {
    if (isAutomation(s)) { automation++; continue; }
    s.nturns = turnCounts.get(s.id) || 0;
    sessions.push(s);
  }

  // Group interactive sessions by room.
  const byRoom = new Map();
  for (const s of sessions) {
    const rid = matchRoom(s, roomMeta);
    if (!rid) continue;
    if (!byRoom.has(rid)) byRoom.set(rid, []);
    byRoom.get(rid).push(s);
  }

  // Checkpoints carry the richest distilled knowledge (title + overview + next steps).
  const checkpoints = queryAll(
    dbPath,
    `SELECT session_id, title, overview, next_steps FROM checkpoints ORDER BY id`
  );
  const cpBySession = new Map();
  for (const c of checkpoints) {
    if (!cpBySession.has(c.session_id)) cpBySession.set(c.session_id, []);
    cpBySession.get(c.session_id).push(c);
  }

  const report = [];
  for (const room of rooms) {
    const sess = byRoom.get(room.id) || [];
    const mem = readMemory(room.id);
    const existing = new Set(mem.durable.map((d) => d.text));
    let durableAdded = 0;

    // Durable facts from checkpoints of this room's sessions.
    const durableCandidates = [];
    for (const s of sess) {
      for (const c of cpBySession.get(s.id) || []) {
        const head = firstSentence(c.overview || c.title, 200);
        if (!head) continue;
        const fact = c.title && !head.toLowerCase().startsWith(c.title.toLowerCase().slice(0, 12))
          ? `${c.title}: ${head}`
          : head;
        durableCandidates.push(fact.slice(0, 240));
      }
    }
    for (const fact of durableCandidates) {
      if (durableAdded >= DURABLE_CAP_PER_ROOM) break;
      if (existing.has(fact)) continue;
      existing.add(fact);
      mem.durable.push({ text: fact, ts: Date.now(), src: 'backfill' });
      durableAdded++;
    }

    // Seed recent activity from session summaries if the room has none yet.
    let recentAdded = 0;
    if (!mem.recent.length && sess.length) {
      const recent = sess
        .filter((s) => s.summary)
        .slice(0, RECENT_SEED)
        .reverse()
        .map((s) => ({
          ts: Date.parse(s.updated_at || s.created_at) || Date.now(),
          summary: `[${(s.updated_at || s.created_at || '').slice(0, 10)}] ${firstSentence(s.summary, 120)}${s.nturns > 1 ? ` (${s.nturns} turns)` : ''}`,
        }));
      mem.recent = recent;
      recentAdded = recent.length;
    }

    mem.stats = mem.stats || { turns: 0, premiumRequests: 0 };
    mem.stats.backfilledSessions = sess.length;
    writeMemory(room.id, mem);

    if (sess.length || durableAdded) {
      report.push({ roomId: room.id, sessions: sess.length, durableAdded, recentAdded });
    }
  }

  return {
    totalSessions: sessions.length,
    automation,
    matched: report.reduce((a, r) => a + r.sessions, 0),
    rooms: report,
  };
}
