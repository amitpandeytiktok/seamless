// Seamless core configuration: paths, model/context constants, and user-overridable settings.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const COPILOT_DIR = path.join(HOME, '.copilot');
export const SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');
export const GLOBAL_DB = path.join(COPILOT_DIR, 'session-store.db');
export const SETTINGS_FILE = path.join(COPILOT_DIR, 'settings.json');
export const CONFIG_FILE = path.join(COPILOT_DIR, 'config.json');

export const SEAMLESS_DIR = path.join(HOME, '.seamless');
export const SEAMLESS_CONFIG = path.join(SEAMLESS_DIR, 'config.json');

// Approximate usable context windows (tokens) by model id. The CLI auto-compacts
// before fully filling the window (observed ~160-171k for a 200k window).
export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const LONG_CONTEXT_LIMIT = 1_000_000;
export const MODEL_CONTEXT_LIMITS = {
  'claude-opus-4.8': 200_000,
  'claude-opus-4.6': 200_000,
  'claude-opus-4.5': 200_000,
  'claude-sonnet-4.6': 200_000,
  'claude-sonnet-4.5': 200_000,
  'claude-haiku-4.5': 200_000,
  'gpt-5.5': 256_000,
  'gpt-5.3-codex': 256_000,
  'gemini-3.1-pro-preview': 1_000_000,
};

// Fullness thresholds (fraction of the limit) used for warnings + colour bands.
export const THRESHOLDS = { warn: 0.70, danger: 0.85 };

// Baselines used only before the first exact measurement exists in a session.
export const BASELINE_SYSTEM_TOKENS = 13_500;
export const BASELINE_TOOLDEF_TOKENS = 16_000;

const DEFAULT_SETTINGS = {
  port: 4321,
  host: '127.0.0.1', // set to '0.0.0.0' to expose the dashboard on the LAN
  gitPath: '', // explicit path to git.exe if not on PATH
  terminal: 'auto', // auto | pwsh | powershell | cmd
  contextLimitOverride: 0, // >0 to force a context window size
  openBrowserOnStart: false,
};

export function loadSettings() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(SEAMLESS_CONFIG, 'utf8'));
  } catch {
    /* no user config yet */
  }
  return { ...DEFAULT_SETTINGS, ...user };
}

export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...partial };
  fs.mkdirSync(SEAMLESS_DIR, { recursive: true });
  fs.writeFileSync(SEAMLESS_CONFIG, JSON.stringify(merged, null, 2));
  return merged;
}

// Read the user's active model/effort from ~/.copilot/settings.json (best effort).
export function readCopilotSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function contextLimitFor(model, tier) {
  const settings = loadSettings();
  if (settings.contextLimitOverride > 0) return settings.contextLimitOverride;
  if (tier === 'long_context') return LONG_CONTEXT_LIMIT;
  return MODEL_CONTEXT_LIMITS[model] || DEFAULT_CONTEXT_LIMIT;
}
