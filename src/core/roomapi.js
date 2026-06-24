// Room CLI — HTTP API + hidden UI serving, mounted into the Seamless server.
// Everything here lives under /api/room/* (token-gated) and the hidden /<slug> UI path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import {
  loadRooms, listRooms, getRoom, roomTree, createRoom, updateRoom, deleteRoom, resolveCwd, PERMISSIONS,
} from './roomstore.js';
import {
  ensureSeed, readMemory, readLog, recordTurn, addDurable, removeDurable,
} from './knowledge.js';
import { runTurn } from './engine.js';
import { runBackfill } from './backfill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
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

// One-time init: ensure rooms exist, every room's knowledge is seeded, and a slug exists.
export function initRoomCli() {
  const data = loadRooms();
  for (const r of data.rooms) ensureSeed(r);
  return { slug: auth.getSlug(), rooms: data.rooms.length };
}

// Serve the hidden Room CLI UI for any /<slug>... path. Returns true if it handled the req.
export function serveRoomUi(req, res, url) {
  const slug = auth.getSlug();
  const prefix = `/${slug}`;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  // Redirect the bare slug to a trailing slash so relative assets resolve under /<slug>/.
  if (url.pathname === prefix) {
    res.writeHead(302, { location: prefix + '/' });
    res.end();
    return true;
  }
  let rel = url.pathname.slice(prefix.length) || '/';
  if (rel === '/' || rel === '') rel = '/room.html';
  rel = rel.split('?')[0];
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) {
    sendJson(res, 404, { error: 'not found' });
    return true;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown sub-path under the slug → serve the SPA shell.
      fs.readFile(path.join(WEB_DIR, 'room.html'), (e2, shell) => {
        if (e2) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(shell);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
  return true;
}

function authed(req, url) {
  return auth.checkToken(auth.tokenFromReq(req, url));
}

// Handle /api/room/*. Returns true if it owns the route (response written), false otherwise.
export async function handleRoomApi(req, res, url) {
  const { pathname } = url;
  if (!pathname.startsWith('/api/room/')) return false;
  const rest = pathname.slice('/api/room/'.length);
  const method = req.method;

  // --- public auth endpoints ---
  if (rest === 'config' && method === 'GET') {
    sendJson(res, 200, { needsSetup: !auth.hasPin() });
    return true;
  }
  if (rest === 'auth/setup' && method === 'POST') {
    const body = await readBody(req);
    try {
      const created = auth.setPin(body.pin);
      if (!created) return sendJson(res, 409, { error: 'PIN already set' });
      const token = auth.login(body.pin);
      sendJson(res, 200, { token });
    } catch (e) {
      sendJson(res, 400, { error: String(e.message || e) });
    }
    return true;
  }
  if (rest === 'auth/login' && method === 'POST') {
    const body = await readBody(req);
    const token = auth.login(body.pin);
    if (!token) return sendJson(res, 401, { error: 'invalid PIN' });
    sendJson(res, 200, { token });
    return true;
  }

  // --- everything below requires a valid token ---
  if (!authed(req, url)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (rest === 'auth/logout' && method === 'POST') {
    auth.logout(auth.tokenFromReq(req, url));
    sendJson(res, 200, { ok: true });
    return true;
  }

  // GET /api/room/rooms  -> tree + flat
  if (rest === 'rooms' && method === 'GET') {
    sendJson(res, 200, { tree: roomTree(), rooms: listRooms(), permissions: PERMISSIONS });
    return true;
  }
  // POST /api/room/rooms -> create
  if (rest === 'rooms' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendJson(res, 400, { error: 'name required' });
    const room = createRoom(body);
    ensureSeed(room);
    sendJson(res, 200, { room });
    return true;
  }
  // POST /api/room/backfill -> distil session store into rooms
  if (rest === 'backfill' && method === 'POST') {
    try {
      const report = runBackfill();
      sendJson(res, 200, { ok: true, report });
    } catch (e) {
      sendJson(res, 500, { error: String(e.message || e) });
    }
    return true;
  }

  // /api/room/rooms/:id ...
  const parts = rest.split('/');
  if (parts[0] === 'rooms' && parts[1]) {
    const id = parts[1];
    if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'bad id' });
    const room = getRoom(id);
    if (!room) return sendJson(res, 404, { error: 'no such room' });
    const sub = parts[2];

    // GET detail
    if (!sub && method === 'GET') {
      sendJson(res, 200, {
        room: { ...room, resolvedCwd: resolveCwd(room) },
        memory: readMemory(id),
        log: readLog(id, 40),
      });
      return true;
    }
    // PATCH/POST update
    if (!sub && (method === 'PATCH' || method === 'POST')) {
      const body = await readBody(req);
      const updated = updateRoom(id, body);
      sendJson(res, 200, { room: updated });
      return true;
    }
    // DELETE room
    if (!sub && method === 'DELETE') {
      sendJson(res, 200, { ok: deleteRoom(id) });
      return true;
    }
    // GET full log
    if (sub === 'log' && method === 'GET') {
      sendJson(res, 200, { log: readLog(id, 200) });
      return true;
    }
    // POST knowledge (add durable fact)
    if (sub === 'knowledge' && method === 'POST') {
      const body = await readBody(req);
      const mem = addDurable(id, body.text || '');
      sendJson(res, 200, { memory: mem });
      return true;
    }
    // DELETE knowledge/:index
    if (sub === 'knowledge' && parts[3] != null && method === 'DELETE') {
      const mem = removeDurable(id, Number(parts[3]));
      sendJson(res, 200, { memory: mem });
      return true;
    }
    // POST run -> stream a turn as NDJSON
    if (sub === 'run' && method === 'POST') {
      const body = await readBody(req);
      const prompt = (body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt required' });
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });
      const write = (o) => {
        try {
          res.write(JSON.stringify(o) + '\n');
        } catch {
          /* client gone */
        }
      };
      write({ kind: 'started', room: room.id, cwd: resolveCwd(room), permission: room.permission });
      let result;
      try {
        result = await runTurn(room, prompt, { onEvent: write });
      } catch (e) {
        write({ kind: 'error', text: String(e.message || e) });
        result = { ok: false, response: '', memory: [], sessionId: null, usage: null };
      }
      recordTurn(room, { ...result, prompt });
      write({
        kind: 'done',
        ok: result.ok,
        response: result.response,
        memory: result.memory,
        sessionId: result.sessionId,
        usage: result.usage,
      });
      res.end();
      return true;
    }
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
}
