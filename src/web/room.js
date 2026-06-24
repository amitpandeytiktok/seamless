// Room CLI front-end. Vanilla, dependency-free. Talks to /api/room/* with a bearer
// token, streams turns as NDJSON, and renders the per-room incremental console.
'use strict';

const BASE = location.pathname.replace(/\/$/, ''); // the hidden /<slug> prefix
const API = '/api/room';
let TOKEN = localStorage.getItem('roomcli_token') || '';
let ROOMS = [];
let TREE = [];
let CURRENT = null;
let STREAMING = false;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// Tiny markdown: bold, inline code, autolink. Newlines preserved via CSS.
function mdLite(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  return h;
}

async function api(path, { method = 'GET', body, stream = false } = {}) {
  const headers = { 'x-room-token': TOKEN };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showGate();
    throw new Error('unauthorized');
  }
  if (stream) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ---------------- PIN gate ---------------- */
function showGate() {
  $('#app').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  $('#pin').focus();
}
function hideGate() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

async function initGate() {
  let cfg = { needsSetup: false };
  try {
    cfg = await (await fetch(API + '/config')).json();
  } catch {}
  if (cfg.needsSetup) {
    $('#gate-sub').textContent = 'First run — set a PIN to lock your control room.';
    $('#gate-btn').textContent = 'Set PIN & enter';
    $('#gate-form').dataset.mode = 'setup';
  }
  if (TOKEN) {
    // Validate existing token by loading rooms.
    try {
      await loadRooms();
      hideGate();
      return;
    } catch {
      TOKEN = '';
      localStorage.removeItem('roomcli_token');
    }
  }
  showGate();
}

$('#gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pin').value.trim();
  const err = $('#gate-err');
  err.textContent = '';
  if (!pin) return;
  const setup = $('#gate-form').dataset.mode === 'setup';
  try {
    const r = await (await fetch(API + (setup ? '/auth/setup' : '/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin }),
    })).json();
    if (!r.token) throw new Error(r.error || 'invalid PIN');
    TOKEN = r.token;
    localStorage.setItem('roomcli_token', TOKEN);
    $('#pin').value = '';
    await loadRooms();
    hideGate();
  } catch (e2) {
    err.textContent = e2.message || 'failed';
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  TOKEN = '';
  localStorage.removeItem('roomcli_token');
  showGate();
});

/* ---------------- Rooms tree ---------------- */
async function loadRooms() {
  const data = await api('/rooms');
  ROOMS = data.rooms;
  TREE = data.tree;
  renderTree(TREE);
}

function renderTree(tree) {
  const root = $('#room-tree');
  root.innerHTML = '';
  const render = (nodes, container, depth) => {
    for (const n of nodes) {
      const item = document.createElement('div');
      item.className = 'room-item' + (CURRENT && CURRENT.id === n.id ? ' active' : '');
      item.dataset.id = n.id;
      item.innerHTML =
        `<span class="ricon">${esc(n.icon || '🗂️')}</span>` +
        `<span class="rname">${esc(n.name)}</span>` +
        (n.kind === 'group' ? `<span class="rbadge">group</span>` : `<span class="rbadge">${esc(n.permission)}</span>`);
      item.addEventListener('click', () => selectRoom(n.id));
      container.appendChild(item);
      if (n.children && n.children.length) {
        const kids = document.createElement('div');
        kids.className = 'room-children';
        container.appendChild(kids);
        render(n.children, kids, depth + 1);
      }
    }
  };
  render(tree, root, 0);
}

/* ---------------- Room detail + console ---------------- */
async function selectRoom(id) {
  if (STREAMING) { toast('Finish the running turn first.'); return; }
  const data = await api('/rooms/' + id);
  CURRENT = data.room;
  CURRENT._memory = data.memory;
  renderTree(TREE); // re-mark active using CURRENT

  $('#room-icon').textContent = CURRENT.icon || '🗂️';
  $('#room-name').textContent = CURRENT.name;
  $('#room-meta').innerHTML =
    `<span class="pill ${CURRENT.permission}">${esc(CURRENT.permission)}</span> ` +
    esc(CURRENT.resolvedCwd || CURRENT.cwd) +
    (CURRENT.model ? ` · ${esc(CURRENT.model)}` : '');
  $('#composer').classList.remove('hidden');

  renderConsoleFromLog(data.log || []);
  renderKnowledge(data.memory);
}

