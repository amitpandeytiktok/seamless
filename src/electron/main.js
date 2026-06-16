// Seamless Electron shell. Boots the local server in-process and presents the
// live dashboard in a native window, with a tray icon and a menu. Action buttons
// in the dashboard hit the same local API, so the renderer stays a plain web app.
import { app, BrowserWindow, Tray, Menu, shell, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/server.js';
import { loadSettings } from '../core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// This app only ever talks to its own localhost server; never route that via a
// system proxy (which on locked-down machines can black-hole 127.0.0.1).
app.commandLine.appendSwitch('no-proxy-server');

let win = null;
let tray = null;
let serverInfo = null;
let baseUrl = '';

function startServer() {
  const settings = loadSettings();
  const { server } = createServer();
  return new Promise((resolve) => {
    // Always bind locally for the embedded window; honour LAN exposure too.
    const host = settings.host || '127.0.0.1';
    server.listen(settings.port, host, () => {
      const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      baseUrl = `http://${shownHost}:${settings.port}`;
      serverInfo = { server, host, port: settings.port };
      resolve();
    });
    server.on('error', () => {
      // Port busy (maybe a standalone server is already running) — just load it.
      baseUrl = `http://127.0.0.1:${settings.port}`;
      resolve();
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0e14',
    title: 'Seamless',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(baseUrl);
  win.on('closed', () => {
    win = null;
  });
  // Open external links in the system browser, keep app links internal.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Seamless',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        {
          label: 'Open dashboard in browser',
          click: () => shell.openExternal(baseUrl),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  if (!fs.existsSync(ICON)) return;
  const img = nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip('Seamless — Copilot session control room');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Seamless',
      click: () => {
        if (!win) createWindow();
        else {
          win.show();
          win.focus();
        }
      },
    },
    { label: 'Open in browser', click: () => shell.openExternal(baseUrl) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (!win) createWindow();
    else win.isVisible() ? win.focus() : win.show();
  });
}

// Minimal IPC: let the renderer ask the shell to open links/paths natively.
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('show-item', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('get-base-url', () => baseUrl);

app.whenReady().then(async () => {
  await startServer();
  buildMenu();
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in the tray (matches a "control room" that watches sessions).
  // Quit explicitly via tray/menu.
});
