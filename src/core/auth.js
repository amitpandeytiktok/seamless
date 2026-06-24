// Room CLI — auth: a single PIN gate plus an unguessable hidden URL slug. The slug
// provides obscurity; the PIN provides real authentication. State lives in
// ~/.seamless/roomcli.json. PINs are scrypt-hashed; tokens are random + expiring.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SEAMLESS_DIR } from './config.js';

const AUTH_FILE = path.join(SEAMLESS_DIR, 'roomcli.json');
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Optional hardcoded PIN supplied by the deployment (e.g. set in the Windows
// task wrapper as ROOMCLI_ROOT_HOSTS' sibling). When a valid 8-digit value is
// present it becomes THE PIN: no first-run setup, and it can never be wiped by a
// file write. Keeps the secret out of source control (lives only in the env).
const ENV_PIN = String(process.env.ROOMCLI_PIN || '').trim();
const ENV_PIN_OK = /^\d{8}$/.test(ENV_PIN);

// Session tokens live in memory, not on disk. Persisting them meant every login
// and token check did a read-modify-write of roomcli.json; under a busy session
// those racing writes clobbered each other, silently dropping the active token
// (surprise logout) and even the pinHash (surprise "set up again"). An in-process
// Map is race-free; the only cost is that tokens don't survive a server restart.
const TOKENS = new Map(); // token -> expiry epoch ms

function load() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(state) {
  fs.mkdirSync(SEAMLESS_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}

// Lazily ensure a hidden slug exists; created on first server start.
export function getSlug() {
  const state = load();
  if (!state.slug) {
    state.slug = crypto.randomBytes(9).toString('base64url'); // ~12 url-safe chars
    save(state);
  }
  return state.slug;
}

export function hasPin() {
  return ENV_PIN_OK || !!load().pinHash;
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

// First-run PIN setup (exactly 8 digits). Returns false if a PIN already exists
// (either a hardcoded ROOMCLI_PIN or one previously stored on disk).
export function setPin(pin) {
  if (ENV_PIN_OK) return false;
  if (!/^\d{8}$/.test(String(pin))) {
    throw new Error('PIN must be exactly 8 digits');
  }
  const state = load();
  if (state.pinHash) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  state.pinSalt = salt;
  state.pinHash = hashPin(pin, salt);
  save(state);
  return true;
}

export function verifyPin(pin) {
  if (ENV_PIN_OK) {
    const got = Buffer.from(String(pin));
    const want = Buffer.from(ENV_PIN);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  const state = load();
  if (!state.pinHash || !state.pinSalt) return false;
  const got = Buffer.from(hashPin(pin, state.pinSalt), 'hex');
  const want = Buffer.from(state.pinHash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Online brute-force throttle: after several bad PINs, briefly lock logins.
// An 8-digit PIN is 100M combinations; this makes online guessing infeasible.
const LOCK = { fails: 0, until: 0 };
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

export function loginLocked() {
  return Date.now() < LOCK.until;
}

// Exchange a valid PIN for a bearer token (held in memory).
export function login(pin) {
  if (Date.now() < LOCK.until) return null;
  if (!verifyPin(pin)) {
    LOCK.fails += 1;
    if (LOCK.fails >= MAX_FAILS) {
      LOCK.until = Date.now() + LOCK_MS;
      LOCK.fails = 0;
    }
    return null;
  }
  LOCK.fails = 0;
  LOCK.until = 0;
  const token = crypto.randomBytes(24).toString('base64url');
  TOKENS.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function checkToken(token) {
  if (!token) return false;
  const exp = TOKENS.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    TOKENS.delete(token);
    return false;
  }
  return true;
}

export function logout(token) {
  TOKENS.delete(token);
}

// Pull a bearer token from a request: Authorization header, x-room-token header,
// or a ?t= query param (needed for EventSource, which can't set headers).
export function tokenFromReq(req, url) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.headers['x-room-token']) return String(req.headers['x-room-token']);
  if (url && url.searchParams.get('t')) return url.searchParams.get('t');
  return null;
}