function renderConsoleFromLog(log) {
  const c = $('#console');
  c.innerHTML = '';
  if (!log.length) {
    c.innerHTML = `<div class="empty-state">Fresh room — but it already knows its history. Type your first instruction below.</div>`;
    return;
  }
  for (const entry of log) {
    addUserBubble(entry.prompt);
    const { bubble } = addAssistantTurn();
    bubble.innerHTML = mdLite(entry.response || '(no text response)');
    if (entry.sessionId || entry.usage) {
      addMetaLine(bubble.parentElement, entry);
    }
  }
  c.scrollTop = c.scrollHeight;
}

function addUserBubble(text) {
  const c = $('#console');
  const turn = document.createElement('div');
  turn.className = 'turn';
  const b = document.createElement('div');
  b.className = 'bubble user';
  b.textContent = text;
  turn.appendChild(b);
  c.appendChild(turn);
  c.scrollTop = c.scrollHeight;
  return turn;
}

function addAssistantTurn() {
  const c = $('#console');
  const turn = document.createElement('div');
  turn.className = 'turn';
  const tools = document.createElement('div');
  tools.className = 'tools';
  const bubble = document.createElement('div');
  bubble.className = 'bubble assistant';
  turn.appendChild(tools);
  turn.appendChild(bubble);
  c.appendChild(turn);
  c.scrollTop = c.scrollHeight;
  return { turn, tools, bubble };
}

function addMetaLine(turn, info) {
  const m = document.createElement('div');
  m.className = 'meta-line';
  const bits = [];
  if (info.sessionId) bits.push('session ' + String(info.sessionId).slice(0, 8));
  if (info.usage) {
    if (info.usage.premiumRequests != null) bits.push(info.usage.premiumRequests + ' premium reqs');
    const cc = info.usage.codeChanges;
    if (cc && (cc.linesAdded || cc.linesRemoved)) bits.push(`+${cc.linesAdded}/-${cc.linesRemoved}`);
    if (cc && cc.filesModified && cc.filesModified.length) bits.push(cc.filesModified.length + ' files');
  }
  if (info.memory && info.memory.length) bits.push(`<span class="mem">🧠 +${info.memory.length} memory</span>`);
  m.innerHTML = bits.join(' · ');
  turn.appendChild(m);
}

/* ---------------- Send a turn (streamed) ---------------- */
const composer = $('#composer');
const promptEl = $('#prompt');
promptEl.addEventListener('input', () => {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 180) + 'px';
});
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (STREAMING || !CURRENT) return;
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  promptEl.value = '';
  promptEl.style.height = 'auto';
  STREAMING = true;
  $('#send').disabled = true;

  addUserBubble(prompt);
  const { turn, tools, bubble } = addAssistantTurn();
  bubble.classList.add('cursor');
  let acc = '';
  const pendingTools = [];

  try {
    const res = await api('/rooms/' + CURRENT.id + '/run', { method: 'POST', body: { prompt }, stream: true });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handleEvent(ev, { turn, tools, bubble, get: () => acc, set: (v) => (acc = v), pendingTools });
      }
    }
  } catch (err) {
    bubble.innerHTML = `<span style="color:var(--bad)">${esc(err.message || 'turn failed')}</span>`;
  } finally {
    bubble.classList.remove('cursor');
    STREAMING = false;
    $('#send').disabled = false;
    promptEl.focus();
  }
});

