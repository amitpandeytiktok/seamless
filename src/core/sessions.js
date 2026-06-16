// Discover Copilot sessions by merging the global session-store.db with the
// per-session state folders, and assemble full per-session detail on demand.
import fs from 'node:fs';
import path from 'node:path';
import { GLOBAL_DB, SESSION_STATE_DIR } from './config.js';
import { queryAll } from './db.js';
import { parseSimpleYaml } from './util.js';
import { analyzeSession } from './events.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function sessionDir(id) {
  return path.join(SESSION_STATE_DIR, id);
}

function readGlobalSessions() {
  const rows = {};
  const list = queryAll(
    GLOBAL_DB,
    'SELECT id, cwd, repository, host_type, branch, summary, created_at, updated_at FROM sessions'
  );
  for (const r of list) rows[r.id] = r;
  return rows;
}

function readWorkspace(id) {
  try {
    return parseSimpleYaml(fs.readFileSync(path.join(sessionDir(id), 'workspace.yaml'), 'utf8'));
  } catch {
    return null;
  }
}

function scanSessionDirs() {
  try {
    return fs
      .readdirSync(SESSION_STATE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && UUID_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Lightweight liveness probe without parsing the whole events file: use mtime.
function quickStat(id) {
  try {
    const st = fs.statSync(path.join(sessionDir(id), 'events.jsonl'));
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export function listSessions({ analyze = true } = {}) {
  const dbRows = readGlobalSessions();
  const ids = new Set([...Object.keys(dbRows), ...scanSessionDirs()]);
  const out = [];

  for (const id of ids) {
    const db = dbRows[id] || {};
    const ws = readWorkspace(id);
    const stat = quickStat(id);
    const base = {
      id,
      cwd: ws?.cwd || db.cwd || null,
      name: ws?.name || db.summary || null,
      summary: db.summary || null,
      repository: db.repository || null,
      branch: db.branch || null,
      clientName: ws?.client_name || null,
      createdAt: ws?.created_at || db.created_at || null,
      updatedAt: ws?.updated_at || db.updated_at || null,
      hasState: !!stat,
      eventsFileSizeBytes: stat?.size ?? null,
      remoteSteerable: ws?.remote_steerable ?? false,
    };

    if (analyze && stat) {
      const an = analyzeSession(sessionDir(id), id);
      if (an) {
        base.model = an.model;
        base.reasoningEffort = an.reasoningEffort;
        base.live = an.live;
        base.recentlyActive = an.recentlyActive;
        base.ended = !!an.endedAt;
        base.lastEventAt = an.lastEventAt;
        base.idleMs = an.idleMs;
        base.eventCount = an.eventCount;
        base.context = {
          total: an.context.total,
          limit: an.context.limit,
          fraction: an.context.fraction,
          exact: an.context.exact,
          source: an.context.source,
        };
        base.compactionCount = an.compactions.length;
        base.copilotVersion = an.copilotVersion;
      }
    }
    out.push(base);
  }

  out.sort((a, b) => {
    if (!!b.live - !!a.live) return !!b.live - !!a.live;
    const ta = a.lastEventAt || Date.parse(a.updatedAt || 0) || 0;
    const tb = b.lastEventAt || Date.parse(b.updatedAt || 0) || 0;
    return tb - ta;
  });
  return out;
}

function readTodos(id) {
  const dbPath = path.join(sessionDir(id), 'session.db');
  if (!fs.existsSync(dbPath)) return [];
  return queryAll(
    dbPath,
    'SELECT id, title, description, status, created_at, updated_at FROM todos ORDER BY rowid'
  );
}

function readCheckpoints(id) {
  const dir = path.join(sessionDir(id), 'checkpoints');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'index.md')
      .sort()
      .map((f) => ({ file: f, title: f.replace(/^\d+-/, '').replace(/\.md$/, '').replace(/-/g, ' ') }));
  } catch {
    return [];
  }
}

function readArtifacts(id) {
  const dir = path.join(sessionDir(id), 'files');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        let size = null;
        try {
          size = fs.statSync(path.join(dir, e.name)).size;
        } catch {}
        return { name: e.name, size };
      });
  } catch {
    return [];
  }
}

export function getSession(id) {
  if (!UUID_RE.test(id)) return null;
  const dir = sessionDir(id);
  if (!fs.existsSync(dir)) return null;
  const dbRows = readGlobalSessions();
  const db = dbRows[id] || {};
  const ws = readWorkspace(id);
  const analysis = analyzeSession(dir, id);

  return {
    id,
    dir,
    cwd: ws?.cwd || analysis?.cwd || db.cwd || null,
    name: ws?.name || db.summary || null,
    summary: db.summary || null,
    repository: db.repository || null,
    branchRecorded: db.branch || null,
    clientName: ws?.client_name || null,
    userNamed: ws?.user_named ?? false,
    createdAt: ws?.created_at || db.created_at || null,
    updatedAt: ws?.updated_at || db.updated_at || null,
    remoteSteerable: ws?.remote_steerable ?? false,
    mcTaskId: ws?.mc_task_id || null,
    mcSessionId: ws?.mc_session_id || null,
    analysis,
    todos: readTodos(id),
    checkpoints: readCheckpoints(id),
    artifacts: readArtifacts(id),
  };
}
