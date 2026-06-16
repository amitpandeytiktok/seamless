// Small dependency-free helpers shared across Seamless core modules.

// Minimal parser for the flat key: value workspace.yaml files Copilot writes.
// Handles strings, quoted strings, booleans, numbers, and null. No nesting needed.
export function parseSimpleYaml(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val === '') {
      out[key] = '';
      continue;
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      out[key] = val.slice(1, -1);
      continue;
    }
    if (val === 'true') out[key] = true;
    else if (val === 'false') out[key] = false;
    else if (val === 'null' || val === '~') out[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(val)) out[key] = Number(val);
    else out[key] = val;
  }
  return out;
}

export function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function pct(n, d) {
  if (!d) return 0;
  return clamp(n / d, 0, 1);
}

// Rough token estimate from character count. ratio = characters per token.
export function estimateTokens(chars, ratio = 4) {
  if (!ratio || ratio <= 0) ratio = 4;
  return Math.round(chars / ratio);
}

export function formatNumber(n) {
  if (n == null || Number.isNaN(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}

export function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return '–';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100_000 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

export function formatBytes(bytes) {
  if (bytes == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export function timeAgo(date) {
  if (!date) return 'never';
  const t = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const diff = Date.now() - t.getTime();
  if (Number.isNaN(diff)) return 'unknown';
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
