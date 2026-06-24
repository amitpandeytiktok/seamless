// Room CLI — auth: a single PIN gate plus an unguessable hidden URL slug. The slug
// provides obscurity; the PIN provides real authentication. State lives in
// ~/.seamless/roomcli.json. PINs are scrypt-hashed; tokens are random + expiring.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SEAMLESS_DIR } from './config.js';

const AUTH_FILE = path.join(SEAMLESS_DIR, 'roomcli.json');
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  return !!load().pinHash;
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

// First-run PIN setup (4–12 digits/chars). Returns false if a PIN already exists.
export function setPin(pin) {
  if (!pin || String(pin).length < 4 || String(pin).length > 64) {
    throw new Error('PIN must be 4–64 characters');
  }
  const state = load();
  if (state.pinHash) return false;
  const salt = crypto.randomBytes(16).toString('hex');
  state.pinSalt = salt;
  state.pinHash = hashPin(pin, salt);
  state.tokens = state.tokens || {};
  save(state);
  return true;
}

export function verifyPin(pin) {
  const state = load();
  if (!state.pinHash || !state.pinSalt) return false;
  const got = Buffer.from(hashPin(pin, state.pinSalt), 'hex');
  const want = Buffer.from(state.pinHash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function purgeExpired(state) {
  const now = Date.now();
  let changed = false;
  for (const [tok, exp] of Object.entries(state.tokens || {})) {
    if (exp < now) {
      delete state.tokens[tok];
      changed = true;
    }
  }
  return changed;
}

// Exchange a valid PIN for a bearer token.
export function login(pin) {
  if (!verifyPin(pin)) return null;
  const state = load();
  state.tokens = state.tokens || {};
  purgeExpired(state);
  const token = crypto.randomBytes(24).toString('base64url');
  state.tokens[token] = Date.now() + TOKEN_TTL_MS;
  save(state);
  return token;
}

export function checkToken(token) {
  if (!token) return false;
  const state = load();
  const exp = state.tokens?.[token];
  if (!exp) return false;
  if (exp < Date.now()) {
    delete state.tokens[token];
    save(state);
    return false;
  }
  return true;
}

export function logout(token) {
  const state = load();
  if (state.tokens?.[token]) {
    delete state.tokens[token];
    save(state);
  }
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
