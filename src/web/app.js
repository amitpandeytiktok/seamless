'use strict';
// Seamless dashboard — vanilla JS. Renders the live session control room and
// keeps it current via Server-Sent Events.

const state = {
  sessions: [],
  selectedId: null,
  activeId: null,
  pinnedToActive: true, // follow the live session unless the user picks another
  settings: {},
};

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));

function fmtTok(n) {
  if (n == null || isNaN(n)) return '–';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
function fmtNum(n) {
  if (n == null || isNaN(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}
function fmtBytes(b) {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return b.toFixed(b < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}
function fmtDur(ms) {
  if (ms == null || isNaN(ms)) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
function ago(ts) {
  if (!ts) return 'never';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (isNaN(t)) return '—';
  let s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function baseName(p) {
  if (!p) return '';
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}
function ctxColor(f) {
  if (f >= 0.85) return 'var(--danger)';
  if (f >= 0.7) return 'var(--warn)';
  if (f >= 0.45) return 'var(--accent)';
  return 'var(--good)';
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function postAction(action, body) {
  try {
    const r = await fetch('/api/actions/' + action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'failed');
    toast('Done');
  } catch (e) {
    toast(String(e.message || e), true);
  }
}

let toastTimer;
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}
function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('Copied'),
    () => {}
  );
}

/* ---------- data loading ---------- */
async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  const active = sessions.find((s) => s.live) || sessions[0];
  state.activeId = active ? active.id : null;
  if (state.pinnedToActive && state.activeId) state.selectedId = state.activeId;
  if (!state.selectedId && sessions[0]) state.selectedId = sessions[0].id;
  renderSidebar();
  await loadDetail();
}

async function loadDetail() {
  if (!state.selectedId) {
    $('#detail').innerHTML = '<div class="empty">No sessions found.</div>';
    return;
  }
  try {
    const { session } = await api('/api/sessions/' + state.selectedId);
    renderDetail(session);
  } catch (e) {
    $('#detail').innerHTML = '<div class="empty">Could not load session.</div>';
  }
}

/* ---------- sidebar ---------- */
function renderSidebar() {
  $('#session-count').textContent = state.sessions.length + ' total';
  const list = $('#session-list');
  list.innerHTML = state.sessions
    .map((s) => {
      const f = s.context ? s.context.fraction || 0 : 0;
      const cls = s.live ? 'live' : s.recentlyActive ? 'idle' : 'ended';
      const status = s.live ? 'LIVE' : s.recentlyActive ? 'recent' : 'ended';
      return `<div class="s-card ${s.id === state.selectedId ? 'active' : ''}" data-id="${s.id}">
        <div class="s-top">
          <span class="dot ${cls}"></span>
          <span class="s-name">${esc(s.name || baseName(s.cwd) || s.id.slice(0, 8))}</span>
          <span class="muted" style="font-size:10px">${status}</span>
        </div>
        <div class="s-meta">${esc(s.model || '–')} · ${esc(baseName(s.cwd) || 'no cwd')} · ${
        s.compactionCount ? s.compactionCount + '× compact · ' : ''
      }${fmtTok(s.context?.total)} tok</div>
        <div class="s-mini"><i style="width:${Math.round(f * 100)}%;background:${ctxColor(f)}"></i></div>
      </div>`;
    })
    .join('');
  list.querySelectorAll('.s-card').forEach((el) =>
    el.addEventListener('click', () => {
      state.selectedId = el.dataset.id;
      state.pinnedToActive = el.dataset.id === state.activeId;
      renderSidebar();
      loadDetail();
    })
  );
}

/* ---------- detail ---------- */
function gauge(ctx) {
  const f = ctx.fraction || 0;
  const r = 64;
  const c = 2 * Math.PI * r;
  const off = c * (1 - f);
  const col = ctxColor(f);
  return `<div class="gauge">
    <svg width="150" height="150" viewBox="0 0 150 150">
      <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--bg-3)" stroke-width="13"/>
      <circle cx="75" cy="75" r="${r}" fill="none" stroke="${col}" stroke-width="13"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
    </svg>
    <div class="g-center">
      <div class="g-pct" style="color:${col}">${Math.round(f * 100)}%</div>
      <div class="g-tok">${fmtTok(ctx.total)} / ${fmtTok(ctx.limit)}</div>
    </div>
  </div>`;
}

function breakdown(ctx) {
  const tot = ctx.total || 1;
  const seg = (v) => Math.max(0, (v / tot) * 100);
  return `<div class="stack">
      <i class="seg-sys" style="width:${seg(ctx.system)}%"></i>
      <i class="seg-tool" style="width:${seg(ctx.toolDefinitions)}%"></i>
      <i class="seg-conv" style="width:${seg(ctx.conversation)}%"></i>
    </div>
    <div class="legend">
      <span><i class="seg-sys"></i>System ${fmtTok(ctx.system)}</span>
      <span><i class="seg-tool"></i>Tool defs ${fmtTok(ctx.toolDefinitions)}</span>
      <span><i class="seg-conv"></i>Conversation ${fmtTok(ctx.conversation)}</span>
    </div>`;
}

function recIcon(level) {
  return { danger: '!', warn: '▲', info: 'i', good: '✓' }[level] || 'i';
}

function statBox(v, k, sub) {
  return `<div class="stat"><div class="v">${v}</div><div class="k">${esc(k)}</div>${
    sub ? `<div class="sub">${esc(sub)}</div>` : ''
  }</div>`;
}

function usageCard(an) {
  const u = an.usage || {};
  if (u.exact) {
    const rows = Object.entries(u.byModel || {})
      .map(
        ([m, d]) => `<tr>
        <td>${esc(m)}</td>
        <td class="num">${fmtNum(d.requests)}</td>
        <td class="num">${fmtTok(d.inputTokens)}</td>
        <td class="num">${fmtTok(d.outputTokens)}</td>
        <td class="num">${fmtTok(d.cacheReadTokens)}</td>
        <td class="num">${d.aiu != null ? fmtNum(d.aiu) : '–'}</td>
      </tr>`
      )
      .join('');
    return `<div class="card"><h3>Token &amp; cost usage <span class="muted">final</span></h3>
      <table class="tbl"><thead><tr><th>Model</th><th class="num">Req</th><th class="num">In</th>
      <th class="num">Out</th><th class="num">Cache rd</th><th class="num">AIU</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="muted" style="margin-top:8px;font-size:12px">
        ${fmtNum(u.totalPremiumRequests)} premium requests · ${fmtNum(u.totalAiu)} AIU total · API time ${fmtDur(
      u.totalApiDurationMs
    )}</div></div>`;
  }
  const rows = Object.entries(u.byModel || {})
    .map(([m, d]) => `<tr><td>${esc(m)}</td><td class="num">${fmtTok(d.outputTokens)}</td></tr>`)
    .join('');
  return `<div class="card"><h3>Token usage <span class="muted">running (live)</span></h3>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Exact totals are finalised at shutdown. Live counters so far:</div>
    <table class="tbl"><thead><tr><th>Model</th><th class="num">Output tokens</th></tr></thead><tbody>${rows ||
      '<tr><td class="muted" colspan="2">no output yet</td></tr>'}</tbody></table>
    <div class="muted" style="margin-top:8px;font-size:12px">${fmtNum(u.assistantTurns)} assistant turns</div></div>`;
}

function toolsCard(an) {
  const t = an.tools || {};
  if (!t.totalCalls) return '';
  const max = Math.max(1, ...(t.topByChars || []).map((x) => x.resultChars));
  const rows = (t.topByChars || [])
    .map(
      (x) => `<tr>
      <td class="bar-cell"><i style="width:${Math.round((x.resultChars / max) * 100)}%"></i><span>${esc(
        x.name
      )}</span></td>
      <td class="num">${fmtNum(x.count)}</td>
      <td class="num">${fmtNum(x.resultChars)}</td>
      <td class="num">${fmtDur(x.durationMs)}</td>
    </tr>`
    )
    .join('');
  return `<div class="card"><h3>Tool usage <span class="muted">${fmtNum(
    t.totalCalls
  )} calls · ${t.failures || 0} failed</span></h3>
    <table class="tbl"><thead><tr><th>Tool (by output volume)</th><th class="num">Calls</th>
    <th class="num">Chars</th><th class="num">Time</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="muted" style="font-size:11.5px;margin-top:8px">Tool output text lands in the context window — large reads are the usual cause of bloat.</div></div>`;
}

function compactionCard(an) {
  if (!an.compactions || !an.compactions.length) return '';
  const items = an.compactions
    .map(
      (c) => `<div class="tl-item">
      <div style="font-weight:600;font-size:13px">Compaction ${c.checkpointNumber || ''} · ${fmtTok(
        c.preTokens
      )} → summary</div>
      <div class="muted" style="font-size:12px">${ago(c.at)} · spent ${fmtTok(
        c.inputTokens
      )} in / ${fmtTok(c.outputTokens)} out · ${fmtDur(c.durationMs)}</div>
    </div>`
    )
    .join('');
  return `<div class="card"><h3>Compaction history <span class="muted">${an.compactions.length}×</span></h3>
    <div class="timeline">${items}</div></div>`;
}

function listCard(title, badge, inner) {
  if (!inner) return '';
  return `<div class="card"><h3>${esc(title)}${badge ? ` <span class="muted">${esc(badge)}</span>` : ''}</h3>${inner}</div>`;
}

function renderDetail(s) {
  if (!s) {
    $('#detail').innerHTML = '<div class="empty">Session not found.</div>';
    return;
  }
  const an = s.analysis || {};
  const ctx = an.context || {};
  const git = s.git || {};
  const liveBadge = an.live
    ? '<span class="badge live">● LIVE</span>'
    : an.endedAt
    ? '<span class="badge ended">ended ' + ago(an.endedAt) + '</span>'
    : '<span class="badge">idle</span>';

  const measured = ctx.exact
    ? 'exact (measured at shutdown)'
    : ctx.source === 'compaction+estimate'
    ? `est. · last measured ${ctx.measuredEventsAgo} events ago`
    : 'estimated (no measurement yet)';

  // git line
  let gitLine = '';
  if (git.available && git.isRepo) {
    gitLine = `<span>⎇ <code>${esc(git.branch || git.head)}</code>${
      git.dirty ? ` · ${git.changedFiles} changed` : ' · clean'
    }${git.ahead ? ` · ↑${git.ahead}` : ''}${git.behind ? ` · ↓${git.behind}` : ''}${
      git.worktrees && git.worktrees.length > 1 ? ` · ${git.worktrees.length} worktrees` : ''
    }</span>`;
  } else if (git.available && !git.isRepo) {
    gitLine = '<span class="muted">not a git repo</span>';
  } else {
    gitLine = '<span class="muted">git n/a</span>';
  }

  const recs = (s.recommendations || [])
    .map(
      (r) => `<div class="rec ${r.level}"><div class="ic">${recIcon(r.level)}</div>
      <div><div class="r-title">${esc(r.title)}</div><div class="r-detail">${esc(r.detail)}</div></div></div>`
    )
    .join('');

  const codeCh = an.codeChanges
    ? `<span style="color:var(--good)">+${fmtNum(an.codeChanges.linesAdded)}</span> / <span style="color:var(--danger)">−${fmtNum(
        an.codeChanges.linesRemoved
      )}</span>`
    : '–';

  const stats =
    `<div class="stats">` +
    statBox(
      (an.compactions?.length || 0) + (ctx.peakMeasured ? '' : ''),
      'compactions',
      ctx.peakMeasured ? 'peak ' + fmtTok(ctx.peakMeasured) : ''
    ) +
    statBox(an.usage?.exact ? fmtNum(an.usage.totalPremiumRequests) : fmtNum(an.usage?.assistantTurns), an.usage?.exact ? 'premium requests' : 'assistant turns') +
    statBox(an.usage?.exact ? fmtNum(an.usage.totalAiu) : '—', 'AIU spent', an.usage?.exact ? '' : 'final at shutdown') +
    statBox(fmtNum(an.tools?.totalCalls), 'tool calls', (an.tools?.failures || 0) + ' failed') +
    statBox(codeCh, 'code changes') +
    statBox(fmtNum(an.turns?.count), 'user turns') +
    statBox(fmtBytes(an.eventsFileSizeBytes), 'events log') +
    statBox(an.live ? ago(an.lastEventAt) : fmtDur(an.idleMs), an.live ? 'last activity' : 'idle for') +
    `</div>`;

  const subagents = (an.subagents || []).length
    ? `<div class="chips">${an.subagents
        .map(
          (a) =>
            `<span class="chip">${esc(a.agentName)} <span class="x">${fmtTok(a.totalTokens)} tok · ${fmtDur(
              a.durationMs
            )}</span></span>`
        )
        .join('')}</div>`
    : '';

  const todos = (s.todos || []).length
    ? s.todos
        .map(
          (t) =>
            `<div class="todo"><span class="st ${t.status}">${esc(t.status)}</span><span>${esc(t.title)}</span></div>`
        )
        .join('')
    : '';

  const checkpoints = (s.checkpoints || []).length
    ? `<div class="chips">${s.checkpoints
        .map((c) => `<span class="chip">▣ ${esc(c.title)}</span>`)
        .join('')}</div>`
    : '';

  const artifacts = (s.artifacts || []).length
    ? `<div class="chips">${s.artifacts
        .map(
          (a) =>
            `<span class="chip" title="${esc(a.name)}">📄 ${esc(a.name)} <span class="x">${fmtBytes(
              a.size
            )}</span></span>`
        )
        .join('')}</div>`
    : '';

  $('#detail').innerHTML = `
    <div class="d-head">
      <div>
        <h1 class="d-title">${esc(s.name || baseName(s.cwd) || 'Session')} ${liveBadge}</h1>
        <div class="d-sub">
          <span class="badge accent">${esc(an.model || '–')}</span>
          ${an.reasoningEffort ? `<span class="badge">effort: ${esc(an.reasoningEffort)}</span>` : ''}
          ${an.contextTier ? `<span class="badge">${esc(an.contextTier)}</span>` : ''}
          <span>id <code data-copy="${esc(s.id)}">${esc(s.id.slice(0, 8))}…</code></span>
          <span>cwd <code data-copy="${esc(s.cwd || '')}">${esc(s.cwd || 'unknown')}</code></span>
          ${gitLine}
          ${an.copilotVersion ? `<span class="muted">CLI ${esc(an.copilotVersion)}</span>` : ''}
          <span class="muted">started ${ago(s.createdAt)}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="resume">▶ Resume</button>
        <button class="btn" data-act="terminal">▣ Terminal</button>
        <button class="btn" data-act="folder">🗁 Folder</button>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card" id="ctx-card">
        <h3>Context window <span class="muted">${esc(measured)}</span></h3>
        <div class="gauge-wrap">
          ${gauge(ctx)}
          <div class="gauge-info">
            <div class="gi-row"><span class="muted">In use</span><b>${fmtNum(ctx.total)} tok</b></div>
            <div class="gi-row"><span class="muted">Window limit</span><span>${fmtNum(ctx.limit)} tok</span></div>
            <div class="gi-row"><span class="muted">Conversation</span><span>${fmtNum(ctx.conversation)} tok</span></div>
            <div class="gi-row"><span class="muted">Peak measured</span><span>${
              ctx.peakMeasured ? fmtNum(ctx.peakMeasured) + ' tok' : '–'
            }</span></div>
            <div class="gi-row"><span class="muted">Calibration</span><span>${
              ctx.calibrated ? ctx.charsPerToken + ' chars/tok' : '~4 chars/tok (default)'
            }</span></div>
          </div>
        </div>
        ${breakdown(ctx)}
      </div>

      <div class="card"><h3>Recommendations</h3>${recs || '<div class="muted">No issues detected.</div>'}</div>
    </div>

    ${stats}

    <div class="grid cols-2">
      ${usageCard(an)}
      ${compactionCard(an) || listCard('Compaction history', '0', '<div class="muted">No compactions yet — context has never overflowed.</div>')}
    </div>

    ${toolsCard(an)}

    ${subagents ? `<div class="section-title">Sub-agents</div>${listCard('Sub-agents', (an.subagents.length) + ' run(s)', subagents)}` : ''}
    ${todos ? `<div class="section-title">Todos</div><div class="card">${todos}</div>` : ''}
    ${checkpoints ? `<div class="section-title">Checkpoints</div>${listCard('Checkpoints', '', checkpoints)}` : ''}
    ${artifacts ? `<div class="section-title">Session files</div>${listCard('Artifacts', '', artifacts)}` : ''}
  `;

  // wire actions
  $('#detail')
    .querySelectorAll('[data-copy]')
    .forEach((el) => el.addEventListener('click', () => copy(el.dataset.copy)));
  $('#detail')
    .querySelectorAll('[data-act]')
    .forEach((el) =>
      el.addEventListener('click', () => {
        const act = el.dataset.act;
        if (act === 'resume') postAction('resume', { id: s.id, cwd: s.cwd });
        else if (act === 'terminal') postAction('terminal', { cwd: s.cwd });
        else if (act === 'folder') postAction('open', { path: s.dir });
      })
    );
}

/* ---------- live SSE ---------- */
let refetchTimer;
function scheduleRefetch() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(async () => {
    await loadSessions();
    const card = $('#ctx-card');
    if (card) card.classList.add('updated-flash');
    setTimeout(() => card && card.classList.remove('updated-flash'), 700);
  }, 350);
}
function connectSSE() {
  const es = new EventSource('/api/stream');
  const conn = $('#conn');
  es.addEventListener('hello', () => {
    conn.classList.add('live');
    conn.querySelector('.conn-text').textContent = 'live';
  });
  es.addEventListener('change', scheduleRefetch);
  es.onerror = () => {
    conn.classList.remove('live');
    conn.querySelector('.conn-text').textContent = 'reconnecting…';
  };
}

/* ---------- settings drawer ---------- */
async function openSettings() {
  const { settings, copilot } = await api('/api/settings');
  state.settings = settings;
  $('#settings-body').innerHTML = `
    <div class="field"><label>Server port</label><input id="set-port" type="number" value="${esc(
      settings.port
    )}"></div>
    <div class="field"><label>Bind host</label>
      <select id="set-host">
        <option value="127.0.0.1" ${settings.host === '127.0.0.1' ? 'selected' : ''}>127.0.0.1 (local only)</option>
        <option value="0.0.0.0" ${settings.host === '0.0.0.0' ? 'selected' : ''}>0.0.0.0 (expose on LAN)</option>
      </select>
      <div class="hint">Use 0.0.0.0 to open the dashboard from your phone on the same Wi-Fi.</div>
    </div>
    <div class="field"><label>Preferred terminal</label>
      <select id="set-term">
        ${['auto', 'pwsh.exe', 'powershell.exe', 'cmd.exe']
          .map((t) => `<option value="${t}" ${settings.terminal === t ? 'selected' : ''}>${t}</option>`)
          .join('')}
      </select>
    </div>
    <div class="field"><label>Path to git.exe (optional)</label>
      <input id="set-git" value="${esc(settings.gitPath || '')}" placeholder="git not on PATH? point here">
      <div class="hint">Leave blank to auto-detect. Enables branch/worktree awareness.</div>
    </div>
    <div class="field"><label>Context window override (tokens)</label>
      <input id="set-ctx" type="number" value="${esc(settings.contextLimitOverride || 0)}">
      <div class="hint">0 = auto by model. Active model: ${esc(copilot.model || '?')} · effort ${esc(
    copilot.effortLevel || '?'
  )}</div>
    </div>
    <button class="btn primary block" id="set-save">Save (restart server to apply host/port)</button>
  `;
  $('#set-save').addEventListener('click', async () => {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        port: Number($('#set-port').value) || 4321,
        host: $('#set-host').value,
        terminal: $('#set-term').value,
        gitPath: $('#set-git').value.trim(),
        contextLimitOverride: Number($('#set-ctx').value) || 0,
      }),
    });
    toast('Settings saved');
    closeSettings();
    loadSessions();
  });
  $('#settings-drawer').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
}
function closeSettings() {
  $('#settings-drawer').classList.add('hidden');
  $('#scrim').classList.add('hidden');
}

/* ---------- new session ---------- */
function newSessionPrompt() {
  const cwd = prompt('Start a new Copilot session in which folder?', state.sessions[0]?.cwd || '');
  if (cwd == null) return;
  postAction('new', { cwd });
}

/* ---------- init ---------- */
$('#btn-refresh').addEventListener('click', loadSessions);
$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#scrim').addEventListener('click', closeSettings);
$('#btn-new').addEventListener('click', newSessionPrompt);

// ?static disables live connections (used for snapshots / headless rendering).
const STATIC = new URLSearchParams(location.search).has('static');
loadSessions();
if (!STATIC) {
  connectSSE();
  setInterval(() => {
    // keep "ago" timers fresh even without events
    if (!document.hidden) loadSessions();
  }, 30000);
}