function handleEvent(ev, ctx) {
  const c = $('#console');
  switch (ev.kind) {
    case 'assistant_delta':
      ctx.set(ctx.get() + ev.text);
      ctx.bubble.innerHTML = mdLite(ctx.get());
      c.scrollTop = c.scrollHeight;
      break;
    case 'assistant_message':
      // Capture pre-tool narration segments that weren't streamed as deltas.
      if (ev.text && !ctx.get().includes(ev.text.trim().slice(0, 40))) {
        ctx.set((ctx.get() ? ctx.get() + '\n\n' : '') + ev.text);
        ctx.bubble.innerHTML = mdLite(ctx.get());
      }
      break;
    case 'tool_start': {
      const line = document.createElement('div');
      line.className = 'tool';
      line.innerHTML = `<span class="tname">▶ ${esc(ev.name)}</span> ${esc(ev.summary || '')}`;
      ctx.tools.appendChild(line);
      ctx.pendingTools.push(line);
      c.scrollTop = c.scrollHeight;
      break;
    }
    case 'tool_done': {
      const line = ctx.pendingTools.shift();
      if (line) {
        line.classList.add(ev.success ? 'ok' : 'fail');
        line.innerHTML =
          `<span class="tname">${ev.success ? '✓' : '✕'} ${esc(ev.name)}</span> ` +
          `<span class="tstatus">${ev.success ? 'done' : 'failed'}</span>` +
          (ev.preview ? ` · ${esc(ev.preview)}` : '');
      }
      break;
    }
    case 'done':
      if (ev.response) ctx.bubble.innerHTML = mdLite(ev.response);
      else if (!ctx.get()) ctx.bubble.innerHTML = `<span style="color:var(--muted)">(no text — see tool activity above)</span>`;
      addMetaLine(ctx.turn, ev);
      // Refresh knowledge panel since memory may have grown.
      api('/rooms/' + CURRENT.id).then((d) => {
        CURRENT._memory = d.memory;
        renderKnowledge(d.memory);
      }).catch(() => {});
      break;
    case 'error':
      ctx.tools.insertAdjacentHTML('beforeend', `<div class="tool fail"><span class="tstatus">error</span> ${esc(ev.text)}</div>`);
      break;
    default:
      break;
  }
}

/* ---------------- Knowledge panel ---------------- */
function renderKnowledge(mem) {
  const body = $('#kpanel-body');
  if (!mem) { body.innerHTML = ''; return; }
  const facts = (mem.durable || [])
    .map((f, i) => `<div class="k-fact ${esc(f.src || '')}"><span class="ftext">${mdLite(f.text)}</span><span class="fx" data-i="${i}" title="forget">✕</span></div>`)
    .join('') || '<div class="k-recent">No durable facts yet.</div>';
  const recent = (mem.recent || []).slice().reverse()
    .map((r) => `<div>${esc(r.summary)}</div>`).join('') || '<div class="k-recent">No activity yet.</div>';
  const st = mem.stats || {};
  body.innerHTML =
    `<div class="k-section"><h4>Overview</h4><div class="k-overview">${esc(mem.overview || '—')}</div></div>` +
    `<div class="k-section"><h4>Durable knowledge (${(mem.durable || []).length})</h4>${facts}` +
      `<div class="k-add"><input id="k-add-input" placeholder="Add a fact to remember…"/><button class="btn ghost" id="k-add-btn">＋</button></div></div>` +
    `<div class="k-section"><h4>Recent activity</h4><div class="k-recent">${recent}</div></div>` +
    `<div class="k-section"><div class="k-stats">turns: ${st.turns || 0} · backfilled sessions: ${st.backfilledSessions || 0} · premium reqs: ${st.premiumRequests || 0}</div></div>`;

  $$('.k-fact .fx', body).forEach((x) =>
    x.addEventListener('click', async () => {
      const d = await api('/rooms/' + CURRENT.id + '/knowledge/' + x.dataset.i, { method: 'DELETE' });
      renderKnowledge(d.memory);
    })
  );
  const addBtn = $('#k-add-btn', body);
  const addInput = $('#k-add-input', body);
  const doAdd = async () => {
    const text = addInput.value.trim();
    if (!text) return;
    const d = await api('/rooms/' + CURRENT.id + '/knowledge', { method: 'POST', body: { text } });
    renderKnowledge(d.memory);
  };
  addBtn.addEventListener('click', doAdd);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
}

$('#btn-knowledge').addEventListener('click', () => {
  const open = $('#kpanel').classList.toggle('hidden');
  $('#app').classList.toggle('kopen', !open);
});
$('#kpanel-close').addEventListener('click', () => {
  $('#kpanel').classList.add('hidden');
  $('#app').classList.remove('kopen');
});

/* ---------------- Room create / edit modal ---------------- */
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal-close').addEventListener('click', closeModal);

