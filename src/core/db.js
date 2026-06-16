// Safe, synchronous SQLite access. node:sqlite is only available on Node >= 22.5
// (stable in 24). Electron may bundle an older Node, so we load it via createRequire
// and degrade to "no DB" rather than crashing — the app still works from the
// per-session files (events.jsonl / workspace.yaml), which are the richer source.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let DatabaseSync = null;
export let sqliteAvailable = false;
try {
  ({ DatabaseSync } = require('node:sqlite'));
  sqliteAvailable = !!DatabaseSync;
} catch {
  sqliteAvailable = false;
}

// Run a read-only query and always return an array (never throw).
export function queryAll(dbPath, sql, params) {
  if (!sqliteAvailable) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(sql);
    return params ? stmt.all(...params) : stmt.all();
  } catch {
    return [];
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}
