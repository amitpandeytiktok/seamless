// Turn a session analysis into actionable efficiency recommendations.
import { THRESHOLDS } from './config.js';
import { formatTokens, formatNumber } from './util.js';

const LEVEL_RANK = { danger: 0, warn: 1, info: 2, good: 3 };

export function recommend(analysis, git) {
  const recs = [];
  if (!analysis) return recs;
  const ctx = analysis.context;
  const add = (level, title, detail, action) => recs.push({ level, title, detail, action });

  // --- Context fullness ---
  if (ctx) {
    const f = ctx.fraction;
    const pctStr = Math.round(f * 100) + '%';
    if (f >= THRESHOLDS.danger) {
      add(
        'danger',
        `Context window ~${pctStr} full`,
        `Roughly ${formatTokens(ctx.total)} of ~${formatTokens(ctx.limit)} tokens are in play${
          ctx.exact ? '' : ' (estimated)'
        }. Responses get slower and pricier near the limit and a compaction is imminent. Run /compact to summarise now, or start a fresh session for the next task.`,
        'compact'
      );
    } else if (f >= THRESHOLDS.warn) {
      add(
        'warn',
        `Context window ~${pctStr} full`,
        `About ${formatTokens(ctx.total)} of ~${formatTokens(
          ctx.limit
        )} tokens used. Consider wrapping up the current thread or running /compact before it auto-compacts.`,
        'compact'
      );
    } else {
      add('good', `Context healthy (~${pctStr})`, `~${formatTokens(ctx.total)} of ~${formatTokens(ctx.limit)} tokens in use. Plenty of headroom.`);
    }

    // Conversation dominates fixed costs?
    if (ctx.conversation && ctx.total) {
      const convFrac = ctx.conversation / ctx.total;
      if (convFrac > 0.6 && ctx.total > 60_000) {
        add(
          'info',
          'Conversation history is the bulk of the context',
          `The running conversation is ~${formatTokens(ctx.conversation)} tokens (${Math.round(
            convFrac * 100
          )}% of context). System prompt + tool definitions are a fixed ~${formatTokens(
            (ctx.system || 0) + (ctx.toolDefinitions || 0)
          )}. Compacting or starting fresh reclaims the conversation portion.`
        );
      }
    }

    // Dense (image/reasoning-heavy) context.
    if (ctx.calibrated && ctx.charsPerToken && ctx.charsPerToken < 2.2) {
      add(
        'info',
        'Token-dense session (images or heavy reasoning)',
        `This session averages ~${ctx.charsPerToken} characters per token — far below the ~4 of plain text. Images/screenshots and long model reasoning consume tokens without much visible text, so the context fills faster than the transcript suggests.`
      );
    }
  }

  // --- Compaction history ---
  const nC = analysis.compactions?.length || 0;
  if (nC >= 2) {
    add(
      'warn',
      `Auto-compacted ${nC} times`,
      `The context window has filled and been summarised ${nC} times this session. Each compaction loses fine detail and spends tokens. This is a long, heavy session — for an unrelated task, a fresh session will be faster and cheaper.`,
      'newSession'
    );
  } else if (nC === 1) {
    add('info', 'Compacted once', 'Context filled and was summarised once. Normal for a long session; keep an eye on it.');
  }

  // --- Large tool outputs bloating context ---
  const top = analysis.tools?.topByChars?.[0];
  if (top && top.resultChars > 150_000) {
    add(
      'info',
      `Large tool outputs from "${top.name}"`,
      `"${top.name}" has returned ~${formatNumber(
        top.resultChars
      )} characters across ${top.count} calls — that text lands in the context. Prefer targeted reads (view_range, grep, Select-Object -First, | head) over dumping whole files or directories.`
    );
  }
  const totalCalls = analysis.tools?.totalCalls || 0;
  if (totalCalls > 400) {
    add(
      'info',
      `${formatNumber(totalCalls)} tool calls so far`,
      'A very high number of tool calls usually means lots of intermediate output accumulating in context. Batch independent reads and keep outputs small.'
    );
  }
  if (analysis.tools?.failures > 8) {
    add(
      'info',
      `${analysis.tools.failures} tool failures`,
      'Repeated failing tool calls waste turns and add error output to the context. Worth checking the failing commands.'
    );
  }

  // --- Subagents (good for offloading context) ---
  const subTokens = (analysis.subagents || []).reduce((s, x) => s + (x.totalTokens || 0), 0);
  if (analysis.subagents?.length) {
    add(
      'good',
      `${analysis.subagents.length} sub-agent run(s) offloaded ~${formatTokens(subTokens)} tokens`,
      'Sub-agents do work in a separate context window, keeping this one lean. Keep using them for big research/exploration tasks.'
    );
  }

  // --- Effort vs size ---
  if (analysis.reasoningEffort === 'max' && ctx && ctx.fraction > 0.5) {
    add(
      'info',
      'Max reasoning effort on a large context',
      'You are on max effort with a sizeable context — great for hard problems, but slower and more expensive per turn. Drop to a lower effort for routine edits to speed things up.'
    );
  }

  // --- Git hygiene (only when meaningful) ---
  if (git?.isRepo) {
    if (git.dirty) {
      add('info', `${git.changedFiles} uncommitted change(s) on ${git.branch || 'HEAD'}`, 'Commit or stash to checkpoint your work before long operations.');
    }
    if (git.worktrees && git.worktrees.length > 1) {
      add('good', `${git.worktrees.length} worktrees detected`, 'Seamless is tracking each worktree/branch for this repo.');
    }
  }

  // --- Estimate disclaimer ---
  if (ctx && !ctx.exact) {
    add(
      'info',
      'Live context size is estimated',
      `Exact token counts are only emitted at compactions/shutdown. The headline number is the last measured value (${
        ctx.measuredEventsAgo != null ? ctx.measuredEventsAgo + ' events ago' : 'baseline'
      }) plus a per-session calibrated estimate of new activity.`
    );
  }

  recs.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  return recs;
}
