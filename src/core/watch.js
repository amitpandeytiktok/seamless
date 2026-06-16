// Watch the Copilot session-state tree and emit debounced change notifications.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { SESSION_STATE_DIR } from './config.js';

export function createWatcher({ debounceMs = 400 } = {}) {
  const emitter = new EventEmitter();
  let timer = null;
  const pending = new Set();
  let watcher = null;

  function flush() {
    const ids = [...pending];
    pending.clear();
    timer = null;
    emitter.emit('change', { ids });
  }

  function onChange(_eventType, filename) {
    if (!filename) {
      pending.add('*');
    } else {
      const first = String(filename).split(/[\\/]/)[0];
      if (first) pending.add(first);
    }
    if (!timer) timer = setTimeout(flush, debounceMs);
  }

  emitter.start = function start() {
    try {
      watcher = fs.watch(SESSION_STATE_DIR, { recursive: true }, onChange);
    } catch (e) {
      emitter.emit('error', e);
    }
    return emitter;
  };

  emitter.stop = function stop() {
    if (watcher) watcher.close();
    if (timer) clearTimeout(timer);
  };

  return emitter;
}
