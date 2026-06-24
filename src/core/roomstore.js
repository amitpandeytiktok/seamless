// Room CLI — room model and persistence.
// A "room" is a long-lived workspace: a working directory + a permission level +
// an accumulating, on-disk knowledge base. Rooms nest via parentId to form a tree
// (e.g. a "Workspace" group containing one room per repo). The tree lives in
// ~/.seamless/rooms.json; each room's knowledge lives under ~/.seamless/rooms/<id>/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SEAMLESS_DIR } from './config.js';

export const ROOMS_DIR = path.join(SEAMLESS_DIR, 'rooms');
export const ROOMS_FILE = path.join(SEAMLESS_DIR, 'rooms.json');

// Expand a stored "~/..." path against the current machine's home directory, so a
// room created on one machine (~/my-repo) resolves correctly on another (Windows) too.
export function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Permission presets translated into copilot CLI flags by the engine.
//   agent -> full power (edit/run/deploy); chat -> no file writes or shell (brainstorm/think).
export const PERMISSIONS = ['agent', 'chat'];

function nowIso() {
  return new Date().toISOString();
}

function slugify(name) {
  const base = String(name || 'room')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'room';
}

// Generic starter rooms shipped with the open-source project. They demonstrate the model
// (a nested group, a normal agent room, a tool-less "chat" room) WITHOUT any user-specific
// data. Your own rooms live in ~/.seamless/rooms.json (git-ignored) and, once that file
// exists, loadRooms() reads it and these defaults are never used. `seed.overview` /
// `seed.durable` prime a room's knowledge before backfill enriches it.
const DEFAULT_ROOMS = [
  {
    id: 'workspace', name: 'Workspace', parentId: null, icon: '🗂️',
    cwd: '~', kind: 'group', permission: 'agent',
    seed: {
      overview: 'Top-level group. Nest your projects under here (or create your own groups). '
        + 'Each room remembers its own history on disk and replays it as cheap context every turn.',
      durable: [],
    },
  },
  {
    id: 'example-project', name: 'Example Project', parentId: 'workspace', icon: '📦',
    cwd: '~/my-project', kind: 'project', permission: 'agent',
    seed: {
      overview: 'Example project room. Point its working directory at one of your repos '
        + '(edit the room and set the path), then run incremental Copilot turns here.',
      durable: [],
    },
  },
  {
    id: 'brainstorm', name: 'Brainstorm', parentId: null, icon: '💡',
    cwd: '~', kind: 'brainstorm', permission: 'chat',
    seed: {
      overview: 'Open thinking room — ideas, strategy, naming, architecture sketches. '
        + 'This room is tool-less (no shell / file edits); pure reasoning that accumulates into durable notes.',
      durable: [],
    },
  },
  {
    id: 'ops', name: 'Ops & Deploy', parentId: null, icon: '🚀',
    cwd: '~', kind: 'ops', permission: 'agent',
    seed: {
      overview: 'Cross-project operations: builds, deploys, DNS, secrets and other chores that '
        + 'span repos. Keep deploy commands and gotchas here as durable facts.',
      durable: [],
    },
  },
];

function ensureDirs() {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
}

function seedRoom(r) {
  const ts = nowIso();
  return {
    id: r.id,
    name: r.name,
    parentId: r.parentId ?? null,
    icon: r.icon || '🗂️',
    cwd: r.cwd || '~',
    kind: r.kind || 'project',
    permission: PERMISSIONS.includes(r.permission) ? r.permission : 'agent',
    model: r.model || '',
    seed: r.seed || { overview: '', durable: [] },
    createdAt: ts,
    updatedAt: ts,
  };
}

export function loadRooms() {
  ensureDirs();
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  } catch {
    data = null;
  }
  if (!data || !Array.isArray(data.rooms)) {
    data = { version: 1, rooms: DEFAULT_ROOMS.map(seedRoom) };
    saveRooms(data);
  }
  return data;
}

export function saveRooms(data) {
  ensureDirs();
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(data, null, 2));
  return data;
}

export function listRooms() {
  return loadRooms().rooms;
}

export function getRoom(id) {
  return listRooms().find((r) => r.id === id) || null;
}

// Resolve the working directory for a room, falling back to home if it doesn't exist
// on this machine (so a room still works for chat even without the repo cloned).
export function resolveCwd(room) {
  const want = expandHome(room?.cwd || '~');
  try {
    if (want && fs.existsSync(want) && fs.statSync(want).isDirectory()) return want;
  } catch {
    /* ignore */
  }
  return os.homedir();
}

export function createRoom({ name, parentId = null, icon, cwd, kind, permission, model }) {
  const data = loadRooms();
  let id = slugify(name);
  if (data.rooms.some((r) => r.id === id)) id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  if (parentId && !data.rooms.some((r) => r.id === parentId)) parentId = null;
  const room = seedRoom({
    id, name, parentId, icon, cwd, kind: kind || 'project',
    permission, model, seed: { overview: '', durable: [] },
  });
  data.rooms.push(room);
  saveRooms(data);
  return room;
}

export function updateRoom(id, patch = {}) {
  const data = loadRooms();
  const room = data.rooms.find((r) => r.id === id);
  if (!room) return null;
  const allowed = ['name', 'icon', 'cwd', 'kind', 'permission', 'model', 'parentId'];
  for (const k of allowed) {
    if (k in patch && patch[k] !== undefined) room[k] = patch[k];
  }
  if (room.permission && !PERMISSIONS.includes(room.permission)) room.permission = 'agent';
  if (room.parentId === id) room.parentId = null;
  room.updatedAt = nowIso();
  saveRooms(data);
  return room;
}

export function deleteRoom(id) {
  const data = loadRooms();
  const idx = data.rooms.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  // Re-parent children to the deleted room's parent so the tree stays intact.
  const parentId = data.rooms[idx].parentId ?? null;
  for (const r of data.rooms) if (r.parentId === id) r.parentId = parentId;
  data.rooms.splice(idx, 1);
  saveRooms(data);
  return true;
}

// Build a nested tree for the UI sidebar.
export function roomTree() {
  const rooms = listRooms();
  const byParent = new Map();
  for (const r of rooms) {
    const key = r.parentId ?? '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(r);
  }
  const build = (key) =>
    (byParent.get(key) || []).map((r) => ({ ...r, children: build(r.id) }));
  return build('__root__');
}
