// Parse a session's events.jsonl into a rich, live "internal CLI state" snapshot:
// context-window size + breakdown, compaction history, token/AIU usage, tool stats,
// subagents, activity and liveness. Results are memoised by file mtime+size.
import fs from 'node:fs';
import path from 'node:path';
import { parseSimpleYaml, safeJsonParse, estimateTokens } from './util.js';
import {
  contextLimitFor,
  BASELINE_SYSTEM_TOKENS,
  BASELINE_TOOLDEF_TOKENS,
} from './config.js';

// Consider a session "live" if it has no shutdown event and was active recently.
export const LIVE_WINDOW_MS = 90_000;

const cache = new Map(); // sessionDir -> { mtimeMs, size, analysis }

// Characters that count toward the conversation context for calibration/estimation.
function conversationChars(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'user.message':
      return (d.content || '').length;
    case 'assistant.message':
      return (d.content || '').length + (d.reasoningText || '').length;
    case 'tool.execution_start':
      return d.arguments ? JSON.stringify(d.arguments).length : 0;
    case 'tool.execution_complete': {
      const r = d.result;
      if (typeof r === 'string') return r.length;
      if (r && typeof r === 'object') return r.content ? String(r.content).length : 0;
      return 0;
    }
    default:
      return 0;
  }
}

function resultContentLength(d) {
  const r = d.result;
  if (typeof r === 'string') return r.length;
  if (r && typeof r === 'object') {
    let n = r.content ? String(r.content).length : 0;
    if (r.detailedContent) n = Math.max(n, String(r.detailedContent).length);
    return n;
  }
  return 0;
}

