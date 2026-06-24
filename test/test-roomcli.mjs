// Hermetic Room CLI tests — no network, no LLM, isolated data dir. Validates the room
// model, on-disk knowledge, PIN auth, prompt assembly, and backfill distillation.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Isolate all state under a temp dir BEFORE importing modules (they read SEAMLESS_DIR at load).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roomcli-test-'));
process.env.SEAMLESS_DIR = TMP;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}

const roomstore = await import('../src/core/roomstore.js');
const knowledge = await import('../src/core/knowledge.js');
const auth = await import('../src/core/auth.js');
const engine = await import('../src/core/engine.js');
const backfill = await import('../src/core/backfill.js');

console.log('=== roomstore ===');
const data = roomstore.loadRooms();
ok(data.rooms.length >= 4, 'default rooms seeded');
const tree = roomstore.roomTree();
const tw = tree.find((r) => r.id === 'workspace');
ok(tw && tw.children.length === 1, 'workspace group has a child room');
ok(roomstore.expandHome('~') === os.homedir(), 'expandHome(~) -> home');
ok(roomstore.expandHome('~/x') === path.join(os.homedir(), 'x'), 'expandHome(~/x)');
const made = roomstore.createRoom({ name: 'Temp Room', parentId: 'workspace', cwd: '~/nope-xyz', permission: 'chat' });
ok(made.id && roomstore.getRoom(made.id), 'createRoom');
ok(roomstore.resolveCwd(made) === os.homedir(), 'resolveCwd falls back to home for missing dir');
const upd = roomstore.updateRoom(made.id, { permission: 'agent', name: 'Renamed' });
ok(upd.permission === 'agent' && upd.name === 'Renamed', 'updateRoom');
ok(roomstore.deleteRoom(made.id) === true && !roomstore.getRoom(made.id), 'deleteRoom');

console.log('=== knowledge ===');
const room = roomstore.getRoom('ops');
knowledge.ensureSeed(room);
const mem0 = knowledge.readMemory('ops');
ok(mem0.overview && Array.isArray(mem0.durable), 'ensureSeed wrote overview');
const block = knowledge.buildContextBlock(room);
ok(block.includes('OVERVIEW'), 'context block has sections');
ok(block.length <= knowledge.CONTEXT_BUDGET + 80, 'context block within budget');
knowledge.recordTurn(room, {
  prompt: 'do a thing', response: 'did the thing', memory: ['Durable X happened'],
  sessionId: 'sess-1', usage: { premiumRequests: 3 },
});
const mem1 = knowledge.readMemory('ops');
ok(mem1.recent.length === 1 && mem1.recent[0].summary.includes('do a thing'), 'recordTurn -> recent');
ok(mem1.durable.some((d) => d.text === 'Durable X happened'), 'recordTurn -> durable from MEMORY');
ok(mem1.stats.turns === 1 && mem1.stats.premiumRequests === 3, 'recordTurn -> stats');
ok(knowledge.readLog('ops').length === 1, 'log appended');
const memAdd = knowledge.addDurable('ops', 'Manual fact');
ok(memAdd.durable.some((d) => d.text === 'Manual fact'), 'addDurable');
const idx = memAdd.durable.findIndex((d) => d.text === 'Manual fact');
ok(!knowledge.removeDurable('ops', idx).durable.some((d) => d.text === 'Manual fact'), 'removeDurable');
ok(fs.existsSync(path.join(TMP, 'rooms', 'ops', 'CONTEXT.md')), 'CONTEXT.md rendered');

console.log('=== auth ===');
const slug = auth.getSlug();
ok(slug && slug.length >= 10 && auth.getSlug() === slug, 'slug stable');
ok(!auth.hasPin(), 'no pin initially');
ok(auth.setPin('4729') === true, 'setPin first time');
ok(auth.setPin('9999') === false, 'setPin refuses overwrite');
ok(auth.verifyPin('4729') && !auth.verifyPin('0000'), 'verifyPin');
const tok = auth.login('4729');
ok(tok && auth.checkToken(tok), 'login + checkToken');
ok(!auth.checkToken('garbage'), 'bad token rejected');
auth.logout(tok);
ok(!auth.checkToken(tok), 'logout invalidates token');
let threw = false;
try { auth.setPin('1'); } catch { threw = true; }
ok(threw, 'setPin rejects too-short on fresh state'); // note: pin already set, but length check first

console.log('=== engine.buildPrompt ===');
const prompt = engine.buildPrompt(room, 'Deploy the site');
ok(prompt.includes(room.name), 'prompt names the room');
ok(prompt.includes('ROOM KNOWLEDGE') && prompt.includes('NEW REQUEST') && prompt.includes('Deploy the site'), 'prompt structure');
ok(prompt.includes('MEMORY:'), 'prompt asks for MEMORY self-curation');
ok(prompt.length <= 26000, 'prompt within Windows arg budget');
const big = engine.buildPrompt(room, 'x'.repeat(40000));
ok(big.includes('x'.repeat(1000)), 'huge user request preserved (context shrinks instead)');

console.log('=== backfill (hermetic sqlite, generic cwd matching) ===');
// A room whose working directory name is "billing-svc" should claim sessions run there —
// no hardcoded project list; matching is driven purely by the room's own config.
const proj = roomstore.createRoom({ name: 'Billing Service', parentId: null, cwd: '~/billing-svc', permission: 'agent' });
const dbPath = path.join(TMP, 'fake-store.db');
const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
         CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, user_message TEXT, assistant_response TEXT, timestamp TEXT);
         CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, session_id TEXT, checkpoint_number INTEGER, title TEXT, overview TEXT, history TEXT, work_done TEXT, technical_details TEXT, important_files TEXT, next_steps TEXT, created_at TEXT);`);
db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)`).run('s1', '/home/u/billing-svc', 'me/billing-svc', 'github', 'main', 'Wire up billing', '2026-06-01', '2026-06-02');
db.prepare(`INSERT INTO turns VALUES (?,?,?,?,?,?)`).run(1, 's1', 0, 'q', 'a', '2026-06-01');
db.prepare(`INSERT INTO turns VALUES (?,?,?,?,?,?)`).run(2, 's1', 1, 'q2', 'a2', '2026-06-01');
db.prepare(`INSERT INTO checkpoints (id,session_id,checkpoint_number,title,overview,next_steps) VALUES (?,?,?,?,?,?)`)
  .run(1, 's1', 1, 'Payments wired', 'Added subscription billing with webhook verify.', 'Enable enforcement');
// Add 30 identical-summary sessions to prove summary-frequency automation filtering.
const ins = db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)`);
for (let i = 0; i < 30; i++) ins.run('auto' + i, '/home/u/cron', 'me/cron', 'github', 'main', 'nightly job run', '2026-06-01', '2026-06-01');
db.close();

const report = backfill.runBackfill({ dbPath });
ok(report.totalSessions === 1, 'backfill kept 1 interactive session (filtered 30 automation)');
ok(report.automation === 30, 'backfill detected repeated-summary automation');
const csMem = knowledge.readMemory(proj.id);
ok(csMem.durable.some((d) => /Payments wired/.test(d.text)), 'backfill distilled checkpoint -> durable (generic cwd match)');
ok(csMem.stats.backfilledSessions === 1, 'backfill recorded session count');

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
