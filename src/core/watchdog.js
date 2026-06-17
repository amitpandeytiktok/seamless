// Fleet watchdog bridge: surfaces the latest entry from an external watchdog
// JSONL log (produced by the always-on worker box) inside the Seamless UI.
// Opt-in: set `watchdogLog` in ~/.seamless/config.json or the SEAMLESS_WATCHDOG_LOG
// env var to the path of the JSONL log. Each line looks like:
//   { ts, host, down, results: [{ name, url, ok, status, ms, ageMin? }] }
import fs from 'node:fs';
import { loadSettings } from './config.js';

const MAX_TAIL_BYTES = 65_536; // only ever read the tail; the log grows forever

export function watchdogLogPath() {
  return process.env.SEAMLESS_WATCHDOG_LOG || loadSettings().watchdogLog || '';
}

// Read the most recent parseable JSON object from the tail of the log.
export function readWatchdog() {
  const p = watchdogLogPath();
  if (!p) return { configured: false };

  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return { configured: true, error: 'log not found', path: p };
  }

  try {
    const readLen = Math.min(stat.size, MAX_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return { configured: true, ...JSON.parse(lines[i]) };
      } catch {
        /* partial/garbled line — keep scanning upward */
      }
    }
    return { configured: true, error: 'no parseable entry', path: p };
  } catch (e) {
    return { configured: true, error: String((e && e.message) || e), path: p };
  }
}
