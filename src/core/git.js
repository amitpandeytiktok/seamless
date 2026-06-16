// Git / branch / worktree awareness. Degrades gracefully when git is missing
// (it is not always on PATH on these boxes) or when cwd is not a repository.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadSettings } from './config.js';

let resolvedGit; // cache: string | null | undefined(=unresolved)

const COMMON_GIT_PATHS = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
];

export function resolveGit() {
  if (resolvedGit !== undefined) return resolvedGit;
  const configured = loadSettings().gitPath;
  if (configured && fs.existsSync(configured)) {
    resolvedGit = configured;
    return resolvedGit;
  }
  // Try PATH.
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 4000 });
  if (!probe.error && probe.status === 0) {
    resolvedGit = 'git';
    return resolvedGit;
  }
  for (const p of COMMON_GIT_PATHS) {
    if (p && fs.existsSync(p)) {
      resolvedGit = p;
      return resolvedGit;
    }
  }
  resolvedGit = null;
  return resolvedGit;
}

function git(cwd, args) {
  const exe = resolveGit();
  if (!exe) return { ok: false, out: '', code: -1 };
  const r = spawnSync(exe, ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
  if (r.error || r.status !== 0) return { ok: false, out: (r.stdout || '') + (r.stderr || ''), code: r.status };
  return { ok: true, out: (r.stdout || '').trim(), code: 0 };
}

function parseWorktrees(porcelain) {
  const list = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null, head: null, bare: false, detached: false };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim().slice(0, 8);
    } else if (line.trim() === 'bare') {
      cur.bare = true;
    } else if (line.trim() === 'detached') {
      cur.detached = true;
    }
  }
  if (cur) list.push(cur);
  return list;
}

export function gitInfo(cwd) {
  const exe = resolveGit();
  if (!exe) return { available: false, reason: 'git-not-found' };
  if (!cwd || !fs.existsSync(cwd)) return { available: true, isRepo: false, reason: 'cwd-missing', cwd };

  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return { available: true, isRepo: false, cwd };
  }

  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']);
  const status = git(cwd, ['status', '--porcelain']);
  const worktrees = git(cwd, ['worktree', 'list', '--porcelain']);
  const upstream = git(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);

  const dirtyLines = status.ok ? status.out.split('\n').filter((l) => l.trim()) : [];
  let ahead = null;
  let behind = null;
  if (upstream.ok && upstream.out) {
    const m = upstream.out.split(/\s+/);
    if (m.length === 2) {
      behind = Number(m[0]);
      ahead = Number(m[1]);
    }
  }

  return {
    available: true,
    isRepo: true,
    cwd,
    root: root.ok ? root.out : null,
    branch: branch.ok ? branch.out : null,
    head: head.ok ? head.out : null,
    detached: branch.ok && branch.out === 'HEAD',
    dirty: dirtyLines.length > 0,
    changedFiles: dirtyLines.length,
    ahead,
    behind,
    worktrees: worktrees.ok ? parseWorktrees(worktrees.out) : [],
  };
}
