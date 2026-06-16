import { listSessions, getSession } from '../src/core/sessions.js';
import { gitInfo } from '../src/core/git.js';
import { recommend } from '../src/core/analyze.js';

console.log('=== listSessions ===');
const list = listSessions();
for (const s of list) {
  console.log(
    `${s.live ? 'LIVE ' : s.ended ? 'ended' : '     '} ${s.id.slice(0, 8)} | ${(s.name || '').slice(0, 26).padEnd(26)} | model=${s.model} | ctx=${s.context ? s.context.total + '/' + s.context.limit + ' (' + Math.round((s.context.fraction || 0) * 100) + '%)' : 'n/a'} | comp=${s.compactionCount} | ev=${s.eventCount}`
  );
}

const endedId = '2b06c08f-dd9e-4c56-8336-7ae755d3b744';
console.log('\n=== detail: ended session 2b06c08f (expect exact currentTokens=54795) ===');
const d = getSession(endedId);
console.log('context:', JSON.stringify(d.analysis.context, null, 2));
console.log('usage:', JSON.stringify(d.analysis.usage, null, 2));
console.log('compactions preTokens:', d.analysis.compactions.map((c) => c.preTokens));
console.log('codeChanges:', JSON.stringify(d.analysis.codeChanges));
console.log('tools.totalCalls:', d.analysis.tools.totalCalls, 'topByChars:', d.analysis.tools.topByChars.slice(0, 3).map((t) => t.name + ':' + t.resultChars));
console.log('subagents:', d.analysis.subagents.length);

console.log('\n=== detail: current live session ===');
const live = list.find((s) => s.live) || list[0];
const dl = getSession(live.id);
console.log('id', live.id.slice(0, 8), 'live=', dl.analysis.live, 'idleMs=', dl.analysis.idleMs, 'events=', dl.analysis.eventCount);
console.log('context:', JSON.stringify(dl.analysis.context, null, 2));
const g = gitInfo(dl.cwd);
console.log('git:', JSON.stringify(g));
console.log('recommendations:');
for (const r of recommend(dl.analysis, g)) console.log(`  [${r.level}] ${r.title}`);