export function analyzeEvents(events, { id, workspace } = {}) {
  const a = {
    id,
    model: null,
    reasoningEffort: null,
    copilotVersion: null,
    contextTier: null,
    cwdFromStart: null,
    eventCount: events.length,
    firstEventAt: null,
    lastEventAt: null,
    lastEventType: null,
    live: false,
    endedAt: null,
    shutdownType: null,
    compactions: [],
    subagents: [],
    tools: { totalCalls: 0, byName: {}, failures: 0 },
    turns: { count: 0, lastUserMessage: null, lastUserAt: null },
    usage: null,
    codeChanges: null,
    eventsFileSizeBytes: null,
  };

  // Running conversation accounting for calibration + live estimate.
  let convChars = 0;
  const ratioSamples = [];
  const openTools = new Map(); // toolCallId -> {name, startedAt, argChars}
  let outputTokensByModel = {};
  let assistantTurns = 0;
  let shutdown = null;
  let lastCompactionSnapshot = null; // {system, conversation, tool, at, eventIndex}

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const d = ev.data || {};
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : null;
    if (ts) {
      if (a.firstEventAt == null) a.firstEventAt = ts;
      a.lastEventAt = ts;
    }
    a.lastEventType = ev.type;

    convChars += conversationChars(ev);

    switch (ev.type) {
      case 'session.start':
        a.copilotVersion = d.copilotVersion || a.copilotVersion;
        a.contextTier = d.contextTier ?? a.contextTier;
        a.cwdFromStart = d.context?.cwd || a.cwdFromStart;
        break;
      case 'session.model_change':
        if (d.newModel) a.model = d.newModel;
        if (d.reasoningEffort) a.reasoningEffort = d.reasoningEffort;
        break;
      case 'user.message':
        a.turns.count++;
        a.turns.lastUserMessage = (d.content || '').slice(0, 300);
        a.turns.lastUserAt = ts;
        break;
      case 'assistant.message': {
        assistantTurns++;
        if (d.model) a.model = d.model;
        const ot = Number(d.outputTokens) || 0;
        const m = d.model || a.model || 'unknown';
        outputTokensByModel[m] = (outputTokensByModel[m] || 0) + ot;
        break;
      }
      case 'tool.execution_start':
        openTools.set(d.toolCallId, {
          name: d.toolName || 'unknown',
          startedAt: ts,
          argChars: d.arguments ? JSON.stringify(d.arguments).length : 0,
        });
        break;
      case 'tool.execution_complete': {
        a.tools.totalCalls++;
        const start = openTools.get(d.toolCallId);
        const name = start?.name || 'unknown';
        const rec = (a.tools.byName[name] ||= {
          count: 0,
          resultChars: 0,
          durationMs: 0,
          failures: 0,
        });
        rec.count++;
        rec.resultChars += resultContentLength(d);
        if (start?.startedAt && ts) rec.durationMs += Math.max(0, ts - start.startedAt);
        if (d.success === false) {
          rec.failures++;
          a.tools.failures++;
        }
        openTools.delete(d.toolCallId);
        break;
      }
      case 'session.compaction_start':
        lastCompactionSnapshot = {
          system: d.systemTokens,
          conversation: d.conversationTokens,
          tool: d.toolDefinitionsTokens,
          total: (d.systemTokens || 0) + (d.conversationTokens || 0) + (d.toolDefinitionsTokens || 0),
          at: ts,
          eventIndex: i,
        };
        if (convChars > 0 && d.conversationTokens > 0) {
          ratioSamples.push(convChars / d.conversationTokens);
        }
        break;
      case 'session.compaction_complete': {
        const used = d.compactionTokensUsed || {};
        a.compactions.push({
          at: ts,
          preTokens: d.preCompactionTokens || null,
          messagesLength: d.preCompactionMessagesLength || null,
          checkpointNumber: d.checkpointNumber || null,
          checkpointPath: d.checkpointPath || null,
          system: lastCompactionSnapshot?.system ?? null,
          conversation: lastCompactionSnapshot?.conversation ?? null,
          toolDefinitions: lastCompactionSnapshot?.tool ?? null,
          inputTokens: used.inputTokens ?? null,
          outputTokens: used.outputTokens ?? null,
          cacheReadTokens: used.cacheReadTokens ?? null,
          durationMs: used.duration ?? null,
        });
        // Conversation is replaced by the summary; reset the running counter to it.
        convChars = (d.summaryContent || '').length;
        break;
      }
      case 'subagent.completed':
        a.subagents.push({
          agentName: d.agentDisplayName || d.agentName || 'agent',
          model: d.model || null,
          totalTokens: d.totalTokens || 0,
          totalToolCalls: d.totalToolCalls || 0,
          durationMs: d.durationMs || 0,
        });
        break;
      case 'session.shutdown':
        shutdown = d;
        a.endedAt = ts;
        a.shutdownType = d.shutdownType || 'unknown';
        break;
      default:
        break;
    }
  }

  // --- Calibration ratio (characters per token) ---
  const charsPerToken =
    ratioSamples.length > 0
      ? ratioSamples.reduce((s, r) => s + r, 0) / ratioSamples.length
      : 4;
  const calibrated = ratioSamples.length > 0;

  // --- Context window state ---
  const limit = contextLimitFor(a.model, a.contextTier);
  let system, toolDefinitions, measuredAt, measuredEventsAgo, source, conversation, total;

  if (shutdown) {
    // Exact final snapshot.
    system = shutdown.systemTokens;
    toolDefinitions = shutdown.toolDefinitionsTokens;
    conversation = shutdown.conversationTokens;
    total = shutdown.currentTokens ?? system + toolDefinitions + conversation;
    measuredAt = a.endedAt;
    measuredEventsAgo = 0;
    source = 'shutdown';
  } else if (lastCompactionSnapshot) {
    // System + tool definitions are stable; conversation is re-estimated live.
    system = lastCompactionSnapshot.system;
    toolDefinitions = lastCompactionSnapshot.tool;
    conversation = estimateTokens(convChars, charsPerToken);
    total = system + toolDefinitions + conversation;
    measuredAt = lastCompactionSnapshot.at;
    measuredEventsAgo = events.length - 1 - lastCompactionSnapshot.eventIndex;
    source = 'compaction+estimate';
  } else {
    // No exact measurement yet; baseline the fixed costs and estimate conversation.
    system = BASELINE_SYSTEM_TOKENS;
    toolDefinitions = BASELINE_TOOLDEF_TOKENS;
    conversation = estimateTokens(convChars, charsPerToken);
    total = system + toolDefinitions + conversation;
    measuredAt = null;
    measuredEventsAgo = null;
    source = 'baseline+estimate';
  }

  a.context = {
    limit,
    system,
    toolDefinitions,
    conversation,
    total,
    fraction: limit ? Math.min(total / limit, 1) : 0,
    charsPerToken: Number(charsPerToken.toFixed(2)),
    calibrated,
    source,
    measuredAt,
    measuredEventsAgo,
    exact: !!shutdown,
    peakMeasured: a.compactions.reduce(
      (mx, c) => Math.max(mx, c.preTokens || 0),
      lastCompactionSnapshot?.total || 0
    ),
  };

  // --- Usage / cost ---
  if (shutdown) {
    const byModel = {};
    for (const [model, mm] of Object.entries(shutdown.modelMetrics || {})) {
      byModel[model] = {
        requests: mm.requests?.count ?? null,
        premium: mm.requests?.cost ?? null,
        inputTokens: mm.usage?.inputTokens ?? null,
        outputTokens: mm.usage?.outputTokens ?? null,
        cacheReadTokens: mm.usage?.cacheReadTokens ?? null,
        cacheWriteTokens: mm.usage?.cacheWriteTokens ?? null,
        reasoningTokens: mm.usage?.reasoningTokens ?? null,
        aiu: mm.totalNanoAiu != null ? mm.totalNanoAiu / 1e9 : null,
      };
    }
    a.usage = {
      exact: true,
      totalPremiumRequests: shutdown.totalPremiumRequests ?? null,
      totalAiu: shutdown.totalNanoAiu != null ? shutdown.totalNanoAiu / 1e9 : null,
      totalApiDurationMs: shutdown.totalApiDurationMs ?? null,
      byModel,
    };
    a.codeChanges = shutdown.codeChanges || null;
    a.eventsFileSizeBytes = shutdown.eventsFileSizeBytes ?? null;
  } else {
    const byModel = {};
    for (const [model, ot] of Object.entries(outputTokensByModel)) {
      byModel[model] = { outputTokens: ot, requests: null };
    }
    a.usage = {
      exact: false,
      totalPremiumRequests: null,
      totalAiu: null,
      assistantTurns,
      byModel,
    };
  }

  // --- Liveness ---
  const now = Date.now();
  a.idleMs = a.lastEventAt ? now - a.lastEventAt : null;
  a.live = !shutdown && a.idleMs != null && a.idleMs < LIVE_WINDOW_MS;
  a.recentlyActive = !shutdown && a.idleMs != null && a.idleMs < 30 * 60 * 1000;

  // Derived tool rankings.
  a.tools.topByChars = Object.entries(a.tools.byName)
    .map(([name, r]) => ({ name, ...r }))
    .sort((x, y) => y.resultChars - x.resultChars)
    .slice(0, 8);
  a.tools.topByCount = Object.entries(a.tools.byName)
    .map(([name, r]) => ({ name, ...r }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 8);

  if (workspace) {
    a.name = workspace.name;
    a.clientName = workspace.client_name;
    a.cwd = workspace.cwd || a.cwdFromStart;
  } else {
    a.cwd = a.cwdFromStart;
  }

  return a;
}

// Read + parse a session's events.jsonl (whole file) with mtime/size memoisation.
export function readSessionEvents(sessionDir) {
  const file = path.join(sessionDir, 'events.jsonl');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { events: [], stat: null };
  }
  const events = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const o = safeJsonParse(line);
    if (o) events.push(o);
  }
  return { events, stat };
}

export function analyzeSession(sessionDir, id) {
  const file = path.join(sessionDir, 'events.jsonl');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = cache.get(sessionDir);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.analysis;
  }
  let workspace = null;
  try {
    workspace = parseSimpleYaml(fs.readFileSync(path.join(sessionDir, 'workspace.yaml'), 'utf8'));
  } catch {
    /* no workspace.yaml */
  }
  const { events } = readSessionEvents(sessionDir);
  const analysis = analyzeEvents(events, { id: id || workspace?.id, workspace });
  if (analysis.eventsFileSizeBytes == null) analysis.eventsFileSizeBytes = stat.size;
  cache.set(sessionDir, { mtimeMs: stat.mtimeMs, size: stat.size, analysis });
  return analysis;
}
