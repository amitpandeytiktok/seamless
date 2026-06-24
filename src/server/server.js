// Seamless local server: REST API + Server-Sent Events live stream + static
// dashboard. Dependency-free (node:http). Also usable standalone via `npm run server`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings, readCopilotSettings } from '../core/config.js';
import { listSessions, getSession } from '../core/sessions.js';
import { gitInfo } from '../core/git.js';
import { recommend } from '../core/analyze.js';
import * as actions from '../core/actions.js';
import { createWatcher } from '../core/watch.js';
import { readWatchdog } from '../core/watchdog.js';
import { handleRoomApi, serveRoomUi, initRoomCli } from '../core/roomapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

// Hosts on which ONLY the PIN-gated Room CLI is exposed (the unauthenticated
// dashboard + its APIs stay private to the LAN). Comma-separated, set per-deploy
// e.g. ROOMCLI_ROOT_HOSTS=cli.example.com. Empty = behave as a normal LAN dashboard.
const ROOT_HOSTS = (process.env.ROOMCLI_ROOT_HOSTS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, 404, { error: 'not found' });
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  if (!filePath.startsWith(WEB_DIR)) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// Build the full detail payload for one session (analysis + git + recommendations).
function buildDetail(id) {
  const session = getSession(id);
  if (!session) return null;
  const git = gitInfo(session.cwd);
  const recommendations = recommend(session.analysis, git);
  return { ...session, git, recommendations };
}

function resolveActiveId() {
  const list = listSessions();
  return list[0]?.id || null;
}

const sseClients = new Set();

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  // GET /api/sessions
  if (method === 'GET' && pathname === '/api/sessions') {
    return sendJson(res, 200, { sessions: listSessions(), now: Date.now() });
  }

  // GET /api/active  -> detail of the live / most-recent session
  if (method === 'GET' && pathname === '/api/active') {
    const id = resolveActiveId();
    if (!id) return sendJson(res, 200, { session: null });
    return sendJson(res, 200, { session: buildDetail(id), now: Date.now() });
  }

  // GET /api/sessions/:id
  const m = pathname.match(/^\/api\/sessions\/([0-9a-fA-F-]{36})$/);
  if (method === 'GET' && m) {
    const detail = buildDetail(m[1]);
    if (!detail) return notFound(res);
    return sendJson(res, 200, { session: detail, now: Date.now() });
  }

  // GET /api/watchdog  -> latest fleet health from the worker box's JSONL log
  if (method === 'GET' && pathname === '/api/watchdog') {
    return sendJson(res, 200, { ...readWatchdog(), now: Date.now() });
  }

  // GET/POST /api/settings
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      return sendJson(res, 200, { settings: loadSettings(), copilot: readCopilotSettings() });
    }
    if (method === 'POST') {
      return readBody(req).then((body) => sendJson(res, 200, { settings: saveSettings(body) }));
    }
  }

  // POST /api/actions/*
  if (method === 'POST' && pathname.startsWith('/api/actions/')) {
    const action = pathname.slice('/api/actions/'.length);
    return readBody(req).then((body) => {
      try {
        let ok = false;
        switch (action) {
          case 'resume':
            ok = actions.resumeSession(body.id, body.cwd);
            break;
          case 'new':
            ok = actions.newSession(body.cwd, body.name);
            break;
          case 'terminal':
            ok = actions.openTerminal(body.cwd);
            break;
          case 'open':
            ok = actions.openInExplorer(body.path);
            break;
          case 'open-external':
            ok = actions.openExternal(body.target);
            break;
          default:
            return notFound(res);
        }
        return sendJson(res, 200, { ok });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    });
  }

  // GET /api/stream  (SSE)
  if (method === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      } catch {
        clearInterval(hb);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return;
  }

  return notFound(res);
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return notFound(res);
    }
    // Room CLI: hidden, PIN-gated control room (API + its own UI at /<slug>).
    if (url.pathname.startsWith('/api/room/')) {
      try {
        await handleRoomApi(req, res, url);
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
        else try { res.end(); } catch { /* ignore */ }
      }
      return;
    }
    if (serveRoomUi(req, res, url)) return;

    // On a configured public host, expose ONLY the Room CLI. The Seamless
    // dashboard and its unauthenticated APIs (session list, cwds, summaries)
    // must never be reachable from the internet — keep them LAN-only.
    const hostName = (req.headers.host || '').split(':')[0].toLowerCase();
    if (ROOT_HOSTS.length && ROOT_HOSTS.includes(hostName)) {
      if (url.pathname.startsWith('/api/')) return notFound(res);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveStatic(req, res, '/room.html');
      }
      return serveStatic(req, res, url.pathname);
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  });

  const watcher = createWatcher({ debounceMs: 500 });
  watcher.on('change', ({ ids }) => {
    broadcast('change', { ids, activeId: resolveActiveId(), now: Date.now() });
  });
  watcher.start();

  return { server, watcher, broadcast };
}

export function start() {
  const settings = loadSettings();
  const room = initRoomCli();
  const { server } = createServer();
  server.listen(settings.port, settings.host, () => {
    const host = settings.host === '0.0.0.0' ? 'localhost' : settings.host;
    // eslint-disable-next-line no-console
    console.log(`Seamless server: http://${host}:${settings.port}`);
    // eslint-disable-next-line no-console
    console.log(`Room CLI (hidden, PIN-gated): http://${host}:${settings.port}/${room.slug}`);
    if (ROOT_HOSTS.length) {
      // eslint-disable-next-line no-console
      console.log(`Room CLI public host(s) (root = Room CLI, dashboard blocked): ${ROOT_HOSTS.join(', ')}`);
    }
    if (settings.host === '0.0.0.0') {
      // eslint-disable-next-line no-console
      console.log('(LAN-exposed: reachable from other devices on this network)');
    }
  });
  return server;
}

// Run directly: `node src/server/server.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start();
}
