// Launch external actions: resume a session, open a plain terminal, reveal
// session files, and open URLs/paths — all on Windows, without a shell-injection
// surface (arguments are passed as argv, ids/paths are validated).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { loadSettings } from './config.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const COMSPEC = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

function terminalExe() {
  const choice = loadSettings().terminal;
  const candidates =
    choice && choice !== 'auto'
      ? [choice]
      : ['pwsh.exe', 'powershell.exe', 'cmd.exe'];
  // We can't easily stat PATH here; pwsh/powershell/cmd are resolved by the OS.
  return candidates[0];
}

function isPwsh(exe) {
  return /pwsh|powershell/i.test(exe);
}

// Open a brand-new visible console window running `command` in `cwd`.
// Uses cmd's `start` so a fresh console is allocated for the interactive TUI.
function startNewConsole(title, cwd, exe, args) {
  const startArgs = ['/c', 'start', `"${title}"`];
  if (cwd && fs.existsSync(cwd)) startArgs.push('/D', cwd);
  startArgs.push(exe, ...args);
  const child = spawn(COMSPEC, startArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return true;
}

// Resume a Copilot session in its own working directory, in a new terminal.
export function resumeSession(id, cwd) {
  if (!UUID_RE.test(id)) throw new Error('invalid session id');
  const exe = terminalExe();
  const dir = cwd && fs.existsSync(cwd) ? cwd : undefined;
  // Build the copilot command; -C makes the cwd explicit even if start /D is ignored.
  const copilotCmd = dir
    ? `copilot -C "${dir}" --resume ${id}`
    : `copilot --resume ${id}`;
  if (isPwsh(exe)) {
    // -NoExit keeps the window open if copilot exits, so output stays visible.
    return startNewConsole(`Seamless · resume ${id.slice(0, 8)}`, dir, exe, [
      '-NoExit',
      '-Command',
      copilotCmd,
    ]);
  }
  // cmd.exe
  return startNewConsole(`Seamless · resume ${id.slice(0, 8)}`, dir, exe, ['/k', copilotCmd]);
}

// Start a fresh Copilot session in a directory (optionally named).
export function newSession(cwd, name) {
  const exe = terminalExe();
  const dir = cwd && fs.existsSync(cwd) ? cwd : undefined;
  const safeName = name && /^[\w .-]{1,60}$/.test(name) ? ` -n "${name}"` : '';
  const copilotCmd = dir ? `copilot -C "${dir}"${safeName}` : `copilot${safeName}`;
  if (isPwsh(exe)) {
    return startNewConsole('Seamless · new session', dir, exe, ['-NoExit', '-Command', copilotCmd]);
  }
  return startNewConsole('Seamless · new session', dir, exe, ['/k', copilotCmd]);
}

// Open a plain terminal (no copilot) at a directory.
export function openTerminal(cwd) {
  const exe = terminalExe();
  const dir = cwd && fs.existsSync(cwd) ? cwd : undefined;
  if (isPwsh(exe)) {
    return startNewConsole('Seamless · terminal', dir, exe, ['-NoLogo']);
  }
  return startNewConsole('Seamless · terminal', dir, exe, []);
}

// Reveal a path in Explorer (folder or file's containing folder).
export function openInExplorer(p) {
  if (!p || !fs.existsSync(p)) throw new Error('path not found');
  const stat = fs.statSync(p);
  const args = stat.isDirectory() ? [p] : ['/select,', p];
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

// Open a URL or path with the OS default handler.
export function openExternal(target) {
  if (!target) throw new Error('empty target');
  const child = spawn(COMSPEC, ['/c', 'start', '""', target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return true;
}