function roomFormHtml(room) {
  const parents = ROOMS.filter((r) => !room || r.id !== room.id)
    .map((r) => `<option value="${esc(r.id)}" ${room && room.parentId === r.id ? 'selected' : ''}>${esc(r.icon)} ${esc(r.name)}</option>`).join('');
  const permOpts = ['agent', 'chat'].map((p) => `<option value="${p}" ${room && room.permission === p ? 'selected' : ''}>${p}</option>`).join('');
  const kindOpts = ['project', 'group', 'brainstorm', 'ops'].map((k) => `<option value="${k}" ${room && room.kind === k ? 'selected' : ''}>${k}</option>`).join('');
  return (
    `<div class="field"><label>Name</label><input id="f-name" value="${esc(room ? room.name : '')}" placeholder="My project"/></div>` +
    `<div class="field"><label>Icon</label><input id="f-icon" value="${esc(room ? room.icon : '🗂️')}" maxlength="4"/></div>` +
    `<div class="field"><label>Working directory (use ~ for home)</label><input id="f-cwd" value="${esc(room ? room.cwd : '~')}" placeholder="~/my-repo"/></div>` +
    `<div class="field"><label>Parent room</label><select id="f-parent"><option value="">— none (top level) —</option>${parents}</select></div>` +
    `<div class="field"><label>Permission</label><select id="f-perm">${permOpts}</select></div>` +
    `<div class="field"><label>Kind</label><select id="f-kind">${kindOpts}</select></div>` +
    `<div class="field"><label>Model (blank = default)</label><input id="f-model" value="${esc(room ? room.model : '')}" placeholder="auto / claude-opus-4.8 / gpt-5.5"/></div>` +
    `<div class="modal-foot">` +
      (room ? `<button class="btn ghost" id="f-delete" style="color:var(--bad)">Delete room</button>` : `<span></span>`) +
      `<button class="btn primary" id="f-save">${room ? 'Save' : 'Create room'}</button>` +
    `</div>`
  );
}

function readRoomForm() {
  return {
    name: $('#f-name').value.trim(),
    icon: $('#f-icon').value.trim() || '🗂️',
    cwd: $('#f-cwd').value.trim() || '~',
    parentId: $('#f-parent').value || null,
    permission: $('#f-perm').value,
    kind: $('#f-kind').value,
    model: $('#f-model').value.trim(),
  };
}

$('#btn-new-room').addEventListener('click', () => {
  $('#modal-title').textContent = 'New room';
  $('#modal-body').innerHTML = roomFormHtml(null);
  $('#modal').classList.remove('hidden');
  $('#f-save').addEventListener('click', async () => {
    const body = readRoomForm();
    if (!body.name) return toast('Name required');
    const { room } = await api('/rooms', { method: 'POST', body });
    closeModal();
    await loadRooms();
    selectRoom(room.id);
    toast('Room created');
  });
});

$('#btn-edit').addEventListener('click', () => {
  if (!CURRENT) return;
  $('#modal-title').textContent = 'Room settings · ' + CURRENT.name;
  $('#modal-body').innerHTML = roomFormHtml(CURRENT);
  $('#modal').classList.remove('hidden');
  $('#f-save').addEventListener('click', async () => {
    const body = readRoomForm();
    const { room } = await api('/rooms/' + CURRENT.id, { method: 'PATCH', body });
    closeModal();
    await loadRooms();
    selectRoom(room.id);
    toast('Saved');
  });
  $('#f-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete room "' + CURRENT.name + '"? Its on-disk knowledge folder is left intact.')) return;
    await api('/rooms/' + CURRENT.id, { method: 'DELETE' });
    closeModal();
    CURRENT = null;
    $('#composer').classList.add('hidden');
    $('#console').innerHTML = `<div class="empty-state">Room deleted. Pick another room.</div>`;
    $('#room-name').textContent = 'Select a room';
    $('#room-meta').textContent = '';
    await loadRooms();
    toast('Deleted');
  });
});

/* ---------------- Backfill ---------------- */
$('#btn-backfill').addEventListener('click', async () => {
  if (!confirm('Distil your past Copilot sessions on this machine into room knowledge?')) return;
  toast('Backfilling…', 8000);
  try {
    const { report } = await api('/backfill', { method: 'POST' });
    toast(`Backfilled ${report.matched} sessions across ${report.rooms.length} rooms.`);
    if (CURRENT) selectRoom(CURRENT.id);
  } catch (e) {
    toast('Backfill failed: ' + e.message);
  }
});

/* ---------------- boot ---------------- */
initGate();
